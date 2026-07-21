import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopServerEntryAdapter } from './lib/server-role.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('desktop build pack scan scope', () => {
  it('builds play-runtime against the bundled games scope, not local .forgeax/games', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');
    const playRuntimeViteConfig = readFileSync(
      join(root, 'packages/editor/packages/play-runtime/vite.config.ts'),
      'utf8',
    );

    expect(playRuntimeViteConfig).toContain('FORGEAX_PREVIEW_GAMES_DIR');
    expect(buildScript).toContain("process.env.FORGEAX_PREVIEW_GAMES_DIR = join(ROOT, 'packages/games')");
    expect(buildScript).toContain("run('bun', ['x', 'vite', 'build']");
  });
});

describe('desktop server runtime closure', () => {
  it('seeds and recursively expands the active server workspace dependencies', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');

    expect(buildScript).toContain("readJson(join(activeServer.packageDir, 'package.json'))");
    expect(buildScript).toContain('Object.keys(serverPkg.dependencies ?? {})');
    expect(buildScript).toContain('Object.keys(pj.dependencies ?? {})');
    expect(buildScript).toContain("if (dep.startsWith('@forgeax/')) queue.push(dep)");
  });
});

describe('desktop server entry adapter', () => {
  it('does not overwrite the fixed desktop entry', () => {
    expect(desktopServerEntryAdapter('src/main.ts')).toBeNull();
  });

  it('dynamically imports a nested active entry', () => {
    expect(desktopServerEntryAdapter('src/runtime/boot.ts')).toBe(
      'await import("./runtime/boot.ts");\n',
    );
  });

  it('keeps generated import paths POSIX-safe on Windows', () => {
    const adapter = desktopServerEntryAdapter('src/nested/deep/main.ts');

    expect(adapter).toContain('./nested/deep/main.ts');
    expect(adapter).not.toContain('\\');
  });
});
