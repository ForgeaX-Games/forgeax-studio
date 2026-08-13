#!/usr/bin/env bun

/**
 * Assemble the current Studio Engine/server/play-runtime payload into one
 * macOS arm64 archive that the game plugin can install and launch.
 *
 * The desktop assembler already owns the difficult closure calculation. This
 * script turns its resource tree into the plugin's portable Runtime artifact
 * and writes the manifest consumed by the package.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');
/**
 * Root of the ForgeaX Studio checkout this build reads from.
 *
 * The plugin's own source has no dependency on Studio, but producing its Runtime does:
 * the Engine checkout, the desktop resource tree and the server closure all live there.
 * As a submodule at `packages/game-plugin` the default resolves to the Studio root, so
 * an in-tree build needs no configuration; a standalone clone points at one explicitly.
 */
const repoRoot = resolve(process.env.FORGEAX_STUDIO_ROOT?.trim() || resolve(packageRoot, '../..'));
const triple = 'aarch64-apple-darwin';
const platform = 'darwin';
const architecture = 'arm64';
const args = process.argv.slice(2);
const buildPlugin = args.includes('--build-plugin');
const skipInstall = args.includes('--skip-install');
const skipFrontend = args.includes('--skip-frontend');
const fromResources = args.includes('--from-resources');

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function run(command: string, commandArgs: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status ?? 'signal'}): ${command} ${commandArgs.join(' ')}`);
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function injectRuntimeIdentity(resourceRoot: string, runtimeVersion: string, engineCommit: string): void {
  const viteConfig = join(resourceRoot, 'engine', 'vite.config.ts');
  if (!existsSync(viteConfig)) throw new Error(`bundled Engine vite config is missing: ${viteConfig}`);
  const source = readFileSync(viteConfig, 'utf8');
  const marker = '          instanceRootAbs,\n';
  if (!source.includes(marker)) {
    throw new Error(`bundled Engine health route has no identity marker: ${viteConfig}`);
  }
  writeFileSync(
    viteConfig,
    source.replace(
      marker,
      `${marker}          runtimeVersion: ${JSON.stringify(runtimeVersion)},\n          engineVersion: ${JSON.stringify(engineCommit)},\n`,
    ),
    'utf8',
  );
}

/**
 * Studio-only payload that must not reach a game-preview Runtime.
 *
 * The desktop resource tree is copied wholesale, so anything Studio ships rides along
 * unless it is named here. Pruning runs last, after every copy step, so entries added
 * by the dependency closures are covered too.
 *
 * Measured on darwin-arm64: `@forgeax/wb-game-video` alone was 1057 MB of a 1900 MB
 * tree — 75 authored narration videos, stored twice (`dist/assets` and `src/editor`).
 * A workbench video extension answers no question a game preview asks.
 */
const STUDIO_ONLY_PATHS = [
  'marketplace/extensions',
  'games',
  'interface',
  'node_modules/@forgeax/server/vendor/forgeax-wb-game-video-0.2.1.tgz',
  'node_modules/@forgeax/wb-game-video',
  'node_modules/@forgeax-extension',
] as const;

/**
 * Dependencies no preview path reaches, each verified by booting a Runtime without it.
 *
 * The closure walkers follow `devDependencies` and copy whole package trees, so a
 * preview Runtime accumulates build tooling and optional providers it never loads.
 * Every entry here was confirmed twice: no static import reaches it, and a Runtime
 * with it deleted still boots the server, serves `/preview/`, and renders a game.
 *
 * Deliberately KEPT because they are top-level imports on the server's boot path —
 * deleting any of them crash-loops the server, which is `required: true`, so the
 * preview URL never opens: `sharp` + `@img` (game/ui-asset-cleanup), `@aws-sdk`
 * (video-assets/providers/s3), `@google` (orchestrator gemini), `hono`, `zod`.
 * Also kept: `rolldown` (top-level import in vite's own entry) and
 * `engine/node_modules/@dimforge` (lazily loaded, but every physics game needs it).
 */
const UNREACHABLE_DEPENDENCIES = [
  // Telemetry: no static importer; the only consumer is the CLI, itself only
  // path-resolved inside a try/catch.
  'node_modules/@opentelemetry',
  // TypeScript is a devDependency artifact. Vite 8 transpiles via rolldown/oxc and
  // never loads `tsc`; nothing else imports it at runtime.
  'node_modules/typescript',
  'engine/node_modules/typescript',
  // Optional peer of vite, reached only from the deprecated transform API and a
  // build-time CSS-minify branch. The dev server never loads it.
  'engine/node_modules/esbuild',
  // Headless browser automation behind `await import('playwright')` inside start().
  'node_modules/playwright',
  'node_modules/playwright-core',
  // Duplicate of the engine copy: no root package depends on the rapier backends
  // outside devDependencies, and the engine resolves its own copy first.
  'node_modules/@dimforge',
  // Terminal-UI closure of the CLI, which this plugin's bounded MCP surface never
  // exposes; declared-only, with no runtime importer.
  'node_modules/es-toolkit',
  'node_modules/web-streams-polyfill',
] as const;

function pruneStudioOnlyPayload(resourceRoot: string): void {
  for (const relative of [...STUDIO_ONLY_PATHS, ...UNREACHABLE_DEPENDENCIES]) {
    rmSync(join(resourceRoot, relative), { recursive: true, force: true });
  }

  /**
   * Debug and test payload inside dependency trees. Source maps are the single largest
   * item (measured 89 MB) and already dangle — they point at source paths that were
   * never shipped, so the warnings they produce are noise either way. Models read the
   * Engine source from the SDK snapshot, not from a runtime map.
   */
  const dropDirectories = new Set(['__tests__', 'test', 'tests']);
  /**
   * Dependency lockfiles inside the bundled packages.
   *
   * They pin an internal registry host, which this project's own public-mirror gate
   * forbids in published output, and nothing reads them at runtime: node_modules is
   * already materialized, and the only lockfile the runtime consults belongs to a
   * Studio checkout in the source layout, not to these packages.
   */
  const dropFiles = new Set(['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
  for (const tree of [join(resourceRoot, 'node_modules'), join(resourceRoot, 'engine', 'node_modules')]) {
    if (!existsSync(tree)) continue;
    pruneDependencyTree(tree, dropDirectories, dropFiles);
  }

  /**
   * Sample corpora the Engine uses for its own demos and conformance runs. A user's
   * game brings its own assets, so these are pure weight in a preview Runtime.
   * Measured: learn-opengl 253 MB, khronos-gltf-samples 51 MB. Deliberately kept:
   * `dejavu-fonts` (the template's text rendering resolves a shared font root),
   * `shared-assets`, `demo-assets`, `sfx` and `vendor`.
   */
  const sampleCorpora = new Set(['learn-opengl', 'khronos-gltf-samples']);
  /**
   * Media never belongs in a preview Runtime. Extensions can reintroduce it under new
   * names, so this is a shape rule rather than another path to maintain.
   */
  const mediaExtensions = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv']);

  let reclaimed = 0;
  const discard = (path: string): void => {
    try {
      reclaimed += directorySize(path);
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* Anything that cannot be measured or removed is left in place. */
    }
  };
  const sweep = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (sampleCorpora.has(entry.name)) discard(path);
        else sweep(path);
        continue;
      }
      const dot = entry.name.lastIndexOf('.');
      if (dot >= 0 && mediaExtensions.has(entry.name.slice(dot).toLowerCase())) discard(path);
    }
  };
  sweep(resourceRoot);
  if (reclaimed > 0) {
    console.log(`Pruned ${(reclaimed / 1024 / 1024).toFixed(0)} MB of sample and media payload from the Runtime`);
  }
}

/** Remove source maps, test directories and lockfiles from one dependency tree. */
function pruneDependencyTree(
  directory: string,
  dropDirectories: ReadonlySet<string>,
  dropFiles: ReadonlySet<string>,
): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (dropDirectories.has(entry.name)) rmSync(path, { recursive: true, force: true });
      else pruneDependencyTree(path, dropDirectories, dropFiles);
      continue;
    }
    if (entry.name.endsWith('.map') || dropFiles.has(entry.name)) rmSync(path, { force: true });
  }
}

function directorySize(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    total += directorySize(join(path, entry.name));
  }
  return total;
}

function findNewestBunPackage(store: string, name: string): string | undefined {
  let best: { path: string; version: number[] } | undefined;
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(store, entry.name, 'node_modules', name);
    if (!existsSync(join(candidate, 'package.json'))) continue;
    const metadata = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as { version?: string };
    const version = String(metadata.version ?? '0').replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
    if (
      !best ||
      version.some((part, index) => part !== (best.version[index] ?? 0) && part > (best.version[index] ?? 0))
    ) {
      best = { path: candidate, version };
    }
  }
  return best?.path;
}

function copyServerBunClosure(resourceRoot: string): void {
  const store = join(repoRoot, 'node_modules/.bun');
  const queue: string[] = ['zod-to-json-schema', 'semver', 'sharp'];
  const seen = new Set<string>();
  /**
   * Seed the closure with whichever server workspaces this checkout actually has.
   *
   * Discovering them by directory shape rather than naming them keeps two properties: a
   * checkout that lacks a given variant needs no special case, and this file carries no
   * package name that the public-mirror gate forbids in assembled output. Package
   * directories map 1:1 onto `@forgeax/<dir>`, so the name is derived, not translated.
   */
  const workspaceQueue = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^server(-|$)/.test(entry.name))
    .map((entry) => `@forgeax/${entry.name}`);
  const workspaceSeen = new Set<string>();
  while (workspaceQueue.length) {
    const workspaceName = workspaceQueue.shift()!;
    if (workspaceSeen.has(workspaceName)) continue;
    workspaceSeen.add(workspaceName);
    const packageDir = join(repoRoot, 'packages', workspaceName.slice('@forgeax/'.length));
    if (!existsSync(join(packageDir, 'package.json'))) continue;
    const metadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const name of [
      ...Object.keys(metadata.dependencies ?? {}),
      ...Object.keys(metadata.optionalDependencies ?? {}),
    ]) {
      if (name.startsWith('@forgeax/') && !name.startsWith('@forgeax-extension/')) workspaceQueue.push(name);
      else queue.push(name);
    }
  }
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name) || name === '@forgeax/wb-game-video' || name.startsWith('@forgeax/')) continue;
    seen.add(name);
    const source = findNewestBunPackage(store, name);
    if (!source) continue;
    const destination = join(resourceRoot, 'node_modules', name);
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (path) => basename(path) !== 'node_modules',
    });
    const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    queue.push(...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {}));
  }
}

function fillEngineRuntimeDeps(resourceRoot: string): void {
  const pnpmStore = join(repoRoot, 'packages/editor/packages/engine/node_modules/.pnpm');
  const engineNm = join(resourceRoot, 'engine/node_modules');
  const queue = [
    '@noble/hashes',
    'fast-glob',
    'pako',
    'css-tree',
    'parse5',
    'uuidv7',
    'upng-js',
    'jpeg-js',
  ];
  const seen = new Set<string>();
  const find = (name: string): string | undefined => {
    let best: { path: string; version: number[] } | undefined;
    for (const entry of readdirSync(pnpmStore, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(pnpmStore, entry.name, 'node_modules', name);
      if (!existsSync(join(candidate, 'package.json'))) continue;
      const metadata = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as { version?: string };
      const version = String(metadata.version ?? '0').replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
      if (
        !best ||
        version.some((part, index) => part !== (best.version[index] ?? 0) && part > (best.version[index] ?? 0))
      ) {
        best = { path: candidate, version };
      }
    }
    return best?.path;
  };
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name) || name.startsWith('@forgeax/')) continue;
    seen.add(name);
    const source = find(name);
    if (!source) continue;
    const destination = join(engineNm, name);
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (path) => basename(path) !== 'node_modules',
    });
    const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    queue.push(...Object.keys(metadata.dependencies ?? {}));
  }
}

function extractVendoredServerPackages(resourceRoot: string): void {
  const archive = join(
    resourceRoot,
    'node_modules/@forgeax/server/vendor/forgeax-workbench-host-0.2.0.tgz',
  );
  if (!existsSync(archive)) throw new Error(`bundled workbench-host vendor archive is missing: ${archive}`);
  const temporary = join(resourceRoot, '.vendor-workbench-host');
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  const result = spawnSync('tar', ['-xzf', archive, '-C', temporary, '--no-same-owner'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`cannot extract workbench-host vendor package: ${result.stderr?.trim()}`);
  const packageRoot = join(temporary, 'package');
  if (!existsSync(join(packageRoot, 'package.json'))) {
    throw new Error(`invalid workbench-host vendor package: ${archive}`);
  }
  cpSync(packageRoot, join(resourceRoot, 'node_modules/@forgeax/workbench-host'), {
    recursive: true,
    dereference: true,
    force: true,
    filter: (path) => basename(path) !== 'node_modules',
  });
  rmSync(temporary, { recursive: true, force: true });
}

const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  version?: string;
};
const version = option('--version') ?? process.env.FORGEAX_RUNTIME_VERSION ?? `${packageJson.version ?? '0.0.0'}-dev`;
const stagingRoot = resolve(packageRoot, '.runtime', `${platform}-${architecture}`);
const artifact = resolve(packageRoot, '.runtime', `forgeax-game-runtime-${platform}-${architecture}.tar.gz`);
const manifest = resolve(packageRoot, '.runtime', 'runtime-manifest.json');
const engineSdk = resolve(packageRoot, '.runtime', 'engine-sdk');
const resources = join(repoRoot, 'packages/interface/src-tauri/resources');
const sidecar = join(repoRoot, 'packages/interface/src-tauri/binaries', `bun-${triple}`);

process.env.FORGEAX_PLUGIN_RUNTIME = '1';
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

run(process.execPath, ['scripts/build-engine-sdk.ts'], packageRoot);

if (!fromResources) {
  const desktopArgs = ['scripts/build-desktop.ts', '--triple', triple];
  if (skipInstall) desktopArgs.push('--skip-install');
  if (skipFrontend) desktopArgs.push('--skip-frontend');
  run(process.execPath, desktopArgs, repoRoot);
}

if (!existsSync(resources)) throw new Error(`desktop resources were not produced: ${resources}`);
if (!existsSync(sidecar)) throw new Error(`Bun sidecar was not produced: ${sidecar}`);

cpSync(resources, stagingRoot, { recursive: true, dereference: true });
mkdirSync(join(stagingRoot, 'bin'), { recursive: true });
cpSync(sidecar, join(stagingRoot, 'bin', basename(sidecar)));
copyServerBunClosure(stagingRoot);
fillEngineRuntimeDeps(stagingRoot);
extractVendoredServerPackages(stagingRoot);
pruneStudioOnlyPayload(stagingRoot);
const engineVersion = JSON.parse(readFileSync(join(engineSdk, 'engine-version.json'), 'utf8')) as {
  engineCommit?: string;
};
injectRuntimeIdentity(stagingRoot, version, engineVersion.engineCommit ?? 'unknown');

run('tar', ['-czf', artifact, '-C', stagingRoot, '.'], repoRoot);

const digest = sha256(artifact);
writeFileSync(
  manifest,
  `${JSON.stringify({
    schemaVersion: 1,
    runtimeId: 'forgeax-game-runtime',
    artifacts: [{
      version,
      platform,
      arch: architecture,
      source: `./runtime/${platform}-${architecture}/${basename(artifact)}`,
      sha256: digest,
      format: 'archive',
      command: `bin/${basename(sidecar)}`,
      args: ['runtime/local-runtime.mjs', '--profile', 'desktop-prod'],
    }],
  }, null, 2)}\n`,
  'utf8',
);

console.log(`Runtime artifact: ${artifact}`);
console.log(`Runtime manifest: ${manifest}`);
console.log(`Runtime sha256: ${digest}`);

if (buildPlugin) {
  run(process.execPath, ['build.mjs'], packageRoot, {
    ...process.env,
    FORGEAX_RUNTIME_ARTIFACT: artifact,
    FORGEAX_RUNTIME_MANIFEST: manifest,
    FORGEAX_ENGINE_SDK: engineSdk,
    FORGEAX_RUNTIME_VERSION: version,
  });
}
