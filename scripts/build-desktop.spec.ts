import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopServerEntryAdapter } from './lib/server-role.ts';
import { sidecarNameForTriple } from './lib/runtime-resource-assembler.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('desktop build pack scan scope', () => {
  it('builds a generic play shell without a sibling-games asset producer', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');
    const playRuntimeViteConfig = readFileSync(
      join(root, 'packages/editor/packages/play-runtime/vite.config.ts'),
      'utf8',
    );

    expect(playRuntimeViteConfig).not.toContain('FORGEAX_PREVIEW_GAMES_DIR');
    expect(buildScript).not.toContain('FORGEAX_PREVIEW_GAMES_DIR');
    expect(buildScript).toContain('generic Play shell');
    expect(buildScript).toContain("run('bun', ['x', 'vite', 'build']");
  });

  it('bundles the shared startup launcher into the desktop payload', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');
    const tauriShell = readFileSync(
      join(root, 'packages/interface/src-tauri/src/lib.rs'),
      'utf8',
    );

    expect(buildScript).toContain("'runtime', 'local-runtime.mjs'");
    expect(buildScript).toContain("'scripts', 'local-runtime.ts'");
    expect(buildScript).toContain("'--target=bun'");
    expect(tauriShell.match(/\.sidecar\("bun"\)/g)).toHaveLength(1);
    expect(tauriShell).toContain('FORGEAX_STARTUP_PROFILE", "desktop-prod');
    expect(tauriShell).toContain('FORGEAX_RUNTIME_STATE_FILE');
    expect(tauriShell).not.toContain('fn http_ok(');
    expect(tauriShell).not.toContain('fn setup_engine_work(');
    expect(tauriShell).not.toContain('fn seed_shared_games(');
  });
});

describe('desktop server runtime closure', () => {
  it('seeds and recursively expands the active server workspace dependencies', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');

    expect(buildScript).toContain("readJson(join(activeServer.packageDir, 'package.json'))");
    expect(buildScript).toContain('Object.keys(serverPkg.dependencies ?? {})');
    expect(buildScript).toContain('Object.keys(pj.dependencies ?? {})');
    expect(buildScript).toContain("if (dep.startsWith('@forgeax/')) queue.push(dep)");
    expect(buildScript).toContain("copyTree(join(ROOT, 'brand'), join(RES, 'brand')");
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

describe('desktop and Game Runtime sidecar naming', () => {
  it('shares the canonical cross-platform sidecar filename helper', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');
    expect(buildScript).toContain('sidecarNameForTriple(triple)');
    expect(sidecarNameForTriple('x86_64-pc-windows-msvc')).toEndWith('.exe');
    expect(sidecarNameForTriple('x86_64-unknown-linux-gnu')).not.toEndWith('.exe');
  });
});
