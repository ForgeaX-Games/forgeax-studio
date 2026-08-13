#!/usr/bin/env bun
// @ts-nocheck
// scripts/build-desktop.ts — assemble the Plan B desktop payload (cross-platform).
//
// Replaces build-desktop.sh. Stage the `bun` runtime + one bundled local-runtime
// launcher + the server/engine payload into Tauri Resources. Tauri starts only
// the launcher; the launcher owns preparation, supervision and readiness.
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
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewritePackagedEngineViteConfig } from './lib/desktop-engine-config.ts';
import {
  desktopBundleManifest,
  desktopBundleServerProfile,
  resolveDesktopBundleProfile,
} from './lib/desktop-bundle-profile.ts';
import { desktopServerEntryAdapter, resolveActiveServerRole } from './lib/server-role.ts';
import { resolveBunDependency } from './lib/runtime-dependency-closure.ts';
import { sidecarNameForTriple } from './lib/runtime-resource-assembler.ts';
import { writeVersionJson } from './lib/version.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUN = process.execPath;
const IS_WIN = process.platform === 'win32';

let desktopExtensionSelectionModule: any;
async function loadDesktopExtensionSelection() {
  // Keep the lite-only selector outside Game Runtime's build graph. Its staged
  // release closure intentionally excludes marketplace manifest contracts.
  const selectorModule = './lib/desktop-extension-selection.ts';
  desktopExtensionSelectionModule ??= await import(selectorModule);
  return desktopExtensionSelectionModule;
}

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const NO_SIDECAR = flag('--no-sidecar');
const SKIP_INSTALL = flag('--skip-install');
const DESKTOP_BUNDLE_PROFILE = (() => {
  try {
    return resolveDesktopBundleProfile(process.env);
  } catch (error) {
    console.error(`[build-desktop] ERROR: ${(error as Error).message}`);
    process.exit(1);
  }
})();
// Desktop assembly derives the server role from the already-resolved bundle
// profile. The build boundary intentionally does not read the source/dev server
// profile environment: a payload must be self-consistent.
const activeServer = resolveActiveServerRole({
  root: ROOT,
  profile: desktopBundleServerProfile(DESKTOP_BUNDLE_PROFILE),
});
const SKIP_FRONTEND = flag('--skip-frontend');
const IS_PLUGIN_RUNTIME = process.env.FORGEAX_PLUGIN_RUNTIME === '1';

const STUDIO = process.env.STUDIO ?? '1';
// Engine now lives as the editor's nested submodule (top-level packages/engine
// was removed); single source for all engine path references below.
const ENGINE_ROOT = join(ROOT, 'packages/editor/packages/engine');
const IFACE = STUDIO === '1' ? join(ROOT, 'packages/studio') : join(ROOT, 'packages/interface');
const RES = join(ROOT, 'packages/interface/src-tauri/resources');
const BIN = join(ROOT, 'packages/interface/src-tauri/binaries');
let liteSelectedExtensions: Array<{
  id: string;
  dir: string;
  capabilities: { productWorkbench: boolean };
}> = [];

const log = (s: string) => console.log(`[build-desktop] ${s}`);
const warn = (s: string) => console.error(`[build-desktop]   WARN: ${s}`);
const die = (s: string): never => {
  console.error(`[build-desktop] ERROR: ${s}`);
  process.exit(1);
};
log(`desktop bundle profile: ${DESKTOP_BUNDLE_PROFILE}`);
log(`active server runtime package: ${activeServer.packageName}`);

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
 * files); `exclude` entries are matched by path-segment basename anywhere in
 * the tree (mirrors rsync's non-anchored --exclude), and additionally support
 * `*.ext` suffix globs (e.g. '*.tgz', '*.db-wal').
 */
function copyTree(
  src: string,
  dest: string,
  exclude: Set<string> = new Set(['node_modules', '.git']),
  required = false,
): void {
  if (!existsSync(src)) {
    if (required) die(`required copy source is missing: ${src}`);
    return;
  }
  const isExcluded = (base: string): boolean => {
    if (DESKTOP_CONTROL_PATH_EXCLUDES.has(base)) return true;
    for (const pat of exclude) {
      if (pat.startsWith('*.')) {
        if (base.endsWith(pat.slice(1))) return true;
      } else if (base === pat) return true;
    }
    return false;
  };
  try {
    cpSync(src, dest, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (s) => !isExcluded(basename(s)),
    });
  } catch (e) {
    if (required) {
      die(`required copy failed ${src} → ${dest}: ${(e as Error).message}`);
    }
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
    if (j?.name) {
      const existing = idx.get(j.name);
      // Studio intentionally contains nested editor submodules that can expose
      // the same package name as a top-level Studio workspace. The shallower
      // package is the host authority; filesystem enumeration order must never
      // decide which implementation is shipped in the desktop server closure.
      const workspaceDepth = relative(ROOT, dir).split(/[\\/]/).length;
      const existingDepth = existing === undefined
        ? Number.POSITIVE_INFINITY
        : relative(ROOT, existing).split(/[\\/]/).length;
      if (workspaceDepth < existingDepth) idx.set(j.name, dir);
    }
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

// Build/test-only tooling that the hoisted install lands at the root but no
// packaged runtime ever imports: bun transpiles the server's .ts natively and
// vite ships its own transpiler, so tsc / type stubs / DOM test harnesses are
// dead weight in the .app (~90MB).
const THIRD_PARTY_DENYLIST = new Set(['typescript', '@types', 'happy-dom', 'vite-node']);

// Engine build outputs may contain a generated `pkg/.gitignore` marker when
// wasm-pack provisions the WGPU bindings locally. It is build-control metadata,
// not runtime input, and its presence depends on which valid Engine materializer
// path ran on the host. Exclude it at the package-copy boundary so PR/main
// produce the same Runtime tree from the same pinned source graph.
const ENGINE_RUNTIME_COPY_EXCLUDES = new Set(['.gitignore']);
const PREVIEW_PACKAGE_COPY_EXCLUDES = new Set(['node_modules', 'target', '.git', '.gitignore']);

// Harness state is developer evidence (loop ledgers, screenshots, checkpoints),
// never runtime input. Some engine asset packages carry it below otherwise
// shippable directories, so enforce this at the shared copy boundary instead of
// relying on every caller to remember an exclusion. Besides wasting hundreds of
// files, those evidence paths can exceed the path length makensis accepts.
const DESKTOP_CONTROL_PATH_EXCLUDES = new Set(['.forgeax-harness']);

// ── 0 hoisted root node_modules ─────────────────────────────────────────────
// Step 3 copies $ROOT/node_modules/* into the bundle, which needs a HOISTED root
// node_modules. bun's default isolated linker leaves the root empty, so re-link
// hoisted (idempotent).
if (SKIP_INSTALL) {
  log('0/7 hoisted root node_modules — skipped (--skip-install)');
} else {
  log('0/7 ensuring hoisted root node_modules (bun install --linker hoisted)…');
  const installArgs = ['install', '--linker', 'hoisted'];
  if (process.env.FORGEAX_PLUGIN_RUNTIME === '1') {
    // A persistent self-hosted runner must not reuse a stale linker graph, and
    // Runtime packaging must not invoke private workspace prepare hooks.
    installArgs.push('--frozen-lockfile', '--force', '--ignore-scripts');
  }
  run('bun', installArgs);
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
  // Build a generic Play shell. Asset ownership is established at runtime by
  // the server's authenticated exact-game bind; this build must not scan or
  // union the bundled sibling games. A shipping `--game` build is handled by
  // the explicit static-game inputs in packages/editor/scripts/fx.ts.
  run('bun', ['x', 'vite', 'build'], join(ROOT, 'packages/editor/packages/play-runtime'));
}

// ── 2 reset payload ─────────────────────────────────────────────────────────
log('2/7 resetting payload…');
rmrf(RES);
rmrf(BIN);
mkdirSync(RES, { recursive: true });
mkdirSync(BIN, { recursive: true });

// ── 2.5 shared runtime launcher ─────────────────────────────────────────────
log('2.5/7 bundling shared local-runtime launcher…');
const runtimeBundle = join(RES, 'runtime', 'local-runtime.mjs');
mkdirSync(dirname(runtimeBundle), { recursive: true });
run('bun', [
  'build',
  join(ROOT, 'scripts', 'local-runtime.ts'),
  '--target=bun',
  '--outfile',
  runtimeBundle,
]);

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
const serverPkg = readJson(join(activeServer.packageDir, 'package.json')) ?? {};
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
      if (existsSync(join(dir, 'pkg'))) {
        copyTree(join(dir, 'pkg'), join(dest, 'pkg'), ENGINE_RUNTIME_COPY_EXCLUDES);
      }
      engineVendored.push(name);
    } else {
      // Workspace packages' vendor/ dirs hold *.tgz install-time archives the
      // ROOT package.json file: deps point at. Their extracted contents already
      // ship in the staged node_modules, so bundling the archives again would
      // double-ship ~0.5GB (wb-game-video alone is a 549MB tgz).
      copyTree(dir, dest, new Set(['node_modules', '.git', '*.tgz']));
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
copyTree(join(activeServer.packageDir, 'src'), join(serverDest, 'src'), new Set());
const serverEntryAdapter = desktopServerEntryAdapter(activeServer.entry);
if (serverEntryAdapter !== null) {
  writeFileSync(join(serverDest, 'src/main.ts'), serverEntryAdapter);
}
if (existsSync(join(activeServer.packageDir, 'builtin'))) {
  copyTree(join(activeServer.packageDir, 'builtin'), join(serverDest, 'builtin'), new Set());
}
cpSync(join(activeServer.packageDir, 'package.json'), join(serverDest, 'package.json'));
copyTree(join(ROOT, 'packages/brand'), join(RES, 'brand'), new Set());

// tsconfig carries the path aliases bun honors at RUN time. Keep the src-relative
// ones (@/*, @server-lib/*, @forgeax/bus); strip the cross-package @forgeax/*
// aliases (they point at ../../<pkg>/src, which doesn't exist in the bundle) so
// bun resolves those from the node_modules/@forgeax/* we staged in step 3.
const tsconfigSrc = join(activeServer.packageDir, 'tsconfig.json');
if (existsSync(tsconfigSrc)) {
  const ts = readJson(tsconfigSrc) ?? {};
  const paths = ts.compilerOptions?.paths ?? {};
  for (const k of Object.keys(paths)) {
    if (k.startsWith('@forgeax/') && !k.startsWith('@forgeax/bus')) delete paths[k];
  }
  writeFileSync(join(serverDest, 'tsconfig.json'), `${JSON.stringify(ts, null, 2)}\n`);
}
if (process.env.FORGEAX_PLUGIN_RUNTIME === '1') copyRuntimeDependencyClosure(join(RES, 'node_modules'));

// Bake the version snapshot — the packaged server has no .git, so getVersion()
// reads resources/server/dist/version.json instead.
try {
  const runtimeVersion = process.env.FORGEAX_RUNTIME_PACKAGE_VERSION;
  writeVersionJson(ROOT, join(serverDest, 'dist/version.json'), process.env.FORGEAX_PLUGIN_RUNTIME === '1'
    ? {
        reproducible: true,
        stableVersion: runtimeVersion ? `v${runtimeVersion.replace(/^v/, '')}` : undefined,
      }
    : undefined);
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
if (DESKTOP_BUNDLE_PROFILE === 'lite') {
  // Keep marketplace metadata/personas, then add only the selector's complete
  // extension directories. The selector owns classification and dependency
  // closure; this builder only materializes its result.
  copyTree(
    join(ROOT, 'packages/marketplace'),
    join(RES, 'marketplace'),
    new Set(['extensions', 'plugins', 'node_modules', '.git']),
  );
  const {
    desktopExtensionOutputName,
    scanDesktopExtensions,
    selectDesktopExtensionClosure,
  } = await loadDesktopExtensionSelection();
  const parsedExtensions = scanDesktopExtensions(join(ROOT, 'packages/marketplace/extensions'));
  const liteSelection = selectDesktopExtensionClosure(parsedExtensions, 'lite');
  liteSelectedExtensions = [...liteSelection.included];
  for (const warning of liteSelection.warnings) warn(`lite extension selection: ${warning}`);
  for (const extension of liteSelectedExtensions) {
    copyTree(
      extension.dir,
      join(RES, 'marketplace/extensions', desktopExtensionOutputName(extension)),
      new Set(['node_modules', '.git']),
      true,
    );
  }
} else {
  // Full keeps the established payload: marketplace root plus the complete
  // built-in extension tree (with only dependency/VCS trees excluded).
  copyTree(join(ROOT, 'packages/marketplace'), join(RES, 'marketplace'), new Set(['node_modules', '.git', 'plugins']));
  copyTree(join(ROOT, 'packages/marketplace/extensions'), join(RES, 'marketplace/extensions'), new Set(['node_modules', '.git']), true);
}

// ── 6 engine (vite preview) source + cycle-safe node_modules ────────────────
log('6/7 copying engine (vite preview) source + node_modules…');
// Game preview is a LIVE vite dev server (transforms game TS on the fly). Ship
// play-runtime so a bun sidecar can run vite from it.
const ENG_SRC = join(ROOT, 'packages/editor/packages/play-runtime');
const ENG = join(RES, 'engine');
rmrf(ENG);
mkdirSync(join(ENG, 'node_modules/@forgeax'), { recursive: true });
// Vite bundles its config at startup, but it cannot follow the editor-relative
// `../../scripts/vite/engine-vite-preset` path after the play host is
// materialized under the user's project root. Pre-bundle that config helper
// while the complete editor source layout exists; package imports remain
// external and resolve from the merged runtime node_modules view.
run('bun', [
  'build',
  join(ROOT, 'packages/editor/scripts/vite/engine-vite-preset.ts'),
  '--target=node',
  '--packages=external',
  '--outfile',
  join(ENG, 'engine-vite-preset.mjs'),
]);
// rhi-debug-config.ts is imported by vite.config.ts (standalone RHI-debug plugins).
for (const f of ['index.html', 'vite.config.ts', 'package.json', 'pack-catalog.ts', 'tsconfig.json', 'rhi-debug-config.ts']) {
  if (existsSync(join(ENG_SRC, f))) cpSync(join(ENG_SRC, f), join(ENG, f));
}
// vite.config.ts imports editor-core via a RELATIVE path ('../core/src/asset-roots')
// that only works inside the monorepo. In the bundled .app, editor-core lives at
// node_modules/@forgeax/editor-core (copied in the editor-* loop below), so rewrite
// the import to the package export. Without this the engine sidecar crashes on
// startup with UNRESOLVED_IMPORT.
{
  const vcPath = join(ENG, 'vite.config.ts');
  if (existsSync(vcPath)) {
    const src = readFileSync(vcPath, 'utf8');
    const patched = rewritePackagedEngineViteConfig(src);
    if (patched !== src) {
      writeFileSync(vcPath, patched);
      log('  patched vite.config.ts for packaged editor-core + engine preset imports');
    }
  }
}
copyTree(join(ENG_SRC, 'src'), join(ENG, 'src'), new Set());
if (existsSync(join(ENG_SRC, 'public'))) copyTree(join(ENG_SRC, 'public'), join(ENG, 'public'), new Set());

// Third-party deps are NOT copied here. Step 3 already stages the identical
// hoisted closure at resources/node_modules; at launch the launcher merges
// that shared pool into the engine workspace's node_modules as junctions
// (scripts/lib/engine-workspace.ts), engine-local entries winning. Copying it
// here as well duplicated ~5GB into every .app.

// ALL engine workspace packages (flat, keyed by package.json name) — vite must
// resolve the whole graph including transitive engine-* deps. Each minus its
// nested node_modules and the cargo target/ dir.
for (const pkgdir of dirsOf(join(ENGINE_ROOT, 'packages'))) {
  const pj = readJson(join(pkgdir, 'package.json'));
  if (!pj?.name || !pj.name.startsWith('@forgeax/')) continue;
  copyTree(pkgdir, join(ENG, 'node_modules', pj.name), PREVIEW_PACKAGE_COPY_EXCLUDES);
}
// editor-* packages — play-runtime's preview entry imports @forgeax/editor-core
// /protocol (+ siblings) from the EDITOR workspace, not the engine one.
for (const pkgdir of dirsOf(join(ROOT, 'packages/editor/packages'))) {
  const pj = readJson(join(pkgdir, 'package.json'));
  if (!pj?.name || !pj.name.startsWith('@forgeax/editor-')) continue;
  copyTree(pkgdir, join(ENG, 'node_modules', pj.name), PREVIEW_PACKAGE_COPY_EXCLUDES);
}

// Engine packages' third-party runtime deps. The engine submodule uses pnpm
// (isolated): each package's deps live in its own node_modules symlinked to the
// .pnpm store, which the per-package copy above excludes. Pull the runtime
// closure flat into resources/engine/node_modules so vite can resolve them.
const ENGINE_RT_DEPS = [
  'uuidv7', 'upng-js', 'jpeg-js', 'ajv', 'ajv-formats',
  'fast-deep-equal', 'json-schema-traverse', 'require-from-string', 'fast-uri', 'zod',
  // Vite is launched directly by the packaged play-runtime. Its pnpm-isolated
  // dependencies are not visible from the root hoisted node_modules.
  'vite', 'esbuild', 'fsevents', 'jiti', 'lightningcss', 'picomatch', 'postcss',
  'rolldown', 'tinyglobby', 'fdir', '@rolldown/pluginutils', '@rolldown/binding-darwin-arm64',
  // Engine package third-party imports that only exist under the pnpm store.
  '@noble/hashes', 'fast-glob', 'pako', 'css-tree', 'parse5',
];
const pnpmStore = join(ENGINE_ROOT, 'node_modules/.pnpm');
const engineDepQueue = [...ENGINE_RT_DEPS];
const engineDepSeen = new Set<string>();
while (engineDepQueue.length) {
  const dep = engineDepQueue.shift()!;
  if (engineDepSeen.has(dep) || dep.startsWith('@forgeax/')) continue;
  engineDepSeen.add(dep);
  const src = findInPnpmStore(pnpmStore, dep);
  if (!src) {
    warn(`engine runtime dep not found in pnpm store: ${dep}`);
    continue;
  }
  const dest = join(ENG, 'node_modules', dep);
  rmrf(dest);
  copyTree(src, dest, new Set(['node_modules']));
  const pkg = readJson(join(src, 'package.json')) ?? {};
  for (const child of Object.keys(pkg.dependencies ?? {})) engineDepQueue.push(child);
}

// Minimal game template for "new game" scaffolding (lib.rs seeds it into the project root).
// The engine's game-default is an explicit feature showcase, not a blank project.
const gameTemplateSource = join(ROOT, 'packages/server/templates/game-minimal');
if (existsSync(gameTemplateSource)) {
  const dst = join(RES, 'game-template');
  rmrf(dst);
  copyTree(gameTemplateSource, dst, new Set(['node_modules', '.git']));
}

// Keep the editor-owned project templates available to the server's New Game
// catalog in the packaged resource layout as well as in source checkouts.
const engineTemplatesSource = join(ROOT, 'packages/editor/packages/engine/templates');
if (existsSync(engineTemplatesSource)) {
  const dst = join(RES, 'editor/packages/engine/templates');
  rmrf(dst);
  copyTree(engineTemplatesSource, dst, new Set(['node_modules', '.git']));
}
const editorTemplateCatalogSource = join(ROOT, 'packages/editor/standalone/template-catalog.ts');
if (existsSync(editorTemplateCatalogSource)) {
  const dst = join(RES, 'editor/standalone/template-catalog.ts');
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(editorTemplateCatalogSource, dst);
}

// Optional floating game library (consumer examples). The .app can't link the
// checkout tree, so when opted in ship a curated read-only payload; the packaged launcher copies each game once
// into the confined editable project root.
// Multiple games sharing base-asset GUIDs break the preview's global pack scan,
// so ship a single clean example by default. Override: DESKTOP_GAMES="a b c".
const gamesSrc = join(ROOT, 'packages/games');
let bundledSharedGames = 0;
if (DESKTOP_BUNDLE_PROFILE === 'lite') {
  log('6/7 shared game payload — skipped (lite bundle)');
} else if (process.env.FORGEAX_SKIP_GAMES === '1') {
  if (!IS_PLUGIN_RUNTIME) {
    die('full desktop bundle cannot set FORGEAX_SKIP_GAMES=1; use FORGEAX_DESKTOP_BUNDLE=lite');
  }
  log('6/7 shared game payload — skipped for Game Runtime staging');
} else if (existsSync(gamesSrc)) {
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
      true,
    );
    bundledSharedGames += 1;
    log(`  bundled shared game: ${gname}`);
  }
}

// Materialize the profile contract only after all selected resources have been
// copied. A lite payload must be provably free of games/product extensions and
// must use the base server role; full deliberately retains the historical tree.
const desktopBundleManifestPath = join(RES, 'runtime', 'desktop-bundle.json');
if (!IS_PLUGIN_RUNTIME && DESKTOP_BUNDLE_PROFILE === 'full' && bundledSharedGames === 0) {
  die('full desktop bundle must contain at least one sample game');
}
if (!IS_PLUGIN_RUNTIME && DESKTOP_BUNDLE_PROFILE === 'full') {
  const { scanDesktopExtensions } = await loadDesktopExtensionSelection();
  const sourceExtensions = scanDesktopExtensions(join(ROOT, 'packages/marketplace/extensions'));
  const stagedExtensions = scanDesktopExtensions(join(RES, 'marketplace/extensions'));
  if (sourceExtensions.length !== stagedExtensions.length) {
    die(`full desktop bundle extension count mismatch: expected ${sourceExtensions.length}, staged ${stagedExtensions.length}`);
  }
}
if (DESKTOP_BUNDLE_PROFILE === 'lite') {
  const { scanDesktopExtensions } = await loadDesktopExtensionSelection();
  if (desktopBundleServerProfile(DESKTOP_BUNDLE_PROFILE) !== 'base'
    || activeServer.packageDir !== join(ROOT, 'packages/server')) {
    die('lite desktop bundle must use the base server profile');
  }
  if (existsSync(join(RES, 'games'))) {
    die('lite desktop bundle must not contain resources/games');
  }
  if (liteSelectedExtensions.some(({ capabilities }) => capabilities.productWorkbench)) {
    die('lite desktop bundle must not contain product extensions');
  }
  const stagedIds = scanDesktopExtensions(join(RES, 'marketplace/extensions')).map(({ id }) => id).sort();
  const selectedIds = liteSelectedExtensions.map(({ id }) => id).sort();
  if (JSON.stringify(stagedIds) !== JSON.stringify(selectedIds)) {
    die(`lite desktop bundle extension mismatch: selected ${selectedIds.length}, staged ${stagedIds.length}`);
  }
}
if (IS_PLUGIN_RUNTIME) {
  log('desktop bundle manifest — skipped for Game Runtime staging');
} else {
  writeFileSync(
    desktopBundleManifestPath,
    `${JSON.stringify(desktopBundleManifest(DESKTOP_BUNDLE_PROFILE), null, 2)}\n`,
  );
  log(`desktop bundle manifest: ${desktopBundleManifestPath}`);
}

// ── 7 stage bun runtime as sidecar ──────────────────────────────────────────
if (NO_SIDECAR) {
  log('7/7 sidecar staging — skipped (--no-sidecar; CI stages the per-target bun)');
} else {
  log('7/7 staging bun runtime as sidecar…');
  const triple = resolveTriple();
  if (!triple) die('could not determine target triple — pass --triple <target> or install rustc');
  const dest = join(BIN, sidecarNameForTriple(triple));
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
  // The plugin Runtime has one flat, verified dependency closure. Copying every
  // nested Bun link recursively duplicates the same store many times and can turn
  // an otherwise small Runtime into gigabytes. Desktop builds retain historical
  // behavior; the plugin path relies on the flat top-level closure.
  const excludes = process.env.FORGEAX_PLUGIN_RUNTIME === '1'
    ? new Set(['node_modules'])
    : new Set<string>();
  for (const entry of dirsOf(join(ROOT, 'node_modules'))) {
    const name = basename(entry);
    // Bun's store and bin shims are link farms, not packages: copying them
    // duplicates the whole store into the bundle.
    if (name === '.bun' || name === '.bin') continue;
    if (THIRD_PARTY_DENYLIST.has(name)) continue;
    if (name === '@forgeax' || name === '@forgeax-studio') {
      // First-party scope: workspace packages are vendored by the BFS closure
      // above, but the scope can also hold EXTERNAL registry packages (e.g.
      // @forgeax/workbench-host, imported by orchestrator). Copy only those
      // whose package name is not a workspace package — skipping the whole
      // scope here ships a server that crashes on startup.
      for (const sub of dirsOf(entry)) {
        const pj = readJson(join(sub, 'package.json'));
        if (pj?.name && WS.has(pj.name)) continue;
        copyTree(sub, join(destNm, name, basename(sub)), excludes);
      }
      continue;
    }
    if (name.startsWith('@')) {
      // scoped third-party: copy the scope dir wholesale (deref real pkgs)
      copyTree(entry, join(destNm, name), excludes);
      continue;
    }
    // unscoped: skip if it's a workspace package (e.g. @forgeax/orchestrator/-interface)
    const pj = readJson(join(entry, 'package.json'));
    if (pj?.name && WS.has(pj.name)) continue;
    copyTree(entry, join(destNm, name), excludes);
  }
}

/**
 * Bun workspaces keep many production packages only in node_modules/.bun rather
 * than at the repository root. The published plugin has no Bun workspace linker,
 * so copy the active server's non-workspace production closure into one flat
 * node_modules tree. The video provider is intentionally omitted: the game plugin
 * does not expose Studio video tools and shipping its source/assets costs >1GB.
 */
function copyRuntimeDependencyClosure(destNm: string): void {
  const store = join(ROOT, 'node_modules/.bun');
  const queue: Array<{ name: string; parent: string }> = [];
  const seen = new Set<string>();
  const seeds = [activeServer.packageDir, WS.get('@forgeax/server')].filter((dir): dir is string => Boolean(dir));
  for (const dir of seeds) {
    const pkg = readJson(join(dir, 'package.json'));
    for (const name of [
      ...Object.keys(pkg?.dependencies ?? {}),
      ...Object.keys(pkg?.optionalDependencies ?? {}),
    ]) queue.push({ name, parent: dir });
  }
  while (queue.length) {
    const request = queue.shift()!;
    const { name, parent } = request;
    if (seen.has(name) || WS.has(name) || name === '@forgeax/wb-game-video') continue;
    seen.add(name);
    const source = resolveBunDependency(ROOT, store, parent, name);
    if (!source) {
      warn(`server runtime dependency not found in Bun store: ${name}`);
      continue;
    }
    log(`  server dependency: ${name}`);
    copyTree(source, join(destNm, name), new Set(['node_modules', '.git']));
    const pkg = readJson(join(source, 'package.json'));
    for (const child of [
      ...Object.keys(pkg?.dependencies ?? {}),
      ...Object.keys(pkg?.optionalDependencies ?? {}),
    ]) queue.push({ name: child, parent: source });
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
