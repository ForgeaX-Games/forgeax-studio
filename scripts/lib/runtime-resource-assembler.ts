import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

export type RuntimeTargetId = 'darwin-arm64' | 'win32-x64' | 'linux-x64';

export interface RuntimeTarget {
  readonly id: RuntimeTargetId;
  readonly platform: NodeJS.Platform;
  readonly arch: 'arm64' | 'x64';
  readonly triple: string;
  readonly runner: 'macos-latest' | 'windows-latest' | 'ubuntu-latest';
  readonly packageDirectory: RuntimeTargetId;
  readonly sidecar: string;
}

export function sidecarNameForTriple(triple: string): string {
  return `bun-${triple}${triple.includes('windows') ? '.exe' : ''}`;
}

const TARGETS: Record<RuntimeTargetId, Omit<RuntimeTarget, 'sidecar'>> = {
  'darwin-arm64': {
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    triple: 'aarch64-apple-darwin',
    runner: 'macos-latest',
    packageDirectory: 'darwin-arm64',
  },
  'win32-x64': {
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    triple: 'x86_64-pc-windows-msvc',
    runner: 'windows-latest',
    packageDirectory: 'win32-x64',
  },
  'linux-x64': {
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    triple: 'x86_64-unknown-linux-gnu',
    runner: 'ubuntu-latest',
    packageDirectory: 'linux-x64',
  },
};

export function runtimeTarget(id: string): RuntimeTarget {
  const target = TARGETS[id as RuntimeTargetId];
  if (!target) throw new Error(`unsupported Game Runtime target: ${id}`);
  return { ...target, sidecar: sidecarNameForTriple(target.triple) };
}

export function runtimeTargetForMachine(
  machine: { platform: NodeJS.Platform; arch: string } = { platform: process.platform, arch: process.arch },
): RuntimeTarget {
  const target = Object.values(TARGETS).find((candidate) =>
    candidate.platform === machine.platform && candidate.arch === machine.arch,
  );
  if (!target) throw new Error(`unsupported Game Runtime machine: ${machine.platform}/${machine.arch}`);
  return runtimeTarget(target.id);
}

export function assertNativeRuntimeTarget(target: RuntimeTarget): void {
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(`Game Runtime ${target.id} must be built natively on ${target.platform}/${target.arch}; current machine is ${process.platform}/${process.arch}`);
  }
}

const DROP_DIRECTORIES = new Set(['__tests__', 'test', 'tests', 'learn-opengl', 'khronos-gltf-samples']);
const DROP_FILES = new Set(['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
const DROP_MEDIA = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv']);
const PLAY_RUNTIME_GENERATED_PATHS = new Set([
  '.forgeax',
  '.vite',
  'engine-assets',
  'engine-template-ui',
  'host-games',
  'shared-assets',
]);
const SHARED_PREVIEW_DEPENDENCIES = [
  '@bokuweb/zstd-wasm',
  '@dimforge/rapier2d-compat',
  '@dimforge/rapier3d-compat',
  'fzstd',
] as const;

export interface AssembleRuntimeResourcesOptions {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
}

export interface RuntimeAssemblyResult {
  readonly destinationRoot: string;
  readonly removedEntries: number;
}

export function assembleRuntimeResources(options: AssembleRuntimeResourcesOptions): RuntimeAssemblyResult {
  const sourceRoot = resolve(options.sourceRoot);
  const destinationRoot = resolve(options.destinationRoot);
  if (!existsSync(sourceRoot)) throw new Error(`desktop resource source is missing: ${sourceRoot}`);
  rmSync(destinationRoot, { recursive: true, force: true });
  const engineSource = join(sourceRoot, 'engine');
  if (!existsSync(engineSource)) throw new Error(`preview Engine resource is missing: ${engineSource}`);
  cpSync(engineSource, join(destinationRoot, 'engine'), {
    recursive: true,
    dereference: true,
    force: true,
    filter: (source) => {
      const path = relative(engineSource, source).split('\\').join('/');
      const marker = 'node_modules/@forgeax/editor-play-runtime/';
      if (!path.startsWith(marker)) return true;
      const first = path.slice(marker.length).split('/')[0];
      return !first || !PLAY_RUNTIME_GENERATED_PATHS.has(first);
    },
  });
  for (const dependency of SHARED_PREVIEW_DEPENDENCIES) {
    const source = join(sourceRoot, 'node_modules', dependency);
    if (!existsSync(source)) throw new Error(`preview dependency is missing: ${dependency}`);
    cpSync(source, join(destinationRoot, 'engine', 'node_modules', dependency), {
      recursive: true,
      dereference: true,
      force: true,
      filter: (path) => basename(path) !== 'node_modules',
    });
  }

  let removedEntries = 0;
  const discard = (path: string): void => {
    if (!existsSync(path)) return;
    rmSync(path, { recursive: true, force: true });
    removedEntries += 1;
  };
  const sweep = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (DROP_DIRECTORIES.has(entry.name)) discard(path);
        else sweep(path);
        continue;
      }
      const lower = entry.name.toLowerCase();
      const dot = lower.lastIndexOf('.');
      if (lower.endsWith('.map') || DROP_FILES.has(entry.name) || (dot >= 0 && DROP_MEDIA.has(lower.slice(dot)))) {
        discard(path);
      }
    }
  };
  sweep(destinationRoot);

  for (const required of ['engine', 'engine/vite.config.ts', 'engine/engine-vite-preset.mjs']) {
    if (!existsSync(join(destinationRoot, required))) {
      throw new Error(`assembled Runtime is missing required resource: ${required}`);
    }
  }
  return { destinationRoot, removedEntries };
}

export function runtimeArtifactName(target: RuntimeTarget): string {
  return `forgeax-game-runtime-${target.id}.tar.gz`;
}

export function runtimePackageRoot(repositoryRoot: string, target: RuntimeTarget): string {
  return join(resolve(repositoryRoot), 'packages', 'game-runtime', target.packageDirectory);
}

export function generatedPlatformFiles(packageRoot: string): { archive: string; manifest: string; entry: string; declaration: string } {
  return {
    archive: join(packageRoot, 'assets', 'runtime', basename(packageRoot), runtimeArtifactName(runtimeTarget(basename(packageRoot)))),
    manifest: join(packageRoot, 'assets', 'runtime-manifest.json'),
    entry: join(packageRoot, 'dist', 'index.js'),
    declaration: join(packageRoot, 'dist', 'index.d.ts'),
  };
}
