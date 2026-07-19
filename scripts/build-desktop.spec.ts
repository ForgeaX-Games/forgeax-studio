import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

describe('desktop build pack scan scope', () => {
  it('builds play-runtime against the bundled games scope, not local .forgeax/games', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.sh'), 'utf8');
    const playRuntimeViteConfig = readFileSync(
      join(root, 'packages/editor/packages/play-runtime/vite.config.ts'),
      'utf8',
    );

    expect(playRuntimeViteConfig).toContain('FORGEAX_PREVIEW_GAMES_DIR');
    expect(buildScript).toContain('DESKTOP_PREVIEW_GAMES_DIR=');
    expect(buildScript).toContain('FORGEAX_PREVIEW_GAMES_DIR="$DESKTOP_PREVIEW_GAMES_DIR"');
    expect(buildScript).toContain('bun x vite build');
  });
});

describe('desktop server runtime closure', () => {
  it('vendors every workspace package that @forgeax/server value-imports', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.sh'), 'utf8');

    for (const pkg of [
      '@forgeax/orchestrator',
      '@forgeax/agent-host',
      '@forgeax/agent-runtime',
      '@forgeax/cli',
      '@forgeax/platform-io',
      '@forgeax/types',
    ]) {
      expect(buildScript).toContain(pkg);
    }
  });
});
