#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

/**
 * The Engine's pnpm workspace is the authoritative package build graph.
 *
 * Do not recreate that graph from Studio-side manifest fields: Engine packages
 * can import another package for build-time reasons, and those edges may be
 * declared as devDependencies. pnpm sees the complete workspace graph and
 * topologically orders the build accordingly. The path filter intentionally
 * excludes Engine demo applications under `apps/`; they are not part of the
 * Runtime or Engine SDK closure.
 */
// Runtime artifacts snapshot Engine's package surface, not its example apps.
// A package-name glob also matches workspaces such as
// `@forgeax/engine-shadertoy-*`, so keep this boundary anchored to Engine's
// canonical `packages/` directory instead.
export const ALL_ENGINE_PACKAGES_FILTER = './packages/**';

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
  '@forgeax/engine-devkit...',
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

// These packages are imported by test-only project references before the
// aggregate Engine tsconfig reaches them. Seed them once on a cold graph so
// every producer can then participate in the strict workspace declaration
// pass. Keep this list aligned with forgeax-editor/scripts/fx.ts.
export const ENGINE_IMPLICIT_DECLARATION_PROJECTS = [
  'packages/render-graph/tsconfig.json',
  'packages/vfx-render/tsconfig.json',
  'packages/vfx-compiler/tsconfig.json',
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
  const declarationPass = ['exec', 'tsc', '-b', '--force', '--pretty', 'false'] as const;
  if (!runEngineCommand(options.engineRoot, declarationPass, env)) {
    console.warn('[engine] seeding implicit declaration producers before retrying the workspace graph ...');
    for (const project of ENGINE_IMPLICIT_DECLARATION_PROJECTS) {
      if (!runEngineCommand(
        options.engineRoot,
        ['exec', 'tsc', '-b', project, '--force', '--pretty', 'false'],
        env,
      )) return false;
    }
    if (!runEngineCommand(options.engineRoot, declarationPass, env)) return false;
  }
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
