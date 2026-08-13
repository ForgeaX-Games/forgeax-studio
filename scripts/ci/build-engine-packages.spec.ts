import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_ENGINE_PACKAGES_FILTER,
  ENGINE_STANDALONE_DECLARATION_FILTERS,
  PREPARE_ENGINE_BUILD_FILTERS,
  buildEnginePackagesArgs,
} from './build-engine-packages';

describe('Engine package build graph command', () => {
  test('executes when invoked as the CI entrypoint', () => {
    expect(readFileSync(join(import.meta.dir, 'build-engine-packages.ts'), 'utf8')).toContain('if (import.meta.main)');
  });

  test('uses pnpm topological sorting instead of a Studio-owned dependency graph', () => {
    expect(buildEnginePackagesArgs()).toEqual([
      '--filter',
      ALL_ENGINE_PACKAGES_FILTER,
      '-r',
      '--sort',
      'build',
    ]);
  });

  test('prepare reuses the same ordered command with its narrower package closure', () => {
    const args = buildEnginePackagesArgs(PREPARE_ENGINE_BUILD_FILTERS);
    expect(args.slice(-3)).toEqual(['-r', '--sort', 'build']);
    expect(args).toContain('@forgeax/engine-fbx...');
  });

  test('keeps declarations for Engine packages omitted from the aggregate tsconfig', () => {
    expect(ENGINE_STANDALONE_DECLARATION_FILTERS).toEqual(['@forgeax/engine-project']);
  });
});
