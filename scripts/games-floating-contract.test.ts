import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = resolve(import.meta.dir, '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('optional forgeax-games consumer checkout', () => {
  test('is not part of the Studio gitlink graph', () => {
    expect(read('.gitmodules')).not.toContain('path = packages/games');
    expect(read('.gitignore')).toContain('/packages/games/');

    const packageJson = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['games:sync']).toBe('node scripts/sync-games.mjs --ensure');
    expect(packageJson.scripts?.['test:game-npc']).toBeUndefined();
    expect(packageJson.scripts?.['test:game-imports']).toBeUndefined();
    expect(packageJson.scripts?.['test:game-input']).toBeUndefined();
    expect(packageJson.scripts?.['lint:game-imports']).toBeUndefined();
    expect(packageJson.scripts?.['lint:game-input']).toBeUndefined();
    expect(packageJson.scripts?.['lint:game-npc']).toBeUndefined();
    for (const file of [
      'scripts/check-game-engine-imports.ts',
      'scripts/check-game-engine-imports.spec.ts',
      'scripts/check-game-input-contract.ts',
      'scripts/check-game-input-contract.spec.ts',
      'scripts/check-game-npc-contract.ts',
      'packages/studio/src/editor-product/acceptance-fixture.test.ts',
    ]) {
      expect(existsSync(resolve(ROOT, file)), file).toBe(false);
    }
  });

  test('has an explicit optional floating-checkout sync path', () => {
    const syncScript = resolve(ROOT, 'scripts/sync-games.mjs');
    expect(existsSync(syncScript)).toBe(true);
    const source = read('scripts/sync-games.mjs');
    expect(source).toContain('forgeax-games.git');
    expect(source).toContain('--ensure');
    expect(source).toContain('--update');
    expect(source).toContain('FORGEAX_SKIP_GAMES');
    expect(read('scripts/prepare.ts')).toContain('FORGEAX_SKIP_GAMES');
    expect(read('scripts/prepare.ts')).toContain('sync-games.mjs');
    expect(read('scripts/run.ts')).toContain('FORGEAX_SKIP_GAMES');
    expect(read('scripts/build-desktop.ts')).toContain('FORGEAX_SKIP_GAMES');
    expect(read('scripts/fx.ts')).toContain("path: 'packages/games'");
  });

  test('makes CI explicitly skip the optional games checkout', () => {
    for (const workflow of [
      '.github/workflows/ci.yml',
      '.github/workflows/boundaries.yml',
      '.github/workflows/desktop-build.yml',
      '.github/workflows/game-runtime-publish.yml',
      '.github/workflows/nightly-e2e.yml',
      '.github/workflows/weekly-release.yml',
      '.github/workflows/mirror-multi.yml',
      '.github/workflows/mirror-publish-dryrun.yml',
    ]) {
      expect(read(workflow), workflow).toContain('FORGEAX_SKIP_GAMES');
    }
    expect(read('.github/workflows/ci.yml')).not.toContain('FORGEAX_STUDIO_SMOKE_GAME');
    expect(read('scripts/ci/run-post-install-checks.ts')).not.toContain('check-game-');
  });

  test('keeps the local fast CI on Studio contracts, not consumer game fixtures', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['lint:boundaries']).not.toContain('game-');
    expect(packageJson.scripts?.['test:boundaries:fs']).not.toContain('game-');
    expect(packageJson.scripts?.['test:boundaries']).not.toContain('game-');
    expect(read('scripts/fx.ts')).toContain('FORGEAX_SKIP_GAMES');
    expect(read('scripts/fx.ts')).toContain('games floating checkout contract');
  });
});
