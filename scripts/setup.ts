#!/usr/bin/env bun
// @ts-nocheck
// scripts/setup.ts — forgeax-studio one-command end-to-end setup (`bun fx setup`).
// Idempotent — re-running picks up where it left off.
//
// Steps: [0] toolchain bootstrap (bootstrap.ts --toolchain-only) · [1] prereq
// gate · [2] submodule init+align+harness sync · [3] engine pnpm build · [3b]
// wgpu wasm · [4] root bun install · [5] marketplace plugin install+build ·
// [6] .env scaffold · [7] seed sample games. --start then launches run.ts.
//
// Flags: --start · --no-plugins · --skip-bootstrap · --interactive/-i

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { has, IS_WIN, resolvePython, run } from './lib/sh.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bold = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const warnY = (s: string) => console.log(`\x1b[33m⚠ ${s}\x1b[0m`);
const fail = (s: string): never => {
  console.error(`\x1b[1;31m✗ ${s}\x1b[0m`);
  process.exit(1);
};

let start = false;
let skipPlugins = false;
let skipBootstrap = false;
let interactive = false;
for (const a of process.argv.slice(2)) {
  if (a === '--start') start = true;
  else if (a === '--no-plugins') skipPlugins = true;
  else if (a === '--skip-bootstrap') skipBootstrap = true;
  else if (a === '--interactive' || a === '-i') interactive = true;
  else if (a === '--yes' || a === '-y') {
    /* back-compat no-op: auto is the default */
  } else if (a === '-h' || a === '--help') {
    console.log('Usage: bun fx setup [--start] [--no-plugins] [--skip-bootstrap] [--interactive]');
    process.exit(0);
  } else fail(`unknown arg: ${a}`);
}

const env = { ...process.env };
if (!interactive) {
  env.FORGEAX_BOOTSTRAP_YES = '1';
  env.FORGEAX_DEPLOY_NO_PROMPT_OPTIONAL = '1';
}

// ── 0. toolchain bootstrap ───────────────────────────────────────────────────
if (skipBootstrap) {
  bold('[0/6] Toolchain bootstrap skipped (--skip-bootstrap)');
} else {
  bold('[0/6] Toolchain bootstrap (bootstrap.ts --toolchain-only)');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/bootstrap.ts'), '--toolchain-only'], {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });
  if (r.status !== 0) fail('toolchain bootstrap failed');
}

// ── 1. prereq gate ────────────────────────────────────────────────────────────
bold('[1/6] Checking prerequisites');
if (!has('git')) fail('git not found.');
if (!has('bun')) fail('bun not found. Install: https://bun.sh');
if (!has('node')) fail('node not found. Install Node 22+.');
const nodeMajor = Number.parseInt(
  execFileSync('node', ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '').split('.')[0] ?? '0',
  10,
);
if (nodeMajor < 22) fail(`Node ${nodeMajor} found; forgeax-server needs ≥22.`);
ok(`git + bun + node v${nodeMajor} present`);

// ── 2. submodule init + align + harness sync ─────────────────────────────────
bold('[2/6] Initialising submodules');

// SSH fallback for private submodules (HTTPS→SSH rewrite, this run only).
const gitEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
if (!IS_WIN) {
  const gm = spawnSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'url'], { cwd: ROOT, encoding: 'utf8' });
  if ((gm.stdout ?? '').includes('https://github.com/')) {
    const ssh = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', 'git@github.com'], {
      encoding: 'utf8',
    });
    if (`${ssh.stdout ?? ''}${ssh.stderr ?? ''}`.includes('successfully authenticated')) {
      gitEnv.GIT_CONFIG_COUNT = '1';
      gitEnv.GIT_CONFIG_KEY_0 = 'url.git@github.com:.insteadOf';
      gitEnv.GIT_CONFIG_VALUE_0 = 'https://github.com/';
      ok('GitHub SSH key detected — using SSH for private submodules');
    }
  }
}
const depth = env.FORGEAX_SUBMODULE_FULL === '1' ? [] : ['--depth', '1'];
{
  const r = spawnSync('git', ['submodule', 'update', '--init', '--recursive', ...depth], {
    stdio: 'inherit',
    cwd: ROOT,
    env: gitEnv,
  });
  if (r.status !== 0) fail('git submodule update failed.');
}
// Align each submodule onto local main (same pinned SHA — no fetch).
spawnSync('git', ['submodule', 'foreach', '--recursive', '--quiet',
  'git branch -f main HEAD >/dev/null 2>&1 || true; git checkout main >/dev/null 2>&1 || true'],
  { stdio: 'ignore', cwd: ROOT });
ok('submodules ready, aligned to local main');

// .forgeax-harness floating clone (non-fatal).
syncHarness(ROOT, '.forgeax-harness floating clone');
installHarnessSkills();
for (const sub of ['engine', 'editor']) {
  if (existsSync(join(ROOT, 'packages', sub, 'scripts/sync-harness.mjs'))) {
    bold(`  → packages/${sub} harness sync`);
    spawnSync('node', ['scripts/sync-harness.mjs'], { stdio: 'inherit', cwd: join(ROOT, 'packages', sub) });
  }
}

// ── 3. engine submodule build ────────────────────────────────────────────────
bold('[3/6] Building engine submodule packages');
const engineDir = join(ROOT, 'packages/engine');
if (!existsSync(engineDir)) fail('packages/engine submodule missing — run git submodule update --init --recursive');
const skipEngineBuild =
  env.FORGEAX_SKIP_ENGINE_BUILD &&
  existsSync(join(engineDir, 'packages/app/dist')) &&
  existsSync(join(engineDir, 'packages/runtime/dist'));
if (skipEngineBuild) {
  if (!run('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDir })) fail('engine pnpm install failed (skip-build path).');
  ok('engine build skipped — FORGEAX_SKIP_ENGINE_BUILD set and dist/ present');
} else {
  if (!run('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDir })) fail('engine pnpm install failed.');
  const filters = [
    '@forgeax/engine-app...', '@forgeax/engine-runtime...', '@forgeax/engine-ecs...', '@forgeax/engine-types...',
    '@forgeax/engine-vite-plugin-shader...', '@forgeax/engine-vite-plugin-pack...', '@forgeax/engine-shader-compiler...',
    '@forgeax/engine-naga...', '@forgeax/engine-wgpu-wasm...', '@forgeax/engine-gltf...', '@forgeax/engine-image...',
    '@forgeax/engine-pack...', '@forgeax/engine-project...',
  ].flatMap((f) => ['--filter', f]);
  if (!run('pnpm', [...filters, '-r', 'build'], { cwd: engineDir })) fail('engine submodule build failed.');
  ok('engine packages built');
}

// ── 3b. wgpu wasm ─────────────────────────────────────────────────────────────
bold('[3b/6] Building engine wgpu wasm binary');
const wgpuDir = join(engineDir, 'packages/wgpu-wasm');
const wasmArtefact = join(wgpuDir, 'pkg/wgpu_wasm_bg.wasm');
const wasmSentinel = join(ROOT, '.forgeax/sentinels/wgpu-wasm.built');
const touchSentinel = () => {
  mkdirSync(dirname(wasmSentinel), { recursive: true });
  writeFileSync(wasmSentinel, '');
};
if (!wgpuWasmStale()) {
  ok(`wgpu wasm already built and fresh (skip) — ${wasmArtefact}`);
  if (!existsSync(wasmSentinel)) touchSentinel();
} else if (!has('rustc') || !has('wasm-pack')) {
  warnY('Rust→wasm toolchain missing — skipping wgpu wasm build.');
  console.log('    The preview engine will fail until this is built (install rust + wasm-pack, then: pnpm -F @forgeax/engine-wgpu-wasm build:wasm)');
} else {
  console.log(existsSync(wasmArtefact) ? '  → wgpu wasm stale — rebuilding' : '  → wgpu wasm missing — building');
  if (has('rustup')) {
    const t = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
    if (!(t.stdout ?? '').includes('wasm32-unknown-unknown')) run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  }
  if (run('pnpm', ['-F', '@forgeax/engine-wgpu-wasm', 'build:wasm'], { cwd: engineDir })) {
    touchSentinel();
    ok(`wgpu wasm built — ${wasmArtefact}`);
  } else {
    warnY('wgpu wasm build failed — preview engine will not start until fixed.');
  }
}

// ── 4. root workspace install ─────────────────────────────────────────────────
bold('[4/6] Installing workspace dependencies');
if (!bunInstallWithRetry(ROOT)) fail('root bun install failed');
ok('workspace dependencies resolved');

// ── 5. plugin install + build ─────────────────────────────────────────────────
bold('[5/6] Installing + building marketplace plugins');
if (skipPlugins) {
  console.log('  (skipped — --no-plugins)');
} else {
  const pluginsDir = join(ROOT, 'packages/marketplace/plugins');
  for (const e of existsSync(pluginsDir) ? readdirSync(pluginsDir, { withFileTypes: true }) : []) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === '_template') continue;
    const d = join(pluginsDir, e.name);
    if (!existsSync(join(d, 'package.json'))) continue;

    if (existsSync(join(d, 'pnpm-workspace.yaml'))) {
      console.log(`  → pnpm install (${e.name} pnpm workspace)`);
      if (!run('pnpm', ['install', '--frozen-lockfile'], { cwd: d })) run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: d });
    } else {
      installDir(d);
    }

    const pkg = readJson(join(d, 'package.json')) as { scripts?: Record<string, string> } | null;
    if (pkg?.scripts?.build) {
      if (pluginBuildFresh(d)) ok(`${e.name}  build cache fresh, skip`);
      else {
        console.log(`  → bun run build (${e.name})`);
        if (run('bun', ['run', 'build'], { cwd: d })) ok(`${e.name}  built`);
        else warnY(`${e.name}  build failed — continuing`);
      }
    }
  }
}

// ── 6. .env scaffold ──────────────────────────────────────────────────────────
bold('[6/6] Configuring $ROOT/.env');
const envFile = join(ROOT, '.env');
const envExample = join(ROOT, '.env.example');
if (!existsSync(envFile) && existsSync(join(ROOT, 'packages/forgeax/.env'))) {
  copyFileSync(join(ROOT, 'packages/forgeax/.env'), envFile);
  ok('migrated legacy packages/forgeax/.env → $ROOT/.env');
}
if (!existsSync(envFile)) {
  copyFileSync(envExample, envFile);
  ok('created $ROOT/.env from .env.example');
}
if (!/^ANTHROPIC_API_KEY=.+/m.test(readFileSync(envFile, 'utf8'))) {
  if (interactive && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const key = await new Promise<string>((res) => rl.question('  ANTHROPIC_API_KEY (Enter to skip): ', res));
    rl.close();
    if (key.trim()) {
      upsertEnv(envFile, 'ANTHROPIC_API_KEY', key.trim());
      ok('ANTHROPIC_API_KEY set');
    } else console.log(`  (skipped — edit ${envFile} before bun fx start)`);
  } else {
    warnY(`ANTHROPIC_API_KEY not set in ${envFile} — edit it before chatting in Studio.`);
  }
} else {
  ok('ANTHROPIC_API_KEY already set');
}

// ── 7. seed sample games ──────────────────────────────────────────────────────
console.log();
bold('[7/7] Seeding sample games to .forgeax/games/');
// SSOT: defer to scripts/seed-games.ts (symlink each shared-library game into
// .forgeax/games/<slug>). This is the SAME path run.ts and the desktop .app's
// Rust seed_shared_games use — one algorithm, symlinks only, idempotent. Do NOT
// cpSync real dirs here: a real <slug> dir shadows the shared library, and
// seed-games would later rename it to <slug>.bak-<ts>, piling up duplicates.
const gamesSrc = join(ROOT, 'packages/games');
const gamesDst = join(ROOT, '.forgeax/games');
mkdirSync(gamesDst, { recursive: true });
if (existsSync(gamesSrc) && readdirSync(gamesSrc).length > 0) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/seed-games.ts')], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, FORGEAX_GAMES_SRC: gamesSrc, FORGEAX_GAMES_DST: gamesDst },
  });
  if (r.status !== 0) warnY('seed-games failed (continuing without shared games)');
  else ok('sample games seeded (symlinks)');
} else {
  console.log('  → packages/games not found (skipped)');
}

console.log();
bold('Setup complete.');
console.log('Next:\n  bun fx start      # start Studio and open the default web client');
console.log('Endpoints once running:\n  http://localhost:18920  Studio UI\n  http://localhost:18900  Server\n  http://localhost:15173  Engine');

if (start) {
  console.log();
  bold('[start] Launching Studio…');
  const r = spawnSync(process.execPath, ['fx', 'start'], { stdio: 'inherit', cwd: ROOT, env });
  process.exit(r.status ?? 0);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function syncHarness(cwd: string, label: string): void {
  console.log(`  → node scripts/sync-harness.mjs (${label})`);
  const r = spawnSync('node', [join(cwd, 'scripts/sync-harness.mjs')], { stdio: 'inherit', cwd });
  if (r.status === 0) ok(`${label} synced`);
  else warnY(`${label} sync failed — continuing`);
}

function installHarnessSkills(): void {
  const py = join(ROOT, 'packages/harness/skills/forgeax-install/scripts/install_harness.py');
  const ir = join(ROOT, 'packages/harness/skills/forgeax-install/examples/forgeax-studio.json');
  const python = resolvePython();
  if (!existsSync(py) || !existsSync(ir) || !python) {
    warnY('forgeax-install IR or a working Python missing — skipping');
    return;
  }
  for (const m of ['.codebuddy', '.cursor', '.agents', '.claude', '.claude-internal', '.workbuddy']) {
    mkdirSync(join(ROOT, m, 'skills'), { recursive: true });
    mkdirSync(join(ROOT, m, 'rules'), { recursive: true });
  }
  const [pyCmd, ...pyPrefix] = python;
  console.log(`  → forgeax-install (harness skills/rules → ${ROOT})`);
  if (run(pyCmd, [...pyPrefix, py, '--spec', ir, '--target-root', ROOT])) ok('harness skills/rules installed');
  else warnY('forgeax-install failed — continuing');
}

function wgpuWasmStale(): boolean {
  if (!existsSync(wasmArtefact)) return true;
  const anchorMs = (existsSync(wasmSentinel) ? statSync(wasmSentinel) : statSync(wasmArtefact)).mtimeMs;
  for (const c of [join(wgpuDir, 'Cargo.toml'), join(wgpuDir, 'Cargo.lock'), join(wgpuDir, 'pkg/wgpu_wasm.js')]) {
    if (existsSync(c) && statSync(c).mtimeMs > anchorMs) return true;
  }
  return existsSync(join(wgpuDir, 'src')) && anyNewerThan(join(wgpuDir, 'src'), anchorMs);
}

function anyNewerThan(dir: string, anchorMs: number): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (anyNewerThan(p, anchorMs)) return true;
    } else if (e.isFile()) {
      try {
        if (statSync(p).mtimeMs > anchorMs) return true;
      } catch {
        /* skip */
      }
    }
  }
  return false;
}

/** bun install with the known half-installed-state recovery (Windows GAP-06). */
function bunInstallWithRetry(dir: string): boolean {
  if (run('bun', ['install', '--frozen-lockfile'], { cwd: dir })) return true;
  if (run('bun', ['install'], { cwd: dir })) return true;
  warnY(`bun install failed in ${dir}, clearing .bun cache and retrying with --ignore-scripts`);
  rmSync(join(dir, 'node_modules/.bun'), { recursive: true, force: true });
  return run('bun', ['install', '--ignore-scripts'], { cwd: dir });
}

function installDir(dir: string): void {
  if (!existsSync(join(dir, 'package.json'))) return;
  const nm = join(dir, 'node_modules');
  if (existsSync(nm) && statSync(nm).mtimeMs > statSync(join(dir, 'package.json')).mtimeMs) {
    ok(`${dir}  (cache fresh, skip)`);
    return;
  }
  console.log(`  → bun install (${dir})`);
  if (bunInstallWithRetry(dir)) ok(`${dir}  installed`);
  else warnY(`${dir}  install failed — continuing`);
}

function pluginBuildFresh(dir: string): boolean {
  const pkgMs = statSync(join(dir, 'package.json')).mtimeMs;
  const topDist = join(dir, 'dist');
  if (existsSync(topDist)) return statSync(topDist).mtimeMs > pkgMs;
  // workspace plugin: scan leaf dists (prune node_modules)
  let found = false;
  const walk = (d: string, depth: number): boolean => {
    if (depth > 4) return true;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'dist') {
          found = true;
          if (pkgMs > statSync(p).mtimeMs) return false;
        } else if (!walk(p, depth + 1)) return false;
      }
    }
    return true;
  };
  if (!walk(dir, 0)) return false;
  return found;
}

function upsertEnv(file: string, key: string, val: string): void {
  let text = readFileSync(file, 'utf8');
  const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  if (re.test(text)) text = text.replace(re, `${key}=${val}`);
  else text += `\n${key}=${val}\n`;
  writeFileSync(file, text);
}
