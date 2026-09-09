import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = resolve(import.meta.dir, '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const extensionRepositories = [
  'agent-asset-production',
  'agent-defaults',
  'agent-game-production',
  'agent-monitor',
  'agent-programming-personas',
  'agent-scene-media',
  'ai-asset',
  'animation',
  'asset-canvas',
  'automation-packs',
  'bgm',
  'character',
  'character-3d',
  'cli-providers',
  'diffusion-renderer',
  'item-catalog',
  'material',
  'narrative',
  'node-core',
  'plugin-author',
  'reel',
  'scene-generator',
  'skill-effects',
  'ui',
  'utilities',
  'video-game',
] as const;

describe('Studio .packages ownership contract', () => {
  test('declares floating dependency checkouts in one manifest', () => {
    const entries = JSON.parse(read('.packages')) as Array<Record<string, unknown>>;
    expect(entries.slice(0, 7)).toEqual([
      {
        path: 'packages/harness',
        url: 'https://github.com/ForgeaX-Games/forgeax-harness.git',
        branch: 'main',
      },
      {
        path: 'packages/games',
        url: 'https://github.com/ForgeaX-Games/forgeax-games.git',
        branch: 'main',
        optional: true,
        skipEnv: 'FORGEAX_SKIP_GAMES',
      },
      {
        path: 'packages/ide',
        url: 'https://github.com/ForgeaX-Games/forgeax-ide.git',
        branch: 'main',
      },
      {
        path: 'packages/extension-platform',
        url: 'https://github.com/ForgeaX-Games/forgeax-extension-platform.git',
        branch: 'main',
      },
      {
        path: 'packages/app-shell',
        url: 'https://github.com/ForgeaX-Games/forgeax-app-shell.git',
        branch: 'main',
      },
      {
        path: 'packages/kino-video-provider',
        url: 'https://github.com/ForgeaX-Games/forgeax-kino-video-provider.git',
        branch: 'main',
      },
      {
        path: 'packages/agents',
        url: 'https://github.com/ForgeaX-Games/forgeax-agents.git',
        branch: 'main',
      },
    ]);
    expect(entries.slice(7)).toEqual(extensionRepositories.map((repository) => ({
      path: `packages/ex-${repository}`,
      url: `https://github.com/ForgeaX-Games/forgeax-ex-${repository}.git`,
      branch: 'main',
    })));
    expect(read('.gitignore')).toContain('/.packages.local');
    expect(read('.gitignore')).toContain('/packages/ide/');
    expect(read('.gitignore')).toContain('/packages/extension-platform/');
    expect(read('.gitignore')).toContain('/packages/app-shell/');
    expect(read('.gitignore')).toContain('/packages/kino-video-provider/');
    expect(read('.gitignore')).toContain('/packages/agents/');
    expect(read('.gitignore')).toContain('/packages/asset-canvas-core/');
    expect(read('.gitignore')).toContain('/packages/ex-*/');
    expect(entries).not.toContainEqual(expect.objectContaining({ path: 'packages/asset-canvas-core' }));
    expect(read('.gitmodules')).not.toContain('path = packages/asset-canvas-core');
  });

  test('uses the generic manager from install, update, and the game opt-in command', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['games:sync']).toBe('bun fx packages ensure --only games');
    for (const contract of [
      'scripts/lib/package-manifest.spec.ts',
      'scripts/lib/package-sync.integration.test.ts',
      'scripts/packages-cli.integration.test.ts',
      'scripts/packages-contract.spec.ts',
    ]) expect(pkg.scripts['test:layers']).toContain(contract);
    expect(read('scripts/prepare.ts')).toContain("scripts/packages.ts");
    expect(read('scripts/fx.ts')).toContain("script('packages.ts')");
    expect(existsSync(resolve(ROOT, 'scripts/sync-package-harness.mjs'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'scripts/sync-games.mjs'))).toBe(false);
  });

  test('does not declare the retired Marketplace repository as a gitlink', () => {
    const gitmodules = read('.gitmodules');
    expect(gitmodules).not.toContain('path = packages/marketplace');
    expect(gitmodules).not.toContain('[submodule "marketplace"]');
  });

  test('keeps npm-consumed sources as floating development checkouts, not gitlinks', () => {
    expect(read('.gitmodules')).not.toContain('packages/extension-platform');
    expect(read('.gitmodules')).not.toContain('packages/app-shell');
    expect(read('.gitmodules')).not.toContain('packages/kino-video-provider');
    const entries = JSON.parse(read('.packages')) as Array<Record<string, unknown>>;
    expect(entries).toContainEqual({
      path: 'packages/extension-platform',
      url: 'https://github.com/ForgeaX-Games/forgeax-extension-platform.git',
      branch: 'main',
    });
    expect(entries).toContainEqual({
      path: 'packages/app-shell',
      url: 'https://github.com/ForgeaX-Games/forgeax-app-shell.git',
      branch: 'main',
    });
    expect(entries).toContainEqual({
      path: 'packages/kino-video-provider',
      url: 'https://github.com/ForgeaX-Games/forgeax-kino-video-provider.git',
      branch: 'main',
    });
    const pkg = JSON.parse(read('package.json')) as { workspaces?: string[] };
    expect(pkg.workspaces).not.toContain('packages/kino-video-provider');
  });

  test('ships the floating package manifest in the active public mirror assembler', () => {
    expect(read('scripts/mirror/publish-multi.sh')).toMatch(/for f in [^\n]*\.packages/);
  });

});
