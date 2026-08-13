#!/usr/bin/env bun
// @ts-nocheck
// scripts/prepare.ts — forgeax-studio post-install prepare (`bun run prepare` /
// package.json "prepare" lifecycle after `bun install`).
// Idempotent — re-running picks up where it left off.
//
// Steps: [0] prereq gate · [1] submodule init+floating consumer sync · [2] engine pnpm
// build · [2a] wgpu wasm · [2c] fbx wasm · [2d] codec wasm · [3] marketplace
// plugin install+build · [4] .env scaffold · [5] seed sample games.
//
// Env: FORGEAX_SKIP_PREPARE · FORGEAX_FORCE_PREPARE · FORGEAX_SKIP_PLUGINS ·
// FORGEAX_SKIP_ENGINE_BUILD · FORGEAX_SUBMODULE_FULL · FORGEAX_SKIP_HARNESS_SYNC ·
// FORGEAX_SKIP_SUBMODULE_INIT · FORGEAX_SKIP_HARNESS · FORGEAX_SKIP_GAMES ·
// FORGEAX_SKIP_BOOTSTRAP · FORGEAX_SKIP_CONTRACTS_BUILD ·
// FORGEAX_BOOTSTRAP_YES

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_ENTRY_OUTPUTS, isEngineEntryDistFresh } from './lib/engine-entry-freshness.ts';
import {
  extensionPackageManager,
  extensionPackageManagerFallback,
} from './lib/extension-build.ts';
import { has, resolvePython, run } from './lib/sh.ts';
import { hardenedGitEnv, NO_CRED_ARGV, probeGitHubSsh, resolveCredentialConfig } from './lib/git-credential.ts';
import { repairPluginDirectoryLink } from './lib/plugin-directory-links.ts';
import { mapConcurrent, positiveConcurrency, runCommandBuffered } from './lib/process-pool.ts';
import { ensureWorkspacePackageLink } from './lib/workspace-package-link.ts';
import { buildEnginePackages, PREPARE_ENGINE_BUILD_FILTERS } from './ci/build-engine-packages.ts';
import { ensureEngineWgpuWasm } from './ci/ensure-engine-wgpu-wasm.ts';
import {
  createRecursiveInputResult,
  projectGitlinkGraph,
  readAuthoritativeGitGraph,
  type InputClass,
  type RecursiveInputResult,
} from '../packages/recursive-input-contract/src/index.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAYWRIGHT_DOWNLOAD_MIRROR = 'https://cdn.npmmirror.com/binaries/playwright';

const PREPARE_INPUT_CLASSES: InputClass[] = [
  'source',
  'dependency-installation',
  'toolchain',
  'large-file-storage',
];

function recursiveInputResultPath(root: string): string {
  return join(root, '.forgeax', 'recursive-input-result.json');
}

function writeRecursiveInputResult(root: string): RecursiveInputResult {
  const graph = projectGitlinkGraph(readAuthoritativeGitGraph(root));
  const notReady = prepareResults.some((row) => row.result === 'failed') || graph.unreachablePaths.length > 0;
  const result = createRecursiveInputResult({
    graph,
    producer: 'bun-prepare',
    job: 'prepare',
    attempt: `prepare-${Date.now()}`,
    trustScope: 'local-fixed-worktree',
    requestedInputClasses: PREPARE_INPUT_CLASSES,
    readiness: notReady
      ? {
          source: { status: graph.unreachablePaths.length > 0 ? 'unavailable' : 'partial' },
          'dependency-installation': { status: 'partial' },
          toolchain: { status: 'partial' },
          'large-file-storage': { status: 'partial' },
        }
      : undefined,
    failure: notReady
      ? {
          code: 'recursive-input.materialization-incomplete',
          hint: 'Discard the partial checkout and retry the complete input request cold.',
          expected: 'submodules, dependencies, toolchain, and large-file-storage ready',
          actual: graph.unreachablePaths.length > 0
            ? `unreachable recursive pins: ${graph.unreachablePaths.join(',')}`
            : 'prepare reported one or more failed stages',
          retryable: true,
          recoveryActions: ['discard-partial-state', 'retry-cold'],
        }
      : undefined,
  });
  mkdirSync(join(root, '.forgeax'), { recursive: true });
  const path = recursiveInputResultPath(root);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
  return result;
}

if (process.env.FORGEAX_SKIP_PREPARE === '1') {
  console.log('[prepare] skipped (FORGEAX_SKIP_PREPARE=1)');
  process.exit(0);
}
const force = process.env.FORGEAX_FORCE_PREPARE === '1';
const skipPlugins = process.env.FORGEAX_SKIP_PLUGINS === '1';
const skipSubmoduleInit = process.env.FORGEAX_SKIP_SUBMODULE_INIT === '1';
const requireCompleteSetup = process.env.FORGEAX_REQUIRE_COMPLETE_SETUP === '1';
// The public mirror deliberately excludes the private, development-only harness
// repositories. The marker is assembled into every public repository so this
// remains true for a recursive clone and for an independently cloned child.
const publicDistribution = existsSync(join(ROOT, '.forgeax-public-distribution'));


const bold = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const warnY = (s: string) => console.log(`\x1b[33m⚠ ${s}\x1b[0m`);
const fail = (s: string): never => {
  console.error(`\x1b[1;31m✗ ${s}\x1b[0m`);
  process.exit(1);
};

type PrepareResult = {
  repoType: 'submodule';
  repo: string;
  result: 'ok' | 'failed' | 'skipped';
  detail?: string;
};

const prepareResults: PrepareResult[] = [];

function cleanTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function colorResult(result: string): string {
  if (result === 'OK') return `\x1b[32m${result}\x1b[0m`;
  if (result === 'FAILED') return `\x1b[31m${result}\x1b[0m`;
  return result;
}

function formatPrepareReport(rows: PrepareResult[]): string {
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

for (const a of process.argv.slice(2)) {
  if (a === '-h' || a === '--help') {
    console.log(`Usage: bun run prepare  |  bun scripts/prepare.ts

Env:
  FORGEAX_SKIP_PREPARE=1       skip entirely (exit 0)
  FORGEAX_FORCE_PREPARE=1      rebuild even when dists look fresh
  FORGEAX_SKIP_PLUGINS=1       skip marketplace plugin install+build
  FORGEAX_SKIP_ENGINE_BUILD=1  skip engine package build when dist/ present
  FORGEAX_SUBMODULE_FULL=1     full (non-shallow) submodule clone
  FORGEAX_SKIP_SUBMODULE_INIT=1
                                trust a preceding worktree bootstrap's recursive materialization
  FORGEAX_SKIP_HARNESS_SYNC=1  skip .forgeax-harness floating-clone sync
  FORGEAX_SKIP_HARNESS=1       skip harness sync + skill install entirely (CI)
  FORGEAX_SKIP_GAMES=1         skip optional forgeax-games checkout + sample seeding (CI)
  FORGEAX_SKIP_BOOTSTRAP=1     skip toolchain provisioning (node/pnpm/rust) — CI
  FORGEAX_BOOTSTRAP_YES=1      auto-accept toolchain installs (non-interactive)
  FORGEAX_PLUGIN_BUILD_CONCURRENCY=N
                                parallel plugin builds (default 2; installs stay serial)
`);
    process.exit(0);
  } else fail(`unknown arg: ${a}`);
}

const env = { ...process.env };
const commandTrace = env.FORGEAX_COMMAND_TRACE === '1';

// ── 0. toolchain (provision if missing, then verify) ──────────────────────────
bold('[0/5] Toolchain (provision + verify)');
// Provision node22 / pnpm / rust+wasm-pack via bootstrap.ts when missing.
// Idempotent: already-present tools are detected and skipped. Interactive on a
// TTY (set FORGEAX_BOOTSTRAP_YES=1 for auto-yes); a non-interactive shell skips
// installs and falls through to the hard gate below (fail-fast with guidance).
// CI provisions its own toolchain via workflow steps and sets
// FORGEAX_SKIP_BOOTSTRAP=1 to bypass this.
if (process.env.FORGEAX_SKIP_BOOTSTRAP !== '1') {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/bootstrap.ts'), '--toolchain-only'], {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });
  if (r.status !== 0) fail('toolchain provisioning failed (bootstrap.ts --toolchain-only)');
}
// Hard gate backstop: anything still missing (e.g. an install was declined) stops here.
if (!has('git')) fail('git not found.');
if (!has('bun')) fail('bun not found. Install: https://bun.sh');
if (!has('node')) fail('node not found. Install Node 22+.');
if (!has('pnpm')) fail('pnpm not found. Install: https://pnpm.io/installation');
const nodeMajor = Number.parseInt(
  execFileSync('node', ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '').split('.')[0] ?? '0',
  10,
);
if (nodeMajor < 22) fail(`Node ${nodeMajor} found; forgeax-server needs ≥22.`);
ok(`git + bun + pnpm + node v${nodeMajor} present`);

// ── 2. submodule init + floating harness sync ────────────────────────────────
bold('[1/5] Initialising submodules');

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
const cred = publicDistribution
  ? { branch: 'noop-parent-is-not-https' as const, gitConfig: {} }
  : resolveCredentialConfig(parentOrigin, env, probeGitHubSsh);
const gitEnv: NodeJS.ProcessEnv = normalizePackageManagerRegistry({
  ...hardenedGitEnv(env),
  ...cred.gitConfig,
});
const noCredHelper = [...NO_CRED_ARGV];
if (cred.branch === 'ssh-rewrite' || cred.branch === 'pat-rewrite') ok(cred.message!);
else if (cred.branch === 'loud-warn-no-cred') warnY(cred.message!);
const depth = env.FORGEAX_SUBMODULE_FULL === '1' ? [] : ['--depth', '1'];
if (skipSubmoduleInit) {
  prepareResults.push({
    repoType: 'submodule',
    repo: '(recursive graph)',
    result: 'skipped',
    detail: 'materialized by bun fx worktree',
  });
  ok('submodules already materialized by worktree bootstrap');
} else if (publicDistribution) {
  // The public superproject is assembled as an already-complete recursive
  // clone. Re-initialising submodules here is both redundant and invalid for
  // the mirror smoke's filesystem overlay (which intentionally has no .git).
  ok('public distribution submodules supplied by recursive clone');
} else {
  const paths = parseSubmodulePaths(
    execFileSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  );
  if (paths.length === 0) {
    prepareResults.push({ repoType: 'submodule', repo: '(none)', result: 'skipped', detail: 'no submodules configured' });
  }
  for (const path of paths) {
    const started = performance.now();
    if (commandTrace) console.log(`[submodule:start] path=${path}`);
    const r = spawnSync('git', [...noCredHelper, 'submodule', 'update', '--init', '--recursive', ...depth, '--', path], {
      stdio: 'inherit',
      cwd: ROOT,
      env: gitEnv,
    });
    const duration = Math.round(performance.now() - started);
    const status = r.status ?? 1;
    if (commandTrace) console.log(`[submodule:end] path=${path} exit=${status} duration_ms=${duration}`);
    prepareResults.push({
      repoType: 'submodule',
      repo: path,
      result: status === 0 ? 'ok' : 'failed',
      detail: status === 0 ? `ready (${duration}ms)` : `git submodule update exited ${status} (${duration}ms)`,
    });
  }
}
const failedSubmodules = prepareResults.filter((row) => row.result === 'failed');
if (!publicDistribution) {
  if (failedSubmodules.length === 0) ok('submodules ready');
  else warnY(`${failedSubmodules.length} submodule(s) failed; continuing and reporting at the end`);
}

// Install repo githooks so a plain `git pull` materialises new submodule
// workspaces before the next `bun install` (bun resolves workspaces pre-prepare).
{
  const hooksPath = join(ROOT, '.githooks');
  if (existsSync(join(hooksPath, 'post-merge'))) {
    try {
      const current = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim();
      if (current !== '.githooks') {
        warnY(`core.hooksPath already set to ${current}; leave as-is (expected .githooks)`);
      }
    } catch {
      spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      ok('git hooks → .githooks (post-merge/post-checkout sync submodules)');
    }
  }
}

// The CLI consumes the in-workspace @forgeax/types and @forgeax/agent-runtime
// packages. Build their exported dist files first: once Studio pins contracts
// 0.1.1+, Bun correctly links those workspaces instead of retaining nested npm
// copies, so the CLI can no longer rely on a downloaded package's prebuilt dist.
{
  bold('[1b/5] Building shared contracts');
  const contractsDir = join(ROOT, 'packages/contracts');
  const typesDist = join(contractsDir, 'types/dist/permission-rules.js');
  const runtimeDist = join(contractsDir, 'agent-runtime/dist/index.js');
  if (!existsSync(join(contractsDir, 'package.json'))) {
    warnY('packages/contracts missing — skip shared contracts build');
  } else if (
    existsSync(typesDist)
    && existsSync(runtimeDist)
    && process.env.FORGEAX_FORCE_PREPARE !== '1'
  ) {
    ok('shared contracts dist present');
  } else {
    const r = spawnSync('node', ['scripts/build-packages.mjs'], {
      cwd: contractsDir,
      stdio: 'inherit',
      env: { ...env, FORGEAX_SKIP_PREPARE: '1' },
    });
    if ((r.status ?? 1) !== 0 || !existsSync(typesDist) || !existsSync(runtimeDist)) {
      fail('shared contracts build failed — @forgeax/cli dependencies are unavailable');
    }
    ok('shared contracts built');
  }
}

// @forgeax/cli ships as a self-contained tarball: package.json `exports["./serve"]`
// points at dist/cli/main.js. Server resolves that path to spawn the kernel
// sidecar. Without a build, import.meta.resolve('@forgeax/cli/serve') fails and
// chat stalls with "no first token / kernel=unknown".
{
  bold('[1c/5] Building @forgeax/cli (serve entry)');
  const cliDir = join(ROOT, 'packages/cli');
  const serveDist = join(cliDir, 'dist/cli/main.js');
  const skipCliBuild = process.env.FORGEAX_SKIP_CLI_BUILD === '1';
  if (skipCliBuild) {
    console.log('  → skipped (FORGEAX_SKIP_CLI_BUILD=1)');
  } else if (!existsSync(join(cliDir, 'package.json'))) {
    warnY('packages/cli missing — skip @forgeax/cli build');
  } else if (existsSync(serveDist) && process.env.FORGEAX_FORCE_PREPARE !== '1') {
    ok('@forgeax/cli dist/cli/main.js present');
  } else {
    const r = spawnSync('bun', ['run', 'build'], {
      cwd: cliDir,
      stdio: 'inherit',
      env: { ...env, FORGEAX_SKIP_PREPARE: '1' },
    });
    if ((r.status ?? 1) !== 0 || !existsSync(serveDist)) {
      fail('@forgeax/cli build failed — chat kernel serve entry missing (dist/cli/main.js)');
    }
    ok('@forgeax/cli built (dist/cli/main.js)');
  }
  if (requireCompleteSetup && !existsSync(serveDist)) {
    fail(`required CLI artefact missing after prepare: ${serveDist}`);
  }
}

// .forgeax-harness floating state clone + package harness + skill install.
// Dev-only convenience —
// gate behind FORGEAX_SKIP_HARNESS so CI and bare `bun install` (which triggers
// prepare on every run) don't re-clone the harness + re-run the Python skill
// install into the agent dirs each time. Non-fatal either way.
if (process.env.FORGEAX_SKIP_HARNESS === '1' || publicDistribution) {
  console.log(`  → harness sync + skill-install skipped (${publicDistribution ? 'public distribution' : 'FORGEAX_SKIP_HARNESS=1'})`);
} else {
  syncHarness(ROOT, '.forgeax-harness floating clone');
  syncPackageHarness();
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
}

// forgeax-games is an optional consumer checkout. Studio can be installed and
// can create engine-template games without it; local game-library work opts in
// through this floating checkout, while CI explicitly disables the network pull.
if (process.env.FORGEAX_SKIP_GAMES === '1' || publicDistribution) {
  console.log(`  → games floating checkout skipped (${publicDistribution ? 'public distribution' : 'FORGEAX_SKIP_GAMES=1'})`);
} else {
  syncGames();
}

// ── 3. engine submodule build ────────────────────────────────────────────────
if (publicDistribution) {
  // The mirrored source ships the engine's emitted dist files but deliberately
  // excludes private release credentials and source-built WASM artifacts. A
  // public `bun install` must therefore consume that published output, not try
  // to rebuild the engine (which would require Rust/wasm-pack).
  console.log('  → public distribution — skip engine package + WASM builds');
} else {
bold('[2/5] Building engine submodule packages');
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
// The wgpu fetch/compile/output gate is shared with Runtime release CI in
// scripts/ci/ensure-engine-wgpu-wasm.ts; fbx and codec keep their package-local
// provisioning below because they have different native toolchain needs.
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
// absent when step [2] builds engine-app, esbuild fails "Could not resolve
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
function wgpuWasmStale(): boolean {
  const wgpuJs = join(wgpuDir, 'pkg/wgpu_wasm.js');
  // An INCOMPLETE pkg/ counts as stale. engine-app's bundle imports
  // `../pkg/wgpu_wasm.js` (the JS glue), so a pkg/ that has wgpu_wasm_bg.wasm
  // but not wgpu_wasm.js (a partial fetch/extract, or an interrupted build) must
  // NOT be treated as fresh — otherwise buildWgpuWasm skips and the engine build
  // dies on "Could not resolve ../pkg/wgpu_wasm.js". Gate on BOTH files.
  if (!existsSync(wasmArtefact) || !existsSync(wgpuJs)) return true;
  const anchorMs = (existsSync(wasmSentinel) ? statSync(wasmSentinel) : statSync(wasmArtefact)).mtimeMs;
  for (const c of [join(wgpuDir, 'Cargo.toml'), join(wgpuDir, 'Cargo.lock'), wgpuJs]) {
    if (existsSync(c) && statSync(c).mtimeMs > anchorMs) return true;
  }
  return existsSync(join(wgpuDir, 'src')) && anyNewerThan(join(wgpuDir, 'src'), anchorMs);
}
function buildWgpuWasm(): void {
  bold('[2a/5] Provisioning engine wgpu wasm binary');
  if (!force && !wgpuWasmStale()) {
    ok(`wgpu wasm already built and fresh (skip) — ${wasmArtefact}`);
    if (!existsSync(wasmSentinel)) touchSentinel();
  } else {
    const stale = force || wgpuWasmStale();
    const provisioned = ensureEngineWgpuWasm({
      root: ROOT,
      engineRoot: engineDir,
      force: stale,
      strict: requireCompleteSetup,
      env,
    });
    if (provisioned) {
      touchSentinel();
      ok(`wgpu wasm built — ${wasmArtefact}`);
    }
  }
}

// These packages are imported while loading the Studio Vite config. They must be
// fresh even when the normal app/runtime entry checks would otherwise skip the
// filtered engine build.
// These packages are also imported by the copied game template. Keep them in
// the cache-hit freshness gate so a new template dependency cannot be hidden
// by an older engine-dist cache.
const engineEntryPkgs = [
  'app',
  'runtime',
  'ecs',
  'net',
  'font',
  'assets-runtime',
  'npc',
  'vfx',
  'vfx-compiler',
  'vfx-render',
  'vite-plugin-pack',
  'vite-plugin-shader',
];
const enginePkgDir = join(engineDir, 'packages');
const engineDeclarationSentinel = join(ROOT, '.forgeax/sentinels/engine-declarations.built');
const engineEntryDistsFresh = (): boolean => engineEntryPkgs.every((p) => {
  const pdir = join(enginePkgDir, p);
  return isEngineEntryDistFresh(pdir, engineDeclarationSentinel);
});
const skipEngineBuild =
  !force &&
  // CI's cached engine dist is safe to skip only when EVERY Vite-config entry
  // remains present and fresh. Checking app/runtime alone let a newly imported
  // package (font/assets-runtime) reach Studio's config without its emitted
  // `.mjs` entry.
  engineEntryDistsFresh();
if (skipEngineBuild) {
  if (!run('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDir })) fail('engine pnpm install failed (skip-build path).');
  ok('engine build skipped — Vite-config entry dists fresh');
} else {
  if (!run('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDir })) fail('engine pnpm install failed.');
  // pkg/wgpu_wasm.js must exist before the engine-app bundle below imports it.
  buildWgpuWasm();
  if (!buildEnginePackages({ engineRoot: engineDir, filters: PREPARE_ENGINE_BUILD_FILTERS }))
    fail('engine submodule build failed.');
  ok('engine packages built');
  // tsc -b emits the engine packages' dist/*.d.ts (the filtered tsup build above
  // is dts:false — declarations come exclusively from the composite tsc graph,
  // see engine tsup.base.ts §K-2). Editor's shared engine-shim now expects real
  // .d.ts for every engine package EXCEPT engine-project / engine-fbx
  // (which ship none via studio's tsup-only build); without this, the editor + studio typecheck
  // fan-out reds out at TS7016 / TS2709. Incremental (.tsbuildinfo) so re-runs
  // are near-instant. Non-fatal: a d.ts miss only breaks typecheck, not runtime
  // (vite strips types), so warn rather than abort the whole prepare.
  //
  // Self-heal on stale/corrupt incremental cache: a `dist/.tsbuildinfo` left in a
  // bad state (e.g. after a TS-version swap, or an interrupted build) can wedge
  // `tsc -b` into "program needs to report errors" and make it treat its own
  // emitted `dist/*.d.ts` as inputs → TS5055 "would overwrite input file". CI never
  // hits this because it always runs `tsc -b --clean && tsc -b` (fresh); the local
  // incremental path can. So on failure, clean the composite outputs and retry once
  // — mirroring CI's clean-then-build. If it still fails, the error is real; warn.
  let declarationsBuilt = run('pnpm', ['exec', 'tsc', '-b'], { cwd: engineDir });
  if (!declarationsBuilt) {
    warnY('engine tsc -b failed — clearing incremental cache (tsc -b --clean) and retrying once…');
    run('pnpm', ['exec', 'tsc', '-b', '--clean'], { cwd: engineDir });
    declarationsBuilt = run('pnpm', ['exec', 'tsc', '-b'], { cwd: engineDir });
    if (!declarationsBuilt) {
      warnY('engine tsc -b (d.ts generation) still failing after clean — typecheck will red out until fixed; runtime is unaffected.');
    } else {
      ok('engine .d.ts generated (tsc -b, after clean retry)');
    }
  } else {
    ok('engine .d.ts generated (tsc -b)');
  }
  if (declarationsBuilt) {
    mkdirSync(dirname(engineDeclarationSentinel), { recursive: true });
    writeFileSync(engineDeclarationSentinel, `${new Date().toISOString()}\n`);
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
bold('[2c/5] Provisioning engine fbx wasm binary');
const fbxWasmDir = join(engineDir, 'packages/fbx');
const fbxWasmMjs = join(fbxWasmDir, 'pkg/fbx-wasm.mjs');
const fbxWasmBin = join(fbxWasmDir, 'pkg/fbx-wasm.wasm');
if (!force && existsSync(fbxWasmMjs) && existsSync(fbxWasmBin)) {
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
bold('[2d/5] Provisioning engine codec (basis) wasm binary');
const codecDir = join(engineDir, 'packages/codec');
const codecTranscoderWasm = join(codecDir, 'pkg/basis_transcoder.wasm');
const codecTranscoderMjs = join(codecDir, 'pkg/basis_transcoder.mjs');
const codecEncoderWasm = join(codecDir, 'pkg/encode/basis_encoder.wasm');
const codecEncoderMjs = join(codecDir, 'pkg/encode/basis_encoder.mjs');
// Gate on the .mjs glue too, not just the .wasm — engine-codec imports the mjs
// loaders, so a pkg/ with the .wasm but a missing .mjs (partial provision) must
// re-provision instead of being treated as fresh (same trap as wgpu above).
if (
  !force &&
  existsSync(codecTranscoderWasm) &&
  existsSync(codecTranscoderMjs) &&
  existsSync(codecEncoderWasm) &&
  existsSync(codecEncoderMjs)
) {
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

const missingEngineArtifacts = [
  wasmArtefact,
  join(wgpuDir, 'pkg/wgpu_wasm.js'),
  fbxWasmMjs,
  fbxWasmBin,
  codecTranscoderWasm,
  codecTranscoderMjs,
  codecEncoderWasm,
  codecEncoderMjs,
  ...engineEntryPkgs.flatMap((name) =>
    ENGINE_ENTRY_OUTPUTS.map((output) => join(enginePkgDir, name, 'dist', output))),
  join(enginePkgDir, 'net-websocket', 'dist', 'browser.mjs'),
  join(enginePkgDir, 'net-websocket', 'dist', 'node.mjs'),
].filter((path) => !existsSync(path));
if (requireCompleteSetup && missingEngineArtifacts.length > 0) {
  fail(`required engine artefacts missing after prepare:\n${missingEngineArtifacts.map((path) => `  - ${path}`).join('\n')}`);
}

}

// ── 2e. Workspace @forgeax dedupe symlinks ──────────────────────────────────
// Vite's resolve.dedupe (studio vite.config.ts) resolves the whole @forgeax
// family from the Studio root's node_modules. bun's workspace linker only
// creates symlinks for DIRECT deps there; transitive workspace deps
// (engine-runtime, engine-ecs, editor-core, …) are absent. When dedupe can't
// find a package, game-file imports resolve a second module instance → ECS
// component identity splits (e.g. Camera spawned by the game !== the Camera
// the editor queries for) → "no Camera entity in play world". A worktree root
// can also fall through to the parent checkout's node_modules, so repair both
// @forgeax scopes against the packages in this worktree.
{
  const forgeaxLinkRoots = [
    { label: 'root', path: join(ROOT, 'node_modules/@forgeax') },
    { label: 'Studio', path: join(ROOT, 'packages/studio/node_modules/@forgeax') },
  ];
  const isWin = process.platform === 'win32';
  const packageParents = [
    join(ROOT, 'packages/editor/packages/engine/packages'),
    join(ROOT, 'packages/editor/packages'),
  ];

  for (const { label, path: forgeaxNm } of forgeaxLinkRoots) {
    if (!existsSync(dirname(forgeaxNm))) continue;
    mkdirSync(forgeaxNm, { recursive: true });
    let linked = 0;
    let relinked = 0;

    const scanDir = (parent: string): void => {
      if (!existsSync(parent)) return;
      for (const e of readdirSync(parent, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const pkgJsonPath = join(parent, e.name, 'package.json');
        if (!existsSync(pkgJsonPath)) continue;
        const pkg = readJson(pkgJsonPath) as { name?: string } | null;
        if (!pkg?.name?.startsWith('@forgeax/')) continue;
        const shortName = pkg.name.slice('@forgeax/'.length);
        const linkPath = join(forgeaxNm, shortName);
        try {
          const result = ensureWorkspacePackageLink(linkPath, join(parent, e.name), ROOT, isWin);
          if (result === 'linked') linked++;
          else if (result === 'relinked') relinked++;
          else if (result === 'occupied') {
            warnY(`dedupe package ${shortName}: existing path is not a symlink; leaving it unchanged`);
          }
        } catch (err) {
          warnY(`dedupe symlink ${shortName}: ${err}`);
        }
      }
    };

    for (const parent of packageParents) scanDir(parent);

    if (linked > 0 || relinked > 0) {
      ok(`${label} @forgeax dedupe symlinks ready (${linked} linked, ${relinked} repaired)`);
    } else ok(`${label} @forgeax dedupe symlinks already complete`);
  }
}

// ── 5. plugin install + build ─────────────────────────────────────────────────
bold('[3/5] Installing + building marketplace plugins');
if (skipPlugins) {
  console.log('  (skipped — FORGEAX_SKIP_PLUGINS=1)');
} else {
  const pluginsDir = join(ROOT, 'packages/marketplace/extensions');
  const sharedPackagesDir = join(pluginsDir, '_shared');
  const builds: Array<{ name: string; dir: string }> = [];
  for (const e of existsSync(sharedPackagesDir) ? readdirSync(sharedPackagesDir, { withFileTypes: true }) : []) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const d = join(sharedPackagesDir, e.name);
    if (existsSync(join(d, 'package.json'))) installDir(d);
  }
  for (const e of existsSync(pluginsDir) ? readdirSync(pluginsDir, { withFileTypes: true }) : []) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === '_template') continue;
    const d = join(pluginsDir, e.name);
    const repairedTarget = repairPluginDirectoryLink(d);
    if (repairedTarget) console.log(`  → repaired plugin directory link (${e.name} → ${repairedTarget})`);
    if (!existsSync(join(d, 'package.json'))) continue;
    const pkg = readJson(join(d, 'package.json')) as {
      packageManager?: string;
      scripts?: Record<string, string>;
    } | null;
    if (resolvePluginPackageManager(d, pkg, e.name) === 'pnpm') {
      installPnpmDir(d);
    } else {
      installDir(d);
    }
    ensurePluginPlaywrightBrowsers(d, e.name);

    if (pkg?.scripts?.build) {
      if (!force && pluginBuildFresh(d)) ok(`${e.name}  build cache fresh, skip`);
      else builds.push({ name: e.name, dir: d });
    }
  }

  if (builds.length > 0) {
    const concurrency = positiveConcurrency(
      process.env.FORGEAX_PLUGIN_BUILD_CONCURRENCY,
      2,
      'FORGEAX_PLUGIN_BUILD_CONCURRENCY',
    );
    console.log(`  → building ${builds.length} plugin(s), concurrency=${concurrency}`);
    const results = await mapConcurrent(builds, concurrency, async (build) => ({
      build,
      result: await runCommandBuffered('bun', ['run', 'build'], {
        cwd: build.dir,
        env,
      }),
    }));
    const failures: string[] = [];
    for (const { build, result } of results) {
      console.log(`::group::plugin build ${build.name}`);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stdout.write(result.stderr);
      if (result.error) console.error(result.error.message);
      if (result.status === 0) ok(`${build.name}  built`);
      else {
        failures.push(build.name);
        console.error(
          `${build.name} build failed (${result.status === null ? 'spawn error' : `exit ${result.status}`})`,
        );
      }
      console.log('::endgroup::');
    }
    if (failures.length > 0) fail(`plugin build failed: ${failures.join(', ')}`);
  }
}

// ── 6. .env scaffold ──────────────────────────────────────────────────────────
bold('[4/5] Configuring $ROOT/.env');
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
  warnY('ANTHROPIC_API_KEY not set in ' + envFile + ' — edit it before chatting in Studio.');
} else {
  ok('ANTHROPIC_API_KEY already set');
}

// ── 7. seed sample games ──────────────────────────────────────────────────────
console.log();
bold('[5/5] Seeding sample games to .forgeax/games/');
// SSOT: defer to scripts/seed-games.ts (symlink each shared-library game into
// .forgeax/games/<slug>). This is the SAME path run.ts and the desktop .app's
// Rust seed_shared_games use — one algorithm, symlinks only, idempotent. Do NOT
// cpSync real dirs here: a real <slug> dir shadows the shared library, and
// seed-games would later rename it to <slug>.bak-<ts>, piling up duplicates.
const gamesSrc = join(ROOT, 'packages/games');
const gamesDst = join(ROOT, '.forgeax/games');
mkdirSync(gamesDst, { recursive: true });
if (process.env.FORGEAX_SKIP_GAMES === '1') {
  console.log('  → skipped (FORGEAX_SKIP_GAMES=1)');
} else if (existsSync(gamesSrc) && readdirSync(gamesSrc).length > 0) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/seed-games.ts')], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, FORGEAX_GAMES_SRC: gamesSrc, FORGEAX_GAMES_DST: gamesDst },
  });
  if (r.status !== 0) warnY('seed-games failed (continuing without shared games)');
  else ok('sample games seeded (symlinks)');
  const soulsDst = join(ROOT, '.forgeax/souls-builtin');
  mkdirSync(soulsDst, { recursive: true });
  const souls = spawnSync(process.execPath, [join(ROOT, 'scripts/seed-souls.ts')], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, FORGEAX_GAMES_SRC: gamesSrc, FORGEAX_SOULS_DST: soulsDst },
  });
  if (souls.status !== 0) warnY('seed-souls failed (continuing without shared Soul packs)');
  else ok('shared Soul packs seeded (symlinks)');
} else {
  console.log('  → packages/games not found (skipped)');
}

console.log();
const prepareFailed = prepareResults.some((row) => row.result === 'failed');
bold(prepareFailed ? 'Prepare completed with failures.' : 'Prepare complete.');
if (prepareResults.length > 0) {
  console.log();
  bold('[prepare] submodule result report');
  console.log(formatPrepareReport(prepareResults));
}
if (publicDistribution) {
  console.log('[prepare] recursive input result skipped (public distribution has no Git metadata)');
} else {
  try {
    const result = writeRecursiveInputResult(ROOT);
    console.log(`[prepare] recorded recursive input ${result.status}`);
  } catch (error) {
    fail(`could not record recursive input: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (prepareFailed) {
  console.error('[prepare] one or more submodules failed to update; see report above');
  process.exit(1);
}
console.log('Next:\n  bun fx start');
console.log('Endpoints once running:\n  http://localhost:18920  Studio UI\n  http://localhost:18900  Server\n  http://localhost:15173  Engine');

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * pnpm 9 reads the npm-compatible registry variable while newer pnpm versions
 * also accept PNPM_CONFIG_REGISTRY. Mirror the configured registry into all
 * equivalent names before spawning package-manager children.
 */
function normalizePackageManagerRegistry(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const registry = base.PNPM_CONFIG_REGISTRY ?? base.NPM_CONFIG_REGISTRY ?? base.npm_config_registry;
  if (!registry) return base;
  return {
    ...base,
    PNPM_CONFIG_REGISTRY: registry,
    NPM_CONFIG_REGISTRY: registry,
    npm_config_registry: registry,
  };
}

function syncHarness(cwd: string, label: string): void {
  console.log(`  → node scripts/sync-harness.mjs (${label})`);
  const r = spawnSync('node', [join(cwd, 'scripts/sync-harness.mjs')], { stdio: 'inherit', cwd, env: gitEnv });
  if (r.status === 0) ok(`${label} synced`);
  else warnY(`${label} sync failed — continuing`);
}

function syncPackageHarness(): void {
  console.log('  → node scripts/sync-package-harness.mjs --ensure');
  const r = spawnSync('node', [join(ROOT, 'scripts/sync-package-harness.mjs'), '--ensure'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: gitEnv,
  });
  if ((r.status ?? 1) !== 0) fail('packages/harness floating checkout is unavailable');
  ok('packages/harness floating checkout ready');
}

function syncGames(): void {
  console.log('  → node scripts/sync-games.mjs --ensure');
  const r = spawnSync('node', [join(ROOT, 'scripts/sync-games.mjs'), '--ensure'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: gitEnv,
  });
  if ((r.status ?? 1) !== 0) warnY('optional packages/games floating checkout unavailable — continuing without shared games');
  else ok('packages/games floating checkout ready or absent');
}

function installHarnessSkills(): void {
  const py = join(ROOT, 'packages/harness/skills/forgeax-install/scripts/install_harness.py');
  const ir = join(ROOT, 'packages/harness/skills/forgeax-install/examples/forgeax-studio.json');
  const python = resolvePython();
  if (!existsSync(py) || !existsSync(ir) || !python) {
    warnY('forgeax-install IR or a working Python missing — skipping');
    return;
  }
  for (const m of ['.forgeax', '.codebuddy', '.cursor', '.agents', '.claude', '.claude-internal', '.workbuddy']) {
    mkdirSync(join(ROOT, m, 'skills'), { recursive: true });
    mkdirSync(join(ROOT, m, 'rules'), { recursive: true });
  }
  const [pyCmd, ...pyPrefix] = python;
  console.log(`  → forgeax-install (harness skills/rules → ${ROOT})`);
  if (run(pyCmd, [...pyPrefix, py, '--spec', ir, '--target-root', ROOT])) ok('harness skills/rules installed');
  else warnY('forgeax-install failed — continuing');
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

/** Bun install with one clean retry for a half-installed dependency tree. */
function bunInstallWithRetry(dir: string): boolean {
  const installArgs =
    existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
      ? ['install', '--frozen-lockfile']
      : ['install'];
  if (run('bun', installArgs, { cwd: dir, env: gitEnv })) return true;
  warnY(`bun install failed in ${dir}; removing the incomplete node_modules and retrying`);
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  return run('bun', installArgs, { cwd: dir, env: gitEnv });
}

function resolvePluginPackageManager(
  dir: string,
  pkg: { packageManager?: string } | null,
  label: string,
): 'bun' | 'pnpm' {
  const fallback = extensionPackageManagerFallback({
    bunLock: existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb')),
    pnpmLock: existsSync(join(dir, 'pnpm-lock.yaml')),
    pnpmWorkspace: existsSync(join(dir, 'pnpm-workspace.yaml')),
  });
  try {
    return extensionPackageManager(pkg ?? {}, fallback);
  } catch (error) {
    fail(`${label} ${error instanceof Error ? error.message : String(error)}`);
  }
}

function installPnpmDir(dir: string): void {
  console.log(`  → pnpm install (${dir})`);
  const installArgs = existsSync(join(dir, 'pnpm-lock.yaml'))
    ? ['install', '--frozen-lockfile']
    : ['install'];
  if (!run('pnpm', installArgs, { cwd: dir, env: gitEnv })) fail(`${dir} dependency install failed`);
  ok(`${dir}  installed`);
}

function ensurePluginPlaywrightBrowsers(dir: string, label: string): void {
  const cli = join(dir, 'node_modules/playwright/cli.js');
  if (!existsSync(cli)) return;
  const browserArgs = ['install', 'chromium', 'chromium-headless-shell'];
  console.log(`  → node ${cli} ${browserArgs.join(' ')} (${label} browser runtime)`);
  if (run('node', [cli, ...browserArgs], { cwd: dir, env: gitEnv })) {
    ok(`${label} Playwright browsers ready`);
    return;
  }

  const customDownloadHost =
    gitEnv.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST ?? gitEnv.PLAYWRIGHT_DOWNLOAD_HOST;
  if (!customDownloadHost) {
    warnY(`${label} Playwright CDN unavailable; retrying configured public browser mirror`);
    if (run('node', [cli, ...browserArgs], {
      cwd: dir,
      env: { ...gitEnv, PLAYWRIGHT_DOWNLOAD_HOST: PLAYWRIGHT_DOWNLOAD_MIRROR },
    })) {
      ok(`${label} Playwright browsers ready (configured public mirror)`);
      return;
    }
  }

  warnY(
    `${label} Playwright browsers unavailable; headless renderer will be skipped ` +
      `until the browser cache is installed`,
  );
}

function installDir(dir: string): void {
  if (!existsSync(join(dir, 'package.json'))) return;
  // `node_modules` mtime is not an install-completeness signal: pnpm creates or
  // touches it before dependency lifecycle scripts finish, so an interrupted
  // install can look newer than package.json while binaries such as esbuild are
  // still unusable. Bun's install is idempotent and owns its own lock/cache
  // checks; always let it verify and repair standalone plugin dependencies.
  console.log(`  → bun install (${dir})`);
  if (bunInstallWithRetry(dir)) ok(`${dir}  installed`);
  else fail(`${dir} dependency install failed`);
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
