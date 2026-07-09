#!/usr/bin/env bun
// @ts-nocheck
// scripts/setup.ts — forgeax-studio one-command end-to-end setup (`bun fx setup`).
// Idempotent — re-running picks up where it left off.
//
// Steps: [0] toolchain bootstrap (bootstrap.ts --toolchain-only) · [1] prereq
// gate · [2] submodule init+harness sync · [3] engine pnpm build · [3b]
// wgpu wasm · [4] root bun install · [5] marketplace plugin install+build ·
// [6] .env scaffold · [7] seed sample games. --start then launches run.ts.
//
// Flags: --start · --no-plugins · --skip-bootstrap · --interactive/-i

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { has, resolvePython, run } from './lib/sh.ts';
import { hardenedGitEnv, NO_CRED_ARGV, probeGitHubSsh, resolveCredentialConfig } from './lib/git-credential.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bold = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const warnY = (s: string) => console.log(`\x1b[33m⚠ ${s}\x1b[0m`);
const fail = (s: string): never => {
  console.error(`\x1b[1;31m✗ ${s}\x1b[0m`);
  process.exit(1);
};

type SetupResult = {
  repoType: 'submodule';
  repo: string;
  result: 'ok' | 'failed' | 'skipped';
  detail?: string;
};

const setupResults: SetupResult[] = [];

function cleanTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function colorResult(result: string): string {
  if (result === 'OK') return `\x1b[32m${result}\x1b[0m`;
  if (result === 'FAILED') return `\x1b[31m${result}\x1b[0m`;
  return result;
}

function formatSetupReport(rows: SetupResult[]): string {
  const tableRows = rows.map((row) => [
    row.result.toUpperCase(),
    row.repo,
    row.repoType,
    row.detail ?? '',
  ]);
  const header = ['RESULT', 'REPO', 'REPO TYPE', 'DETAIL'];
  const widths = header.map((title, i) => Math.max(
    title.length,
    ...tableRows.map((row) => cleanTableCell(row[i] ?? '').length),
  ));
  const formatRow = (row: string[], color = false): string => row
    .map((cell, i) => {
      const text = cleanTableCell(cell).padEnd(widths[i]);
      return color && i === 0 ? colorResult(text) : text;
    })
    .join('  ')
    .trimEnd();

  return [
    formatRow(header),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...tableRows.map((row) => formatRow(row, true)),
  ].join('\n');
}

function parseSubmodulePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
}

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

// ── 2. submodule init + harness sync ─────────────────────────────────────────
bold('[2/6] Initialising submodules');

// Never let git block on a TTY prompt (username/password) or shell out to a
// GUI credential helper (osxkeychain / manager-core). Submodule URLs in
// .gitmodules are relative — git expands them against the parent origin — so
// when the parent was HTTPS-cloned every private submodule fetch will drop
// into a credential prompt without these guards. Fail fast over silent hang.
// Full policy + branch matrix lives in scripts/lib/git-credential.ts.
const parentOrigin = (spawnSync('git', ['config', '--get', 'remote.origin.url'], {
  cwd: ROOT,
  encoding: 'utf8',
}).stdout ?? '').trim();
const cred = resolveCredentialConfig(parentOrigin, env, probeGitHubSsh);
const gitEnv: NodeJS.ProcessEnv = { ...hardenedGitEnv(env), ...cred.gitConfig };
const noCredHelper = [...NO_CRED_ARGV];
if (cred.branch === 'ssh-rewrite' || cred.branch === 'pat-rewrite') ok(cred.message!);
else if (cred.branch === 'loud-warn-no-cred') warnY(cred.message!);
const depth = env.FORGEAX_SUBMODULE_FULL === '1' ? [] : ['--depth', '1'];
{
  const paths = parseSubmodulePaths(
    execFileSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  );
  if (paths.length === 0) {
    setupResults.push({ repoType: 'submodule', repo: '(none)', result: 'skipped', detail: 'no submodules configured' });
  }
  for (const path of paths) {
    const r = spawnSync('git', [...noCredHelper, 'submodule', 'update', '--init', '--recursive', ...depth, '--', path], {
      stdio: 'inherit',
      cwd: ROOT,
      env: gitEnv,
    });
    setupResults.push({
      repoType: 'submodule',
      repo: path,
      result: (r.status ?? 1) === 0 ? 'ok' : 'failed',
      detail: (r.status ?? 1) === 0 ? 'ready' : `git submodule update exited ${r.status ?? 1}`,
    });
  }
}
const failedSubmodules = setupResults.filter((row) => row.result === 'failed');
if (failedSubmodules.length === 0) ok('submodules ready');
else warnY(`${failedSubmodules.length} submodule(s) failed; continuing and reporting at the end`);

// .forgeax-harness floating clone (non-fatal).
syncHarness(ROOT, '.forgeax-harness floating clone');
installHarnessSkills();
// engine harness sync now flows through the editor submodule (it carries the
// nested engine at packages/editor/packages/engine).
for (const sub of ['editor']) {
  if (existsSync(join(ROOT, 'packages', sub, 'scripts/sync-harness.mjs'))) {
    bold(`  → packages/${sub} harness sync`);
    spawnSync('node', ['scripts/sync-harness.mjs'], {
      stdio: 'inherit',
      cwd: join(ROOT, 'packages', sub),
      env: gitEnv,
    });
  }
}

// ── 3. engine submodule build ────────────────────────────────────────────────
bold('[3/6] Building engine submodule packages');
const engineDir = join(ROOT, 'packages/editor/packages/engine');
if (!existsSync(engineDir)) fail('packages/editor/packages/engine (editor nested engine) submodule missing — run git submodule update --init --recursive');

// The engine packages live in BOTH the engine's own pnpm workspace AND the
// studio-root bun workspace glob (root package.json → packages/editor/packages/
// engine/packages/*). A root `bun install` re-points each engine package's
// node_modules/* at bun's .bun store; if that install was ever interrupted the
// store is incomplete and those symlinks dangle. pnpm's `--frozen-lockfile`
// then reports "Already up to date" and does NOT repair them, so the engine
// build dies cryptically ("Could not resolve 'ajv-formats'"). Detect dangling
// per-package symlinks and drop the affected node_modules so the pnpm install
// below relinks them fresh from the intact .pnpm store.
function healDanglingEngineSymlinks(dir: string): void {
  const pkgsRoot = join(dir, 'packages');
  if (!existsSync(pkgsRoot)) return;
  let healed = 0;
  for (const e of readdirSync(pkgsRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const nm = join(pkgsRoot, e.name, 'node_modules');
    if (!existsSync(nm)) continue;
    const dangling = readdirSync(nm, { withFileTypes: true }).some(
      (d) => d.isSymbolicLink() && !existsSync(join(nm, d.name)), // existsSync follows the link → false if target gone
    );
    if (dangling) {
      rmSync(nm, { recursive: true, force: true });
      healed++;
    }
  }
  if (healed > 0) warnY(`engine: cleared ${healed} package node_modules with dangling symlinks (interrupted bun install) — pnpm will relink`);
}
healDanglingEngineSymlinks(engineDir);

// ── engine wasm provisioning: fetch prebuilt release BEFORE compiling ──────────
// The three engine wasm bundles (wgpu-wasm / fbx / codec) are gitignored
// zero-binary artifacts. Each ships a `fetch-wasm` script that pulls a
// content-keyed asset from the engine's `wasm-artifacts` GitHub Release, and a
// `build:wasm` script that compiles from source (Rust+wasm-pack / emcc). The
// release path is FAR more reliable than compiling: it downloads one prebuilt
// tarball from the Releases CDN, sidestepping (a) multi-minute -O3 emcc/Rust
// compiles and (b) the flaky per-file source downloads that compiling needs —
// e.g. fbx's fetch-ufbx hits raw.githubusercontent 429 rate-limits on the 1.2 MB
// ufbx.c. So for every wasm bundle we `tryFetchWasm()` first and only
// `build:wasm` on miss (no published asset for this pin, offline, or hash drift).
//
// The engine repo is private, so fetch-wasm needs a GitHub token. Resolve one
// from the env or the gh CLI once and thread it into each fetch attempt; without
// a token fetch 403s and we fall back to compiling (still correct, just slower).
function resolveGithubToken(): string | undefined {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  if (has('gh')) {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout?.trim()) return r.stdout.trim();
  }
  return undefined;
}
const githubToken = resolveGithubToken();

/**
 * Try to fetch a prebuilt wasm bundle from the wasm-artifacts release.
 * Returns true on success. Non-fatal: any failure (no token, offline, no
 * published asset for this content key) returns false so the caller compiles.
 */
function tryFetchWasm(pkgFilter: string, label: string): boolean {
  const fetchEnv = { ...process.env };
  if (githubToken) fetchEnv.GITHUB_TOKEN = githubToken;
  console.log(`  → ${label}: trying prebuilt release (fetch-wasm)…`);
  const okFetch = run('pnpm', ['-F', pkgFilter, 'fetch-wasm'], { cwd: engineDir, env: fetchEnv });
  if (okFetch) ok(`${label}: fetched prebuilt wasm from release`);
  else console.log(`  → ${label}: no prebuilt release available — will compile from source`);
  return okFetch;
}

// ── wgpu wasm binary (pkg/) — MUST exist before the engine `pnpm -r build` ─────
// The engine's wgpu-wasm package no longer commits pkg/ (zero-binary invariant:
// pkg/ is a gitignored wasm-pack artifact, built from Rust or fetched from the
// wasm-artifacts release). `@forgeax/engine-app`'s bundle imports
// `../pkg/wgpu_wasm.js` (via @forgeax/engine-wgpu-wasm's dist), so if pkg/ is
// absent when step [3] builds engine-app, esbuild fails "Could not resolve
// ../pkg/wgpu_wasm.js". Therefore build the binary in step [3a], BEFORE [3]'s
// package build — not after. (Older engine pins shipped a checked-in pkg/, which
// masked this ordering requirement.)
const wgpuDir = join(engineDir, 'packages/wgpu-wasm');
const wasmArtefact = join(wgpuDir, 'pkg/wgpu_wasm_bg.wasm');
const wasmSentinel = join(ROOT, '.forgeax/sentinels/wgpu-wasm.built');
const touchSentinel = () => {
  mkdirSync(dirname(wasmSentinel), { recursive: true });
  writeFileSync(wasmSentinel, '');
};
function buildWgpuWasm(): void {
  bold('[3a/6] Provisioning engine wgpu wasm binary');
  if (!wgpuWasmStale()) {
    ok(`wgpu wasm already built and fresh (skip) — ${wasmArtefact}`);
    if (!existsSync(wasmSentinel)) touchSentinel();
  } else if (tryFetchWasm('@forgeax/engine-wgpu-wasm', 'wgpu wasm')) {
    touchSentinel();
  } else if (!has('rustc') || !has('wasm-pack')) {
    warnY('Rust→wasm toolchain missing — skipping wgpu wasm build.');
    console.log('    The preview engine + engine-app build will fail until this is built (install rust + wasm-pack, then: pnpm -F @forgeax/engine-wgpu-wasm build:wasm)');
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
      warnY('wgpu wasm build failed — engine-app build + preview engine will not start until fixed.');
    }
  }
}

const skipEngineBuild =
  env.FORGEAX_SKIP_ENGINE_BUILD &&
  existsSync(join(engineDir, 'packages/app/dist')) &&
  existsSync(join(engineDir, 'packages/runtime/dist'));
if (skipEngineBuild) {
  if (!run('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDir })) fail('engine pnpm install failed (skip-build path).');
  ok('engine build skipped — FORGEAX_SKIP_ENGINE_BUILD set and dist/ present');
} else {
  if (!run('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDir })) fail('engine pnpm install failed.');
  // pkg/wgpu_wasm.js must exist before the engine-app bundle below imports it.
  buildWgpuWasm();
  const filters = [
    '@forgeax/engine-app...', '@forgeax/engine-runtime...', '@forgeax/engine-ecs...', '@forgeax/engine-types...',
    '@forgeax/engine-vite-plugin-shader...', '@forgeax/engine-vite-plugin-pack...', '@forgeax/engine-shader-compiler...',
    '@forgeax/engine-naga...', '@forgeax/engine-wgpu-wasm...', '@forgeax/engine-gltf...', '@forgeax/engine-image...',
    '@forgeax/engine-pack...', '@forgeax/engine-project...',
    // engine-fbx: editor-core's fbx-cook imports the ufbx WASM runtime
    // (initFbxWasm / parseFbx) + the parse-* helpers from it — the engine
    // collapsed the former engine-fbx-wasm package INTO engine-fbx (#603). Its
    // tsup dist must exist or the editor iframe 500s at load ("Failed to resolve
    // entry for package @forgeax/engine-fbx"). The wasm BINARY (pkg/fbx-wasm.
    // {mjs,wasm}) is built separately in step 3c below.
    '@forgeax/engine-fbx...',
    // engine-vite-plugin-rhi-debug: the editor's engine-vite-preset (studio's
    // vite.config imports it) unconditionally imports this plugin (editor #117
    // opt-in RHI-debug switch). Its exports point at ./dist/index.mjs, so the
    // dist must exist or the studio vite config load 500s with "Failed to
    // resolve entry for package @forgeax/engine-vite-plugin-rhi-debug".
    '@forgeax/engine-vite-plugin-rhi-debug...',
  ].flatMap((f) => ['--filter', f]);
  if (!run('pnpm', [...filters, '-r', 'build'], { cwd: engineDir })) fail('engine submodule build failed.');
  ok('engine packages built');
  // tsc -b emits the engine packages' dist/*.d.ts (the filtered tsup build above
  // is dts:false — declarations come exclusively from the composite tsc graph,
  // see engine tsup.base.ts §K-2). Editor's shared engine-shim now expects real
  // .d.ts for every engine package EXCEPT engine-project / engine-fbx
  // (which ship none via studio's tsup-only build); without this, the editor + studio typecheck
  // fan-out reds out at TS7016 / TS2709. Incremental (.tsbuildinfo) so re-runs
  // are near-instant. Non-fatal: a d.ts miss only breaks typecheck, not runtime
  // (vite strips types), so warn rather than abort the whole setup.
  //
  // Self-heal on stale/corrupt incremental cache: a `dist/.tsbuildinfo` left in a
  // bad state (e.g. after a TS-version swap, or an interrupted build) can wedge
  // `tsc -b` into "program needs to report errors" and make it treat its own
  // emitted `dist/*.d.ts` as inputs → TS5055 "would overwrite input file". CI never
  // hits this because it always runs `tsc -b --clean && tsc -b` (fresh); the local
  // incremental path can. So on failure, clean the composite outputs and retry once
  // — mirroring CI's clean-then-build. If it still fails, the error is real; warn.
  if (!run('pnpm', ['exec', 'tsc', '-b'], { cwd: engineDir })) {
    warnY('engine tsc -b failed — clearing incremental cache (tsc -b --clean) and retrying once…');
    run('pnpm', ['exec', 'tsc', '-b', '--clean'], { cwd: engineDir });
    if (!run('pnpm', ['exec', 'tsc', '-b'], { cwd: engineDir })) {
      warnY('engine tsc -b (d.ts generation) still failing after clean — typecheck will red out until fixed; runtime is unaffected.');
    } else {
      ok('engine .d.ts generated (tsc -b, after clean retry)');
    }
  } else {
    ok('engine .d.ts generated (tsc -b)');
  }
}

// wgpu wasm for the FORGEAX_SKIP_ENGINE_BUILD path: the else-branch above builds
// it before its package build, but the skip path doesn't run that. Ensure pkg/ is
// present (built/fetched) so the preview engine + any later app rebuild resolve it.
if (skipEngineBuild) buildWgpuWasm();

// ── 3c. fbx wasm ──────────────────────────────────────────────────────────────
// editor-core's fbx-cook needs pkg/fbx-wasm.mjs (the ufbx→wasm glue emitted by
// emcc), now lazy-imported by @forgeax/engine-fbx at initFbxWasm() time (the
// engine collapsed engine-fbx-wasm INTO engine-fbx, #603). Like wgpu-wasm, pkg/
// is gitignored (zero-binary invariant), so it must be built here or FBX import
// in the editor fails at runtime. build:wasm = fetch-ufbx (idempotent download of
// ufbx.c) + emcc compile → pkg/fbx-wasm.{mjs,wasm}.
bold('[3c/6] Provisioning engine fbx wasm binary');
const fbxWasmDir = join(engineDir, 'packages/fbx');
const fbxWasmMjs = join(fbxWasmDir, 'pkg/fbx-wasm.mjs');
const fbxWasmBin = join(fbxWasmDir, 'pkg/fbx-wasm.wasm');
if (existsSync(fbxWasmMjs) && existsSync(fbxWasmBin)) {
  ok(`fbx wasm already built (skip) — ${fbxWasmMjs}`);
} else if (tryFetchWasm('@forgeax/engine-fbx', 'fbx wasm')) {
  // fetched prebuilt release — no emcc compile, no flaky raw.githubusercontent
  // ufbx.c download (which 429-rate-limits; see the provisioning note above).
} else if (!has('emcc')) {
  warnY('Emscripten (emcc) missing — skipping fbx wasm build.');
  console.log('    FBX import in the editor will fail until this is built (brew install emscripten, then: pnpm -F @forgeax/engine-fbx build:wasm)');
} else {
  console.log(existsSync(fbxWasmBin) ? '  → fbx wasm stale — rebuilding' : '  → fbx wasm missing — building');
  if (run('pnpm', ['-F', '@forgeax/engine-fbx', 'build:wasm'], { cwd: engineDir })) {
    ok(`fbx wasm built — ${fbxWasmMjs}`);
  } else {
    warnY('fbx wasm build failed — FBX import in the editor will not work until fixed.');
  }
}

// ── 3d. codec (basis) wasm ─────────────────────────────────────────────────────
// @forgeax/engine-codec needs pkg/basis_transcoder.{mjs,wasm} +
// pkg/encode/basis_encoder.{mjs,wasm} — the KTX2/BasisU transcoder + encoder,
// emcc-compiled from the pinned basis_universal source (fetch-basis + build-wasm).
// This is the HEAVIEST engine wasm compile (~30 encoder C++ units at -O3, several
// minutes), so the release-fetch path matters most here. pkg/ is gitignored
// (zero-binary invariant), so provision it or asset compression / KTX2 loading
// fails at runtime. Same fetch-first-then-compile shape as wgpu/fbx above.
bold('[3d/6] Provisioning engine codec (basis) wasm binary');
const codecDir = join(engineDir, 'packages/codec');
const codecTranscoderWasm = join(codecDir, 'pkg/basis_transcoder.wasm');
const codecEncoderWasm = join(codecDir, 'pkg/encode/basis_encoder.wasm');
if (existsSync(codecTranscoderWasm) && existsSync(codecEncoderWasm)) {
  ok(`codec wasm already built (skip) — ${codecTranscoderWasm}`);
} else if (tryFetchWasm('@forgeax/engine-codec', 'codec wasm')) {
  // fetched prebuilt release — skips the multi-minute -O3 basis encoder compile.
} else if (!has('emcc')) {
  warnY('Emscripten (emcc) missing — skipping codec wasm build.');
  console.log('    Asset compression / KTX2 loading will fail until this is built (brew install emscripten, then: pnpm -F @forgeax/engine-codec build:wasm)');
} else {
  console.log(existsSync(codecTranscoderWasm) ? '  → codec wasm stale — rebuilding' : '  → codec wasm missing — building');
  if (run('pnpm', ['-F', '@forgeax/engine-codec', 'build:wasm'], { cwd: engineDir })) {
    ok(`codec wasm built — ${codecTranscoderWasm}`);
  } else {
    warnY('codec wasm build failed — asset compression / KTX2 loading will not work until fixed.');
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
const setupFailed = setupResults.some((row) => row.result === 'failed');
bold(setupFailed ? 'Setup completed with failures.' : 'Setup complete.');
if (setupResults.length > 0) {
  console.log();
  bold('[setup] submodule result report');
  console.log(formatSetupReport(setupResults));
}
if (setupFailed) {
  console.error('[setup] one or more submodules failed to update; see report above');
  process.exit(1);
}
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
  const r = spawnSync('node', [join(cwd, 'scripts/sync-harness.mjs')], { stdio: 'inherit', cwd, env: gitEnv });
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
