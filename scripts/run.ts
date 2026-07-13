#!/usr/bin/env bun
// @ts-nocheck
// scripts/run.ts — forgeax-studio zero-build dev orchestrator (cross-platform).
//
// Replaces run.sh + run.bat with one Bun implementation. Boot order:
//   server (:18900) → interface (:18920, serves the editor engine in-process) + engine (:15173, play/preview)
//   [+ wb-narrative (:8900) if a key is configured] [+ standalone plugins].
// Each service runs from its source submodule's node_modules — no build step;
// edits hot-reload (vite HMR / bun --watch).
//
// The bash version carried a large Windows/MSYS shim (PATH propagation,
// cygpath, MSYS=winsymlinks). Running natively under Bun none of that is
// needed: fs.symlinkSync(...,'junction') and child.pid work directly. The only
// real platform forks left live in lib/proc.ts (kill / port discovery).

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './lib/env.ts';
import {
  PORT_ENGINE,
  PORT_GATEWAY_BRIDGE,
  PORT_INTERFACE,
  PORT_NARRATIVE,
  PORT_SERVER,
} from './lib/ports.ts';
import {
  type SpawnOpts,
  clearPidfiles,
  isPortBusy,
  killTree,
  recordPid,
  reapPidfiles,
  runDir,
  sleep,
  spawnService,
  waitForPort,
} from './lib/proc.ts';
import { StartLock } from './lib/startlock.ts';
import { vanityBanner, versionCheck, versionString, writeVersionJson } from './lib/version.ts';
import { viteGuard, vitePurgeAll } from './lib/vite-cache.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);

// ── 0 purge-vite / start lock ───────────────────────────────────────────────
if (has('--purge-vite') || has('--fresh')) {
  vitePurgeAll(ROOT);
  console.log('[run] vite caches purged (--purge-vite/--fresh)');
}

const lock = new StartLock(ROOT);
lock.acquire();

// STUDIO routing default — :18920 vite serves packages/studio when STUDIO=1.
const STUDIO = process.env.STUDIO ?? '1';
process.env.STUDIO = STUDIO;

// ── 0 version banner + write ─────────────────────────────────────────────────
console.log(vanityBanner(ROOT));
process.env.FORGEAX_VERSION = versionString(ROOT);
try {
  writeVersionJson(ROOT, join(ROOT, 'packages/server/dist/version.json'));
} catch {
  // dist may not exist yet — server writes its own at build; non-fatal
}
versionCheck(ROOT);

console.log();
console.log('  ⚠ BREAKING CHANGE: Preview 运行时引擎已从 Three.js 切换到 forgeax-engine ECS。');
console.log('  存量 THREE.js 游戏代码合并后将无法运行，需按新 scaffold 重写为 ECS 范式。');
console.log();

// ── 1 .env ───────────────────────────────────────────────────────────────────
const envFile = join(ROOT, '.env');
const envExample = join(ROOT, '.env.example');
if (!existsSync(envFile)) {
  const legacy = join(ROOT, 'packages/forgeax/.env');
  if (existsSync(legacy)) {
    copyFileSync(legacy, envFile);
    console.log(`  Migrated packages/forgeax/.env -> ${envFile}.`);
  } else if (existsSync(envExample)) {
    copyFileSync(envExample, envFile);
    console.log(`\n  Created ${envFile} from ${envExample}.`);
    console.log('  Edit it to set ANTHROPIC_API_KEY=sk-ant-... then run again.\n');
    process.exit(1);
  } else {
    console.error(`  ERROR: no .env at ${envFile} and no .env.example to seed from.`);
    process.exit(1);
  }
}
const env = loadDotenv(envFile); // also injected into process.env
// Anchor the credentials file for /api/settings. It's INSTALL-GLOBAL: the
// server loaded these creds into process.env once, here; a workspace hot-switch
// only remaps FORGEAX_PROJECT_ROOT, so Settings must keep reading/writing THIS
// file (not <active-root>/.env) or creds/FORGEAX_MODEL appear to vanish after a
// switch. Inherited by every launched child via `...process.env` below.
process.env.FORGEAX_ENV_FILE = envFile;

// ── LLM egress capture proxy (opt-in) ─────────────────────────────────────────
// FORGEAX_DEBUG_PROXY routes EVERY kernel's model traffic through a local capture
// proxy (whistle) so requests/responses can be inspected. It works kernel-agnostic
// because both egress shapes are covered by process.env inheritance:
//   · forgeax-core (default) & external CLIs run as children of this process and
//     inherit HTTPS_PROXY + NODE_EXTRA_CA_CERTS (scrubbedSecretEnv keeps proxy vars).
//   · the in-process loopback cred proxies (agent-host cred-vault / cli cred-proxy)
//     do their upstream fetch() inside the server (Bun) process, which also honors
//     these vars — so credential-hidden turns get captured too.
// Loopback is excluded via NO_PROXY so the CLI→cred-proxy hop is never double-proxied.
// Values: "1" → http://127.0.0.1:8899 · bare port "8899" → http://127.0.0.1:8899 ·
//         "host:port" · full "http://…" URL · "0"/unset → off.
const proxyFlag = process.env.FORGEAX_DEBUG_PROXY?.trim();
if (proxyFlag && proxyFlag !== '0') {
  const authority =
    proxyFlag === '1' ? '127.0.0.1:8899' : /^\d+$/.test(proxyFlag) ? `127.0.0.1:${proxyFlag}` : proxyFlag;
  const proxyUrl = /^https?:\/\//.test(authority) ? authority : `http://${authority}`;
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const) {
    process.env[k] = process.env[k] || proxyUrl;
  }
  // Merge loopback into any pre-existing NO_PROXY (e.g. a shell-level Google/Vertex
  // exception) rather than replacing it — intra-stack + cred-proxy hops must bypass.
  const existingNoProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const noProxy = [...new Set([...existingNoProxy, '127.0.0.1', 'localhost', '::1'])].join(',');
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
  // Trust the proxy's MITM root CA. Node & Bun honor NODE_EXTRA_CA_CERTS additively;
  // auto-detect whistle's CA unless FORGEAX_PROXY_CA overrides it.
  const ca =
    process.env.FORGEAX_PROXY_CA ||
    [join(homedir(), '.WhistleAppData/.whistle/certs/root.crt')].find((p) => existsSync(p));
  if (ca) process.env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS || ca;
  console.log(
    `[proxy] LLM egress → ${proxyUrl}  NO_PROXY=${noProxy}  ` +
      (ca ? `CA=${ca}` : '⚠ no CA found — TLS interception will fail (set FORGEAX_PROXY_CA)'),
  );
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`  ⚠ ANTHROPIC_API_KEY is not set in ${envFile} — chat/agent features will fail.`);
}

// Optional-key audit (masked) — mirrors packages/server settings SAFE_ENV_KEYS.
console.log('[env]  key audit (优化 wb-* / multi-provider 体验):');
for (const k of [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ARK_IMAGE_KEY',
  'ARK_VIDEO_KEY',
  'AZURE_GPT_IMAGE_KEY',
  'LITELLM_PROXY_KEY',
  'CURSOR_API_KEY',
]) {
  const v = process.env[k];
  if (v) console.log(`  ✓ ${k.padEnd(26)} ${v.slice(0, 4)}***${v.slice(-4)}`);
  else console.log(`  · ${k.padEnd(26)} (unset · optional)`);
}

// wb-narrative standalone API reads its own .env — sync keys from root .env.
const wbNarrDir = join(ROOT, 'packages/marketplace/plugins/wb-narrative');
syncWbNarrativeEnv();
if (narrativeWillStart()) {
  console.log(`  ✓ ${'narrative API'.padEnd(26)} :${PORT_NARRATIVE} (wb-narrative)`);
} else {
  console.log(`  · ${'narrative API'.padEnd(26)} skipped — set GEMINI_API_KEY or LLM_PROXY_URL in ${envFile}`);
}
console.log();

// ── 1.5 Node 22+ guard ───────────────────────────────────────────────────────
// Bun runs this script, but the server runs under Node — keep the version check.
const nodeMajor = (() => {
  const r = spawnSync('node', ['-v'], { encoding: 'utf8', windowsHide: true });
  const m = (r.stdout ?? '').match(/v(\d+)/);
  return m ? Number.parseInt(m[1] as string, 10) : 0;
})();
if (nodeMajor < 22) {
  console.error(`  ERROR: forgeax-server requires Node 22+ (current: ${nodeMajor || 'not installed'}).`);
  console.error('  Install: nvm install 22 && nvm use 22');
  process.exit(1);
}
console.log(`[node]  ${spawnSync('node', ['-v'], { encoding: 'utf8', windowsHide: true }).stdout.trim()}`);

// ── 2 port preflight ─────────────────────────────────────────────────────────
const preflight: Array<[string, number]> = [
  ['server', PORT_SERVER],
  ['interface', PORT_INTERFACE],
  ['engine', PORT_ENGINE],
];
let preflightBusy = false;
for (const [name, port] of preflight) {
  if (isPortBusy(port)) {
    console.error(`  ✗ port ${port} (${name}) already in use`);
    preflightBusy = true;
  }
}
if (preflightBusy) {
  console.error('\n  Stop the previous stack first:');
  console.error('    bun fx stop           # SIGTERM + 4s grace');
  console.error('    bun fx stop --force   # escalate to SIGKILL');
  console.error('  Or set FORGEAX_SKIP_PREFLIGHT=1 to override.');
  if (process.env.FORGEAX_SKIP_PREFLIGHT !== '1') process.exit(1);
}

// ── 2.5 workspace install self-heal ──────────────────────────────────────────
const wsSentinel = join(ROOT, 'packages/editor/packages/play-runtime/node_modules/@forgeax/engine-runtime/package.json');
if (!existsSync(wsSentinel)) {
  console.log(`[run] workspace dependencies not linked (missing ${wsSentinel})`);
  console.log('[run]   running: bun install (one-shot self-heal)');
  const r = spawnSync(process.execPath, ['install'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    console.error('  ERROR: bun install failed — check network/submodules, then retry: bun install');
    process.exit(1);
  }
  if (!existsSync(wsSentinel)) {
    console.error(`  ERROR: bun install finished but ${wsSentinel} still missing.`);
    console.error('  This usually means the engine submodule isn\'t initialised. Run: bun install');
    process.exit(1);
  }
}
console.log('[workspace] @forgeax/* linked');

// ── 2.x engine dist precondition + freshness ─────────────────────────────────
const enginePkgDir = join(ROOT, 'packages/editor/packages/engine/packages');
const engineEntryPkgs = ['app', 'runtime', 'ecs', 'vite-plugin-pack', 'vite-plugin-shader'];
const missing = engineEntryPkgs.filter((p) => !existsSync(join(enginePkgDir, p, 'dist/index.mjs')));
if (missing.length > 0) {
  console.error(`  ERROR: engine dist missing for: ${missing.join(' ')}`);
  console.error('  (expected packages/editor/packages/engine/packages/<pkg>/dist/index.mjs)');
  console.error('  The editor nested engine submodule has not been fully built yet. Run: bun install');
  process.exit(1);
}
console.log(`[engine] dist found for entry packages: ${engineEntryPkgs.join(' ')}`);

if (process.env.FORGEAX_SKIP_ENGINE_DIST_FRESHNESS !== '1') {
  const stale = engineEntryPkgs.filter((p) => {
    const pdir = join(enginePkgDir, p);
    const dist = join(pdir, 'dist/index.mjs');
    return existsSync(join(pdir, 'src')) && existsSync(dist) && anyNewerThan(join(pdir, 'src'), statSync(dist).mtimeMs);
  });
  if (stale.length > 0) {
    if (process.env.FORGEAX_AUTO_DEPLOY === '1') {
      console.error(`[engine] dist STALE for: ${stale.join(' ')} — FORGEAX_AUTO_DEPLOY=1, rebuilding…`);
      const r = spawnSync(process.execPath, ['run', 'prepare'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      if (r.status !== 0) {
        console.error('  ERROR: auto prepare failed. Run: bun run prepare');
        process.exit(1);
      }
    } else {
      console.error(`  ERROR: engine dist STALE for: ${stale.join(' ')} (src newer than dist).`);
      console.error('  Rebuild: bun run prepare   (or set FORGEAX_SKIP_ENGINE_DIST_FRESHNESS=1 / FORGEAX_AUTO_DEPLOY=1)');
      process.exit(1);
    }
  }
}

// ── 2.x.b wgpu wasm freshness ────────────────────────────────────────────────
const wgpuDir = join(ROOT, 'packages/editor/packages/engine/packages/wgpu-wasm');
const wasmArtefact = join(wgpuDir, 'pkg/wgpu_wasm_bg.wasm');
const wasmSentinel = join(ROOT, '.forgeax/sentinels/wgpu-wasm.built');
if (wgpuWasmStale()) {
  if (!existsSync(wasmArtefact)) console.error(`  ERROR: wgpu wasm artefact missing: ${wasmArtefact}`);
  else console.error('  ERROR: wgpu wasm stale (src / Cargo / pkg/wgpu_wasm.js newer than the .wasm).');
  console.error('  Rebuild: pnpm -F @forgeax/engine-wgpu-wasm build:wasm   (or: bun run prepare)');
  console.error('  Override (not recommended): FORGEAX_SKIP_WGPU_WASM_FRESHNESS=1 bun fx start');
  if (process.env.FORGEAX_SKIP_WGPU_WASM_FRESHNESS !== '1') process.exit(1);
}
console.log('[engine] wgpu wasm fresh');

// ── 2.6 vite optimizeDeps cache self-heal ────────────────────────────────────
if (process.env.FORGEAX_VITE_NO_CLEAN !== '1') {
  const engineDist = join(ROOT, 'packages/editor/packages/engine/packages/runtime/dist');
  const interfaceSrc = join(ROOT, 'packages/interface/src');
  const playSrc = join(ROOT, 'packages/editor/packages/play-runtime/src');
  const editSrc = join(ROOT, 'packages/editor/packages/edit-runtime/src');
  // editor #40 dropped the editor- dir prefix and merged editor-shared INTO core,
  // so the shared runtime + manifest + store now live under core/src.
  const editorCoreSrc = join(ROOT, 'packages/editor/packages/core/src');
  const rootLock = join(ROOT, 'bun.lock');
  viteGuard(ROOT, join(ROOT, 'packages/interface/node_modules/.vite'), 'interface', [engineDist, interfaceSrc, rootLock]);
  // studio now serves the editor engine IN-PROCESS (single realm), so its
  // optimizeDeps cache must invalidate when the engine dist OR the edit-runtime /
  // editor-core sources change — not just interface.
  viteGuard(ROOT, join(ROOT, 'packages/studio/node_modules/.vite'), 'studio', [
    engineDist, interfaceSrc, editSrc, editorCoreSrc, rootLock,
  ]);
  viteGuard(ROOT, join(ROOT, 'packages/editor/packages/play-runtime/.vite'), 'play-runtime', [
    engineDist, playSrc, editorCoreSrc, rootLock,
  ]);
  // NOTE: the edit-runtime (:15280) vite guard is gone with its service — the
  // Edit engine is served in-process by the studio guard above.
}

// ── 3 instance .forgeax/ + junction ──────────────────────────────────────────
const instanceRoot = ROOT;
const engineSrcDir = join(ROOT, 'packages/editor/packages/play-runtime');
mkdirSync(join(instanceRoot, '.forgeax/games'), { recursive: true });
ensureForgeaxJunction(join(engineSrcDir, '.forgeax'), join(instanceRoot, '.forgeax'));

// Shared game library is seeded once by `bun install` (prepare.ts →
// seed-games.ts symlinks). run.ts intentionally does NOT re-seed: seed-games is
// idempotent so re-running was harmless, but doing it on every start blurred the
// deploy/start split and risked piling up <slug>.bak-<ts> if a real dir ever
// appeared. If .forgeax/games/ is empty, run `bun install` to (re)seed.

process.env.FORGEAX_PROJECT_ROOT = instanceRoot;

// ── 3.5 per-stack agent-host socket ──────────────────────────────────────────
// The forgeax-core kernel runs inside a persistent `agent-host` sidecar the
// server lazy-connects to (sidecar-client.ts → defaultSockPath). That default
// (`~/.forgeax/agent-host.sock`) is USER-GLOBAL: it does not vary per checkout
// or per port band. So a second forgeax stack started on the same machine —
// even a fresh checkout — reuses the FIRST stack's agent-host (ensureSidecar
// "try existing first" wins), inheriting its cred-proxy, real key and project
// root. The borrowed cred path then rejects this stack's turns → forgeax-kernel
// replies come back empty (0 tokens) after a long retry stall; the claude kernel
// is unaffected (it never goes through the sidecar).
//
// Fix: derive the socket from PORT_SERVER, which is already unique across any
// stacks that can run concurrently (port preflight forbids two on one port).
// default→18900 / dev-local→28900 / dev-local2→38900 each get their own socket,
// so the three bands (and separate checkouts) never share one agent-host.
// SSOT: no new identity — the socket is a function of the already-declared port.
// Set-if-absent so an explicit FORGEAX_AGENT_HOST_SOCK still wins.
process.env.FORGEAX_AGENT_HOST_SOCK ??= join(homedir(), '.forgeax', `agent-host-${PORT_SERVER}.sock`);

// ── 3.75 heal broken workbench plugin dists ──────────────────────────────────
if (existsSync(join(ROOT, 'scripts/build-plugins.ts'))) {
  spawnSync(process.execPath, [join(ROOT, 'scripts/build-plugins.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
}

// ── 3.8 discover standalone-backend plugins ──────────────────────────────────
const runtimeDir = join(ROOT, '.forgeax');
const pluginDevPortsFile = join(runtimeDir, 'plugin-dev-ports.json');
const runStackFile = join(runtimeDir, 'dev-stack.env');
mkdirSync(runtimeDir, { recursive: true });

const pluginPortOffset = Number.parseInt(process.env.FORGEAX_PLUGIN_PORT_OFFSET ?? '0', 10) || 0;
const allocated = new Set<number>([PORT_SERVER, PORT_INTERFACE, PORT_ENGINE]);
const allocPort = (seed: number): number => {
  let port = seed;
  while (isPortBusy(port) || allocated.has(port)) port++;
  allocated.add(port);
  return port;
};

interface PluginEntry {
  dir: string;
  id: string;
  shortId: string;
  frontendPort: number;
  backendPort: number;
  projectRoot: string;
}
const plugins: PluginEntry[] = [];
for (const d of discoverStandalonePlugins(join(ROOT, 'packages/marketplace/plugins'))) {
  const seed = d.port + pluginPortOffset;
  const frontendPort = allocPort(seed);
  const backendPort = allocPort(seed + 2);
  const projectRoot = join(instanceRoot, '.forgeax/workbench', d.shortId);
  mkdirSync(projectRoot, { recursive: true });
  plugins.push({ dir: d.dir, id: d.id, shortId: d.shortId, frontendPort, backendPort, projectRoot });
  console.log(`[run] + ${d.shortId} frontend :${frontendPort} backend :${backendPort} (workspace .forgeax/workbench/${d.shortId})`);
}
if (plugins.length === 0) console.log('[run]   no standalone-backend plugins discovered');

writeFileSync(
  pluginDevPortsFile,
  `${JSON.stringify(
    {
      generatedBy: 'scripts/run.ts',
      plugins: Object.fromEntries(plugins.map((p) => [p.id, { frontendPort: p.frontendPort, backendPort: p.backendPort }])),
    },
    null,
    2,
  )}\n`,
);
process.env.FORGEAX_PLUGIN_DEV_PORTS_FILE = pluginDevPortsFile;

// ── cleanup trap ──────────────────────────────────────────────────────────────
const children: number[] = [];
let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  reapPidfiles(ROOT, false);
  for (const pid of children) killTree(pid, false);
  clearPidfiles(ROOT);
  lock.release();
  rmSync(runStackFile, { force: true });
  rmSync(pluginDevPortsFile, { force: true });
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
process.on('exit', cleanup);

// Fresh run dir.
clearPidfiles(ROOT);
mkdirSync(runDir(ROOT), { recursive: true });

// ── 4 launch services ─────────────────────────────────────────────────────────
console.log(
  `[run] starting server :${PORT_SERVER} + interface :${PORT_INTERFACE} (editor in-process) + engine :${PORT_ENGINE}`,
);
if (narrativeWillStart()) console.log(`[run] + narrative API :${PORT_NARRATIVE} (wb-narrative standalone)`);
console.log(`[run] open http://localhost:${PORT_INTERFACE} to use the Studio UI`);
console.log('[run]   浏览器(WebGPU): bun fx start   ·   桌面 App: bun fx start desktop');

const launch = (name: string, cmd: string, args: string[], opts: SpawnOpts): number => {
  const child = spawnService(cmd, args, opts);
  const pid = child.pid ?? 0;
  if (pid) {
    children.push(pid);
    recordPid(ROOT, name, pid);
  }
  // Monitor unexpected death. `launch()` previously fire-and-forgot: a service
  // that crashed AFTER boot (e.g. the engine vite dying mid-session) vanished
  // silently — run.ts never noticed, so `/preview` + `/__import` (proxied to the
  // dead engine) 500'd with no signal anywhere. Surface it loudly on stdout (the
  // fd is captured into forgeax-stack.log, and `fx start`'s engine-readiness
  // poll tails that). NOT auto-restarted by design: a crash-looping service
  // should be seen and fixed, not silently respawned into a hot loop.
  child.on('exit', (code, signal) => {
    if (cleanedUp) return; // expected teardown — say nothing
    const how = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[run] ⚠ service '${name}' (pid ${pid}) exited unexpectedly (${how}) — not restarting; run \`bun fx restart\` after fixing the cause`);
  });
  child.on('error', (err: unknown) => {
    if (cleanedUp) return;
    console.error(`[run] ⚠ service '${name}' failed to spawn:`, err instanceof Error ? err.message : String(err));
  });
  return pid;
};

const srv = launch('server', 'bun', ['--watch', 'src/main.ts'], { cwd: join(ROOT, 'packages/server') });

// Wait for server to bind before starting interface (avoids proxy ECONNREFUSED race).
await waitForPort(PORT_SERVER, 10_000);

// ── DEV-only live gateway bridge (forgeax-editor-gateway `gateway-live.mjs`) ──
// Single-realm studio serves the editor page IN-PROCESS in the :18920 vite, so
// unlike the editor's own `dev:standalone` (which wires this into its :15290 host)
// nothing here dialed the relay before. Two lines are needed, mirroring editor
// fx.ts §bridge: (1) the compile-time `VITE_FORGEAX_BRIDGE` flag MUST reach the
// interface(studio) vite — that vite is what inlines it into ViewportComponent's
// bridge-dial code (import.meta.env.VITE_FORGEAX_BRIDGE), so it goes on the UI
// launch env below; (2) the loopback relay process (:15295), spawned after. On by
// default so `bun fx start` matches the editor; FORGEAX_BRIDGE=0 opts out.
const bridge = process.env.FORGEAX_BRIDGE !== '0';
const bridgePort = String(PORT_GATEWAY_BRIDGE);
const bridgeEnv: NodeJS.ProcessEnv = bridge
  ? { VITE_FORGEAX_BRIDGE: '1', VITE_FORGEAX_BRIDGE_PORT: bridgePort }
  : { VITE_FORGEAX_BRIDGE: '0' };

const uiPkg = STUDIO === '1' ? 'studio' : 'interface';
const ui = launch('interface', 'bun', ['x', 'vite'], {
  cwd: join(ROOT, 'packages', uiPkg),
  env: { ...process.env, ...bridgeEnv },
});
// play-runtime holds ZERO on-disk layout convention now — the HOST injects it.
// Studio's layout is `<engineSrcDir>/.forgeax/games` (via the junction above),
// served under the vite root as the URL prefix `.forgeax/games`. Both must agree.
const en = launch('engine', 'bun', ['x', 'vite'], {
  cwd: engineSrcDir,
  env: {
    ...process.env,
    FORGEAX_PREVIEW_GAMES_DIR: join(engineSrcDir, '.forgeax/games'),
    FORGEAX_GAMES_URL_PREFIX: '.forgeax/games',
  },
});
// Single-realm (feat-20260703): the editor engine boots IN-PROCESS in the
// interface(studio) vite at :18920 — no separate edit-runtime vite service. The
// former `editor` (:15280) launch is gone; the play/preview engine (:15173) stays
// (Play iframe + the in-process editor's per-game pack catalog fallback use it).

// Live gateway bridge relay (:15295) — the loopback meeting point the CLI POSTs to
// and the in-process editor page dials out to. The relay script lives in the editor
// submodule; `bun` (not node) so its vendored `ws` resolves, cwd:ROOT so the isolated
// store is on the resolution path. DEV-only, loopback-only; skipped by FORGEAX_BRIDGE=0.
const GATEWAY_RELAY_SCRIPT = join(
  ROOT,
  'packages/editor/skills/forgeax-editor-gateway/scripts/gateway-bridge-server.mjs',
);
if (bridge) {
  if (existsSync(GATEWAY_RELAY_SCRIPT)) {
    launch('gw-bridge', 'bun', [GATEWAY_RELAY_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, FORGEAX_BRIDGE_PORT: bridgePort },
    });
    console.log(
      `[run] live gateway bridge :${bridgePort} → node packages/editor/skills/forgeax-editor-gateway/scripts/gateway-live.mjs (opt out: FORGEAX_BRIDGE=0)`,
    );
  } else {
    // Editor submodule not populated (fresh worktree / partial checkout). The page
    // still dials, but with no relay it just retries harmlessly — don't fail boot.
    console.error(
      `[run] ⚠ gateway bridge relay script missing (${GATEWAY_RELAY_SCRIPT}) — run \`git submodule update --init packages/editor\`; skipping relay`,
    );
  }
}

let narr = 0;
if (narrativeWillStart()) {
  narr = launch('narrative', 'npx', ['tsx', '--env-file=.env', 'src/api/server.ts'], { cwd: wbNarrDir });
}

// Plugin TLS reuse for HTTPS iframes.
let pluginTlsCert = '';
let pluginTlsKey = '';
if (
  process.env.FORGEAX_INTERFACE_HTTPS === '1' &&
  existsSync(join(ROOT, '.tls/cert.pem')) &&
  existsSync(join(ROOT, '.tls/key.pem'))
) {
  pluginTlsCert = join(ROOT, '.tls/cert.pem');
  pluginTlsKey = join(ROOT, '.tls/key.pem');
}

const pluginPids: number[] = [];
for (const p of plugins) {
  const cmd = extPluginCmd(p.dir);
  const pid = launch(`plugin-${p.shortId}`, 'pnpm', [cmd], {
    cwd: p.dir,
    env: {
      ...process.env,
      FORGEAX_LOG_PRETTY: process.env.FORGEAX_LOG_PRETTY ?? '0',
      FORGEAX_PROJECT_ROOT: p.projectRoot,
      PORT: String(p.backendPort),
      VITE_DEV_PORT: String(p.frontendPort),
      VITE_API_TARGET: `http://localhost:${p.backendPort}`,
      VITE_DEV_HTTPS_CERT: pluginTlsCert,
      VITE_DEV_HTTPS_KEY: pluginTlsKey,
    },
  });
  pluginPids.push(pid);

  // Optional headless renderer for agent screenshots.
  if (
    process.env.FORGEAX_LOWPOLY_HEADLESS_RENDERER !== '0' &&
    existsSync(join(p.dir, 'node_modules/playwright')) &&
    existsSync(join(p.dir, 'scripts/headless-renderer.mjs'))
  ) {
    console.log(`[run] + ${p.shortId} headless renderer (agent screenshots; disable: FORGEAX_LOWPOLY_HEADLESS_RENDERER=0)`);
    launch(`plugin-${p.shortId}-headless`, 'node', ['scripts/headless-renderer.mjs'], {
      cwd: p.dir,
      env: { ...process.env, LOWPOLY_FRONTEND_PORT: String(p.frontendPort) },
    });
  }
}

// dev-stack.env so stop.ts can find dynamic ports/pids.
// Include OUR OWN pid (process.pid) first: this orchestrator blocks forever on
// the `await new Promise(()=>{})` below and never self-exits when its children
// die, and it holds no port / no signature that stop.ts's port/pidfile scans
// would otherwise catch. Without listing it here, `bun fx stop` reaps every
// service but leaves this launcher alive as an idle orphan (one per start/stop
// cycle). Listed here, stop.ts's dev-stack.env layer SIGTERMs it → our cleanup()
// trap runs (kills children + releases the start lock) and we exit cleanly.
writeFileSync(
  runStackFile,
  [
    '# generated by scripts/run.ts',
    `FORGEAX_RUN_PIDS="${[process.pid, srv, ui, en, narr, ...pluginPids].filter(Boolean).join(' ')}"`,
    `FORGEAX_RUN_PORTS="${[PORT_SERVER, PORT_INTERFACE, PORT_ENGINE, PORT_NARRATIVE, ...plugins.map((p) => p.frontendPort), ...plugins.map((p) => p.backendPort)].join(' ')}"`,
    `FORGEAX_PLUGIN_DEV_PORTS_FILE="${pluginDevPortsFile}"`,
    '',
  ].join('\n'),
);

// Keep the orchestrator alive until interrupted (mirrors bash `wait`).
await new Promise<void>(() => {});

// ── helpers ───────────────────────────────────────────────────────────────────

/** Recursively true if any file under `dir` has mtime > `anchorMs`. */
function anyNewerThan(dir: string, anchorMs: number): boolean {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (anyNewerThan(p, anchorMs)) return true;
    } else if (e.isFile()) {
      try {
        if (statSync(p).mtimeMs > anchorMs) return true;
      } catch {
        // skip
      }
    }
  }
  return false;
}

function wgpuWasmStale(): boolean {
  if (!existsSync(wasmArtefact)) return true;
  const anchorMs = (existsSync(wasmSentinel) ? statSync(wasmSentinel) : statSync(wasmArtefact)).mtimeMs;
  for (const cand of [join(wgpuDir, 'Cargo.toml'), join(wgpuDir, 'Cargo.lock'), join(wgpuDir, 'pkg/wgpu_wasm.js')]) {
    if (existsSync(cand) && statSync(cand).mtimeMs > anchorMs) return true;
  }
  if (existsSync(join(wgpuDir, 'src')) && anyNewerThan(join(wgpuDir, 'src'), anchorMs)) return true;
  return false;
}

/** Create/repair the play-runtime/.forgeax → instance/.forgeax junction. */
function ensureForgeaxJunction(linkPath: string, target: string): void {
  let kind: 'symlink' | 'missing' | 'empty-dir' | 'full-dir' | 'other';
  if (!existsSync(linkPath)) kind = 'missing';
  else {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) kind = 'symlink';
    else if (st.isDirectory()) kind = readdirSync(linkPath).length === 0 ? 'empty-dir' : 'full-dir';
    else kind = 'other';
  }
  if (kind === 'symlink' || kind === 'missing') {
    try {
      unlinkSync(linkPath);
    } catch {
      // not present
    }
    symlinkSync(target, linkPath, 'junction');
  } else if (kind === 'empty-dir') {
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(target, linkPath, 'junction');
    console.log(`[run] cleared empty real dir at ${linkPath} and replaced with symlink`);
  } else if (kind === 'full-dir') {
    const bak = `${linkPath}.bak-${stamp()}`;
    renameSync(linkPath, bak);
    symlinkSync(target, linkPath, 'junction');
    console.error(`  ⚠ ${linkPath} was a real directory; moved to ${bak} and replaced with symlink.`);
  } else {
    console.error(`  ERROR: ${linkPath} exists as something we can't classify (not symlink, not dir).`);
    process.exit(1);
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface DiscoveredPlugin {
  dir: string;
  id: string;
  shortId: string;
  port: number;
}
/** Marketplace manifests with entry.standalone {embeddedAlso:false, start, port}. */
function discoverStandalonePlugins(pluginsDir: string): DiscoveredPlugin[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredPlugin[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const mf = join(pluginsDir, e.name, 'forgeax-plugin.json');
    if (!existsSync(mf)) continue;
    let m: { id?: string; entry?: { standalone?: { embeddedAlso?: boolean; start?: unknown; port?: unknown } } };
    try {
      m = JSON.parse(readFileSync(mf, 'utf8'));
    } catch {
      continue;
    }
    const sa = m.entry?.standalone;
    if (!sa || sa.embeddedAlso !== false || !sa.start || typeof sa.port !== 'number') continue;
    const id = String(m.id ?? e.name);
    const shortId = id.replace(/^@[^/]+\//, '');
    let dir = join(pluginsDir, e.name);
    try {
      dir = realpathSync(dir);
    } catch {
      // keep unresolved
    }
    out.push({ dir, id, shortId, port: sa.port });
  }
  return out;
}

/** Pick the plugin run script: dev (HMR, default) or serve. */
function extPluginCmd(dir: string): string {
  const hasScript = (name: string): boolean => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      return Boolean(pkg.scripts?.[name]);
    } catch {
      return false;
    }
  };
  if (process.env.FORGEAX_PLUGIN_HMR !== '0') {
    return hasScript('dev') ? 'dev' : hasScript('serve') ? 'serve' : 'dev';
  }
  return hasScript('serve') ? 'serve' : hasScript('dev') ? 'dev' : 'serve';
}

/** Sync GEMINI/proxy keys from root .env into wb-narrative/.env. */
function syncWbNarrativeEnv(): void {
  const gemini = process.env.GEMINI_API_KEY ?? '';
  const proxy = process.env.LLM_PROXY_URL ?? process.env.LITELLM_PROXY_BASE_URL ?? '';
  const proxyKey = process.env.LITELLM_PROXY_KEY ?? '';
  if (!gemini && !proxy) return;

  const narrEnv = join(wbNarrDir, '.env');
  if (!existsSync(narrEnv)) {
    const ex = join(wbNarrDir, '.env.example');
    if (existsSync(ex)) copyFileSync(ex, narrEnv);
    else writeFileSync(narrEnv, '# Synced from forgeax-studio/.env by run.ts\n');
  }
  let text = readFileSync(narrEnv, 'utf8');
  const upsert = (key: string, val: string) => {
    if (!val) return;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${val}`);
    else text += `\n${key}=${val}\n`;
  };
  upsert('GEMINI_API_KEY', gemini);
  upsert('LLM_PROXY_URL', proxy);
  upsert('LITELLM_PROXY_KEY', proxyKey);
  writeFileSync(narrEnv, text);
}

function narrativeWillStart(): boolean {
  const narrEnv = join(wbNarrDir, '.env');
  if (!existsSync(narrEnv)) return false;
  return /^(GEMINI_API_KEY|LLM_PROXY_URL)=.+/m.test(readFileSync(narrEnv, 'utf8'));
}
