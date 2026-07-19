#!/usr/bin/env bun
// @ts-nocheck
// scripts/build-desktop.ts — assemble the Plan B desktop payload (cross-platform).
//
// Replaces build-desktop.sh. Same contract: stage the `bun` runtime + the server
// SOURCE + its runtime node_modules closure + asset dists into the Tauri app's
// Resources, so lib.rs can run the server/engine as bun sidecars off SOURCE.
//
// Why a rewrite (the bash version's three Windows killers):
//   1. rsync / cp -RL          → fs.cpSync({ recursive, dereference }) (portable)
//   2. on-disk `[ -L ]` symlink → workspace membership is decided by package.json
//      detection                 `name`, not a disk symlink probe — on Windows bun
//                                materialises workspace deps as junctions/copies,
//                                so `[ -L ]` misclassifies them.
//   3. hard-coded host triple   → `--triple <t>` arg / FORGEAX_BUILD_TRIPLE / rustc
//      (`rustc -Vv`)              fallback; Windows sidecar gets a `.exe` suffix.
//
// Also fixes two latent bugs the bash version carried:
//   • version baking called `bash scripts/version.sh`, which no longer exists →
//     we import writeVersionJson from lib/version.ts.
//   • the server runtime closure was hard-coded to {types, agent-runtime}; the
//     server actually pulls {agent-host, agent-runtime, forgeax-core, platform-io,
//     types}. We compute the @forgeax closure by BFS over package.json deps, so it
//     can never drift again.
//
// Usage:
//   bun scripts/build-desktop.ts [--triple <target>] [--no-sidecar]
//                                [--skip-install] [--skip-frontend]
// Then (on the target OS): cd packages/interface && bun run tauri build

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeVersionJson } from './lib/version.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUN = process.execPath;
const IS_WIN = process.platform === 'win32';

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const NO_SIDECAR = flag('--no-sidecar');
const SKIP_INSTALL = flag('--skip-install');
const SKIP_FRONTEND = flag('--skip-frontend');

const STUDIO = process.env.STUDIO ?? '1';
// Engine now lives as the editor's nested submodule (top-level packages/engine
// was removed); single source for all engine path references below.
const ENGINE_ROOT = join(ROOT, 'packages/editor/packages/engine');
const IFACE = STUDIO === '1' ? join(ROOT, 'packages/studio') : join(ROOT, 'packages/interface');
const RES = join(ROOT, 'packages/interface/src-tauri/resources');
const BIN = join(ROOT, 'packages/interface/src-tauri/binaries');

const log = (s: string) => console.log(`[build-desktop] ${s}`);
const warn = (s: string) => console.error(`[build-desktop]   WARN: ${s}`);
const die = (s: string): never => {
  console.error(`[build-desktop] ERROR: ${s}`);
  process.exit(1);
};

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Recursive remove with retry. On Windows a freshly-written tree can be
 * transiently locked (antivirus / Search indexer / a lingering file handle),
 * making a single rmSync throw EBUSY/EPERM/ENOTEMPTY. Retry a few times with a
 * short synchronous backoff before giving up.
 */
function rmrf(path: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i === 4 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
}

/** Run a command, inheriting stdio; die on non-zero. `bun` routes to this runtime. */
function run(cmd: string, args: string[], cwd: string = ROOT): void {
  const exe = cmd === 'bun' ? BUN : cmd;
  const r = spawnSync(exe, args, { cwd, stdio: 'inherit', shell: cmd !== 'bun' && IS_WIN });
  if (r.status !== 0) die(`command failed (${r.status}): ${cmd} ${args.join(' ')}`);
}

/**
 * Portable replacement for `rsync -aL --exclude … src/ dest/` and `cp -RL`.
 * dereference:true follows symlinks (so vendored workspace pkgs land as real
 * files); `exclude` is matched by path-segment basename, anywhere in the tree
 * (mirrors rsync's non-anchored --exclude).
 */
function copyTree(src: string, dest: string, exclude: Set<string> = new Set(['node_modules', '.git'])): void {
  if (!existsSync(src)) return;
  try {
    cpSync(src, dest, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (s) => !exclude.has(basename(s)),
    });
  } catch (e) {
    // Tolerate transient "file vanished" while copying a live tree (IDE/watcher
    // deleting temp files mid-copy) — mirrors the bash version's `|| true`.
    warn(`partial copy ${src} → ${dest}: ${(e as Error).message}`);
  }
}

// ── workspace package index (name → dir) ────────────────────────────────────
// One scan of packages/ powers every "is this a workspace package?" / "where is
// @forgeax/<x>?" question — replacing the bash `[ -L ]` symlink probe.
function indexWorkspace(): Map<string, string> {
  const idx = new Map<string, string>();
  const prune = new Set(['node_modules', '.git', 'dist', 'pkg', 'src', 'target', 'tests', 'public', '.vite']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    const pj = join(dir, 'package.json');
    const j = existsSync(pj) ? readJson(pj) : null;
    if (j?.name) idx.set(j.name, dir);
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (prune.has(e.name)) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(join(ROOT, 'packages'), 0);
  return idx;
}
const WS = indexWorkspace();
const isEnginePkg = (name: string) => name.startsWith('@forgeax/engine-');

// ── 0 hoisted root node_modules ─────────────────────────────────────────────
// Step 3 copies $ROOT/node_modules/* into the bundle, which needs a HOISTED root
// node_modules. bun's default isolated linker leaves the root empty, so re-link
// hoisted (idempotent).
if (SKIP_INSTALL) {
  log('0/7 hoisted root node_modules — skipped (--skip-install)');
} else {
  log('0/7 ensuring hoisted root node_modules (bun install --linker hoisted)…');
  run('bun', ['install', '--linker', 'hoisted']);
}

// ── 1 build frontends ───────────────────────────────────────────────────────
if (SKIP_FRONTEND) {
  log('1/7 frontend builds — skipped (--skip-frontend)');
} else {
  log('1/7 building interface SPA…');
  // vite directly (not `bun run build`) to bypass the package's tsc -b gate,
  // which trips on pre-existing cross-package react-resolution errors.
  run('bun', ['x', 'vite', 'build'], IFACE);
  log('1.5/7 building editor edit/play runtimes…');
  run('bun', ['x', 'vite', 'build'], join(ROOT, 'packages/editor/packages/edit-runtime'));
  // play-runtime holds ZERO on-disk layout convention — the HOST injects it.
  // Pre-import the bundled games (packages/games) at build time and bake the
  // client URL-space prefix so the frozen .app serves games under .forgeax/games
  // (lib.rs symlinks the runtime games there). Both must agree. (run() inherits
  // process.env; set for this one build then restore.)
  process.env.FORGEAX_PREVIEW_GAMES_DIR = join(ROOT, 'packages/games');
  process.env.FORGEAX_GAMES_URL_PREFIX = '.forgeax/games';
  run('bun', ['x', 'vite', 'build'], join(ROOT, 'packages/editor/packages/play-runtime'));
  delete process.env.FORGEAX_PREVIEW_GAMES_DIR;
  delete process.env.FORGEAX_GAMES_URL_PREFIX;
}

// ── 2 reset payload ─────────────────────────────────────────────────────────
log('2/7 resetting payload…');
rmrf(RES);
rmrf(BIN);
mkdirSync(RES, { recursive: true });
mkdirSync(BIN, { recursive: true });

// ── 3 server runtime node_modules (cycle-safe) ──────────────────────────────
log('3/7 assembling server runtime node_modules…');
mkdirSync(join(RES, 'node_modules/@forgeax'), { recursive: true });

// (a) deref every real third-party dir from the hoisted root; skip the @forgeax
// workspace scopes and any top-level entry that is itself a workspace package
// (@forgeax/orchestrator, forgeax-interface, …) — identified by package.json name, not by
// a symlink probe (Windows-safe).
copyThirdParty(join(RES, 'node_modules'));

// (b) vendor the server's @forgeax runtime closure. BFS over package.json deps
// from the server's declared @forgeax deps PLUS the engine packages the server
// value-imports (engine-project/runtime/physics — referenced in code but not
// declared, so the graph can't reach them on its own). Engine packages ship
// dist+pkg only; everything else ships source (these export src/*.ts directly).
const serverPkg = readJson(join(ROOT, 'packages/server/package.json')) ?? {};
const closureSeeds = [
  ...Object.keys(serverPkg.dependencies ?? {}).filter((k) => k.startsWith('@forgeax/')),
  '@forgeax/engine-project',
  '@forgeax/engine-runtime',
  '@forgeax/engine-physics',
];
const vendored: string[] = [];
const engineVendored: string[] = [];
{
  const seen = new Set<string>();
  const queue = [...closureSeeds];
  while (queue.length) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    const dir = WS.get(name);
    if (!dir) {
      warn(`workspace package not found for ${name} (skipped)`);
      continue;
    }
    seen.add(name);
    const dest = join(RES, 'node_modules', name);
    if (isEnginePkg(name)) {
      // runtime closure only: dist/ (built JS) + pkg/ (wgpu-wasm bindings) + package.json
      mkdirSync(dest, { recursive: true });
      cpSync(join(dir, 'package.json'), join(dest, 'package.json'));
      if (existsSync(join(dir, 'dist'))) copyTree(join(dir, 'dist'), join(dest, 'dist'), new Set());
      if (existsSync(join(dir, 'pkg'))) copyTree(join(dir, 'pkg'), join(dest, 'pkg'), new Set());
      engineVendored.push(name);
    } else {
      copyTree(dir, dest, new Set(['node_modules', '.git']));
      vendored.push(name);
    }
    const pj = readJson(join(dir, 'package.json')) ?? {};
    for (const dep of Object.keys(pj.dependencies ?? {})) if (dep.startsWith('@forgeax/')) queue.push(dep);
  }
}
log(`  vendored source closure: ${vendored.join(' ')}`);
log(`  vendored engine closure: ${engineVendored.join(' ')}`);

// ── 4 server source + builtin + version ─────────────────────────────────────
log('4/7 copying server source + builtin…');
const serverDest = join(RES, 'server');
mkdirSync(serverDest, { recursive: true });
copyTree(join(ROOT, 'packages/server/src'), join(serverDest, 'src'), new Set());
if (existsSync(join(ROOT, 'packages/server/builtin'))) {
  copyTree(join(ROOT, 'packages/server/builtin'), join(serverDest, 'builtin'), new Set());
}
cpSync(join(ROOT, 'packages/server/package.json'), join(serverDest, 'package.json'));

// tsconfig carries the path aliases bun honors at RUN time. Keep the src-relative
// ones (@/*, @server-lib/*, @forgeax/bus); strip the cross-package @forgeax/*
// aliases (they point at ../../<pkg>/src, which doesn't exist in the bundle) so
// bun resolves those from the node_modules/@forgeax/* we staged in step 3.
const tsconfigSrc = join(ROOT, 'packages/server/tsconfig.json');
if (existsSync(tsconfigSrc)) {
  const ts = readJson(tsconfigSrc) ?? {};
  const paths = ts.compilerOptions?.paths ?? {};
  for (const k of Object.keys(paths)) {
    if (k.startsWith('@forgeax/') && !k.startsWith('@forgeax/bus')) delete paths[k];
  }
  writeFileSync(join(serverDest, 'tsconfig.json'), `${JSON.stringify(ts, null, 2)}\n`);
}

// Bake the version snapshot — the packaged server has no .git, so getVersion()
// reads resources/server/dist/version.json instead.
try {
  writeVersionJson(ROOT, join(serverDest, 'dist/version.json'));
  const v = readJson(join(serverDest, 'dist/version.json'))?.version ?? '?';
  log(`  version: ${v}`);
} catch (e) {
  warn(`version baking failed; version will show unknown (${(e as Error).message})`);
}

// ── 5 interface dist + marketplace ──────────────────────────────────────────
log('5/7 copying interface dist + marketplace plugin dists…');
// 'interface/dist' resource name is historical and independent of STUDIO routing:
// when STUDIO=1 the source IFACE is packages/studio, but we still emit to
// $RES/interface/dist (the server sidecar + marketplace loader key off that path).
copyTree(join(IFACE, 'dist'), join(RES, 'interface/dist'), new Set());
// editor edit/play runtime dists — served under /editor/ and /preview/
mkdirSync(join(RES, 'interface/dist/editor'), { recursive: true });
mkdirSync(join(RES, 'interface/dist/preview'), { recursive: true });
copyTree(join(ROOT, 'packages/editor/packages/edit-runtime/dist'), join(RES, 'interface/dist/editor'), new Set());
copyTree(join(ROOT, 'packages/editor/packages/play-runtime/dist'), join(RES, 'interface/dist/preview'), new Set());
// marketplace ROOT files (manifest.json + src) minus plugins/node_modules/.git
copyTree(join(ROOT, 'packages/marketplace'), join(RES, 'marketplace'), new Set(['node_modules', '.git', 'plugins']));
// plugin dists + single-file plugins + manifests (server serves these as iframes)
copyTree(join(ROOT, 'packages/marketplace/extensions'), join(RES, 'marketplace/extensions'), new Set(['node_modules', '.git']));

// ── 6 engine (vite preview) source + cycle-safe node_modules ────────────────
log('6/7 copying engine (vite preview) source + node_modules…');
// Game preview is a LIVE vite dev server (transforms game TS on the fly). Ship
// play-runtime so a bun sidecar can run vite from it.
const ENG_SRC = join(ROOT, 'packages/editor/packages/play-runtime');
const ENG = join(RES, 'engine');
rmrf(ENG);
mkdirSync(join(ENG, 'node_modules/@forgeax'), { recursive: true });
for (const f of ['index.html', 'vite.config.ts', 'package.json', 'pack-catalog.ts', 'tsconfig.json']) {
  if (existsSync(join(ENG_SRC, f))) cpSync(join(ENG_SRC, f), join(ENG, f));
}
copyTree(join(ENG_SRC, 'src'), join(ENG, 'src'), new Set());
if (existsSync(join(ENG_SRC, 'public'))) copyTree(join(ENG_SRC, 'public'), join(ENG, 'public'), new Set());

// Third-party from ROOT hoisted node_modules (NOT engine-src's — those are
// symlinks under hoisted and would be skipped). Same skip rules as step 3.
copyThirdParty(join(ENG, 'node_modules'));

// ALL engine workspace packages (flat, keyed by package.json name) — vite must
// resolve the whole graph including transitive engine-* deps. Each minus its
// nested node_modules and the cargo target/ dir.
for (const pkgdir of dirsOf(join(ENGINE_ROOT, 'packages'))) {
  const pj = readJson(join(pkgdir, 'package.json'));
  if (!pj?.name || !pj.name.startsWith('@forgeax/')) continue;
  copyTree(pkgdir, join(ENG, 'node_modules', pj.name), new Set(['node_modules', 'target', '.git']));
}
// editor-* packages — play-runtime's preview entry imports @forgeax/editor-core
// /protocol (+ siblings) from the EDITOR workspace, not the engine one.
for (const pkgdir of dirsOf(join(ROOT, 'packages/editor/packages'))) {
  const pj = readJson(join(pkgdir, 'package.json'));
  if (!pj?.name || !pj.name.startsWith('@forgeax/editor-')) continue;
  copyTree(pkgdir, join(ENG, 'node_modules', pj.name), new Set(['node_modules', 'target', '.git']));
}

// Engine packages' third-party runtime deps. The engine submodule uses pnpm
// (isolated): each package's deps live in its own node_modules symlinked to the
// .pnpm store, which the per-package copy above excludes. Pull the runtime
// closure flat into resources/engine/node_modules so vite can resolve them.
const ENGINE_RT_DEPS = [
  'uuidv7', 'upng-js', 'jpeg-js', 'ajv', 'ajv-formats',
  'fast-deep-equal', 'json-schema-traverse', 'require-from-string', 'fast-uri', 'zod',
];
const pnpmStore = join(ENGINE_ROOT, 'node_modules/.pnpm');
for (const dep of ENGINE_RT_DEPS) {
  const src = findInPnpmStore(pnpmStore, dep);
  if (!src) {
    warn(`engine runtime dep not found in pnpm store: ${dep}`);
    continue;
  }
  const dest = join(ENG, 'node_modules', dep);
  rmrf(dest);
  copyTree(src, dest, new Set(['node_modules']));
}

// Game template for "new game" scaffolding (lib.rs seeds it into the project root).
if (existsSync(join(ENGINE_ROOT, 'templates/game-default'))) {
  const dst = join(RES, 'game-template');
  rmrf(dst);
  copyTree(join(ENGINE_ROOT, 'templates/game-default'), dst, new Set(['node_modules', '.git']));
}

// Shared game library (official examples). The .app can't link the git tree, so
// ship a curated read-only COPY; lib.rs symlinks each into the project root.
// Multiple games sharing base-asset GUIDs break the preview's global pack scan,
// so ship a single clean example by default. Override: DESKTOP_GAMES="a b c".
const gamesSrc = join(ROOT, 'packages/games');
if (existsSync(gamesSrc)) {
  const desktopGames = (process.env.DESKTOP_GAMES ?? 'spin-cube').split(/\s+/).filter(Boolean);
  const gamesDst = join(RES, 'games');
  rmrf(gamesDst);
  mkdirSync(gamesDst, { recursive: true });
  for (const gdir of dirsOf(gamesSrc)) {
    const gname = basename(gdir);
    if (!existsSync(join(gdir, 'forge.json'))) continue; // forge.json is the guard (mirrors run.ts)
    if (!desktopGames.includes(gname)) {
      log(`  skip game (not in DESKTOP_GAMES): ${gname}`);
      continue;
    }
    copyTree(
      gdir,
      join(gamesDst, gname),
      new Set(['node_modules', '.git', '*.db-wal', '*.db-shm', '*.sqlite-wal', '*.sqlite-shm']),
    );
    log(`  bundled shared game: ${gname}`);
  }
}

// ── 7 stage bun runtime as sidecar ──────────────────────────────────────────
if (NO_SIDECAR) {
  log('7/7 sidecar staging — skipped (--no-sidecar; CI stages the per-target bun)');
} else {
  log('7/7 staging bun runtime as sidecar…');
  const triple = resolveTriple();
  if (!triple) die('could not determine target triple — pass --triple <target> or install rustc');
  const ext = triple.includes('windows') ? '.exe' : '';
  const dest = join(BIN, `bun-${triple}${ext}`);
  cpSync(BUN, dest);
  log(`staged bun for ${triple}`);
}

log(`payload ready at ${RES}`);
console.log('\nNext (on the target OS):');
console.log('  cd packages/interface && bun run tauri build');

// ── helpers ─────────────────────────────────────────────────────────────────

/** Immediate child directories of `dir` (absolute paths). */
function dirsOf(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Copy real third-party deps from the hoisted root node_modules into `destNm`.
 * Skips the @forgeax / @forgeax-studio workspace scopes (vendored by hand) and
 * any top-level entry that is itself a workspace package (decided by package.json
 * name in the workspace index — the Windows-safe replacement for `[ -L ]`).
 */
function copyThirdParty(destNm: string): void {
  mkdirSync(destNm, { recursive: true });
  for (const entry of dirsOf(join(ROOT, 'node_modules'))) {
    const name = basename(entry);
    if (name === '@forgeax' || name === '@forgeax-studio') continue;
    if (name.startsWith('@')) {
      // scoped third-party: copy the scope dir wholesale (deref real pkgs)
      copyTree(entry, join(destNm, name), new Set());
      continue;
    }
    // unscoped: skip if it's a workspace package (e.g. @forgeax/orchestrator/-interface)
    const pj = readJson(join(entry, 'package.json'));
    if (pj?.name && WS.has(pj.name)) continue;
    copyTree(entry, join(destNm, name), new Set());
  }
}

/** Find `dep`'s real dir inside a pnpm `.pnpm` store (…/<hash>/node_modules/<dep>). */
function findInPnpmStore(store: string, dep: string): string | null {
  for (const hashDir of dirsOf(store)) {
    const cand = join(hashDir, 'node_modules', dep);
    if (existsSync(join(cand, 'package.json'))) return cand;
  }
  return null;
}

/** triple from --triple / FORGEAX_BUILD_TRIPLE / `rustc -Vv` host. */
function resolveTriple(): string {
  const explicit = opt('--triple') ?? process.env.FORGEAX_BUILD_TRIPLE;
  if (explicit) return explicit.trim();
  const r = spawnSync('rustc', ['-Vv'], { encoding: 'utf8', shell: IS_WIN });
  return (r.stdout ?? '').match(/^host:\s*(.+)$/m)?.[1]?.trim() ?? '';
}
