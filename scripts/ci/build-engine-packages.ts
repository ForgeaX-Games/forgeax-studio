#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

/**
 * The Engine's pnpm workspace is the authoritative package build graph.
 *
 * Do not recreate that graph from Studio-side manifest fields: Engine packages
 * can import another package for build-time reasons, and those edges may be
 * declared as devDependencies. pnpm sees the complete workspace graph and
 * topologically orders the build accordingly.
 */
export const ALL_ENGINE_PACKAGES_FILTER = '@forgeax/engine-*';

/**
 * The smaller Engine package set needed before Studio's Vite configuration is
 * loaded during local prepare. Runtime release jobs use ALL_ENGINE_PACKAGES_FILTER
 * because their SDK/native artifacts are snapshots of every Engine package.
 */
export const PREPARE_ENGINE_BUILD_FILTERS = [
  '@forgeax/engine-app...',
  '@forgeax/engine-runtime...',
  '@forgeax/engine-ecs...',
  '@forgeax/engine-types...',
  '@forgeax/engine-net...',
  '@forgeax/engine-net-websocket...',
  '@forgeax/engine-assets-runtime...',
  '@forgeax/engine-vfx...',
  '@forgeax/engine-vfx-compiler...',
  '@forgeax/engine-vfx-render...',
  '@forgeax/engine-vite-plugin-shader...',
  '@forgeax/engine-vite-plugin-pack...',
  '@forgeax/engine-shader-compiler...',
  '@forgeax/engine-naga...',
  '@forgeax/engine-wgpu-wasm...',
  '@forgeax/engine-gltf...',
  '@forgeax/engine-image...',
  '@forgeax/engine-font...',
  '@forgeax/engine-pack...',
  '@forgeax/engine-project...',
  '@forgeax/engine-fbx...',
  '@forgeax/engine-npc...',
  '@forgeax/engine-vite-plugin-rhi-debug...',
] as const;

// Engine's aggregate tsconfig intentionally omits these packages, even though
// their public exports include ./dist/index.d.ts. Keep their declaration
// producers explicit here so Runtime SDK generation does not silently lose
// public package contracts. DevKit has no package-level typecheck script, so
// its composite tsconfig is invoked directly below.
export const ENGINE_STANDALONE_DECLARATION_FILTERS = [
  '@forgeax/engine-project',
  '@forgeax/engine-devkit',
] as const;

const ENGINE_STANDALONE_DECLARATION_COMMANDS: Record<
  (typeof ENGINE_STANDALONE_DECLARATION_FILTERS)[number],
  readonly string[]
> = {
  '@forgeax/engine-project': ['--filter', '@forgeax/engine-project', 'typecheck'],
  '@forgeax/engine-devkit': ['exec', 'tsc', '-b', 'packages/devkit'],
};

export interface BuildEnginePackagesOptions {
  readonly engineRoot: string;
  readonly filters?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export function buildEnginePackagesArgs(filters: readonly string[] = [ALL_ENGINE_PACKAGES_FILTER]): string[] {
  return [
    ...filters.flatMap((filter) => ['--filter', filter]),
    '-r',
    '--sort',
    'build',
  ];
}

function runEngineCommand(
  engineRoot: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  const result = spawnSync('pnpm', args, {
    cwd: engineRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

export function buildEnginePackages(options: BuildEnginePackagesOptions): boolean {
  const filters = options.filters ?? [ALL_ENGINE_PACKAGES_FILTER];
  return runEngineCommand(options.engineRoot, buildEnginePackagesArgs(filters), options.env ?? process.env);
}

export function buildEngineDeclarations(options: BuildEnginePackagesOptions): boolean {
  if (!buildEnginePackages(options)) return false;
  const env = options.env ?? process.env;
  if (!runEngineCommand(options.engineRoot, ['exec', 'tsc', '-b'], env)) return false;
  return ENGINE_STANDALONE_DECLARATION_FILTERS.every((filter) =>
    runEngineCommand(options.engineRoot, ENGINE_STANDALONE_DECLARATION_COMMANDS[filter], env));
}

if (import.meta.main) {
  const engineRootIndex = process.argv.indexOf('--engine-root');
  const engineRoot = engineRootIndex >= 0 ? process.argv[engineRootIndex + 1] : undefined;
  if (!engineRoot) {
    console.error('Usage: bun scripts/ci/build-engine-packages.ts --engine-root <path>');
    process.exit(2);
  }
  if (!buildEnginePackages({ engineRoot })) process.exit(1);
}
