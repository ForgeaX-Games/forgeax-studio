import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewritePackagedEngineViteConfig } from './lib/desktop-engine-config.ts';
import { desktopServerEntryAdapter } from './lib/server-role.ts';
import { sidecarNameForTriple } from './lib/runtime-resource-assembler.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('desktop build pack scan scope', () => {
  it('keeps nested payload installs independent of private harness state', () => {
    const workflow = readFileSync(
      join(root, '.github/workflows/desktop-build.yml'),
      'utf8',
    );

    expect(workflow).toMatch(/^\s{2}FORGEAX_SKIP_HARNESS: '1'$/m);
    expect(workflow).toMatch(/^\s{2}FORGEAX_SKIP_BOOTSTRAP: '1'$/m);
  });

  it('syncs the shipping version and preserves installer paths containing spaces', () => {
    const workflow = readFileSync(
      join(root, '.github/workflows/desktop-build.yml'),
      'utf8',
    );

    expect(workflow).toContain('syncReleaseVersion');
    expect(workflow).toContain('test "v${ROOT_VERSION}" = "${{ github.event.inputs.version }}"');
    expect(workflow).toContain("while IFS= read -r -d '' f; do");
    expect(workflow).toContain('-print0');
    expect(workflow).not.toContain('for f in $(find "$BUNDLE_DIR"');
    expect(workflow).not.toContain('|| echo "::warning::Failed to upload');
  });

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
  it('rewrites play-runtime imports that cannot resolve after packaging', () => {
    const playRuntimeViteConfig = readFileSync(
      join(root, 'packages/editor/packages/play-runtime/vite.config.ts'),
      'utf8',
    );
    const packaged = rewritePackagedEngineViteConfig(playRuntimeViteConfig);

    expect(packaged).toContain("from './engine-vite-preset.mjs'");
    expect(packaged).toContain("from '@forgeax/editor-core/asset-roots'");
    expect(packaged).not.toContain("from '../../scripts/vite/engine-vite-preset'");
    expect(packaged).not.toContain("from '../core/src/asset-roots'");
  });

  it('seeds and recursively expands the active server workspace dependencies', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');

    expect(buildScript).toContain("readJson(join(activeServer.packageDir, 'package.json'))");
    expect(buildScript).toContain('Object.keys(serverPkg.dependencies ?? {})');
    expect(buildScript).toContain('Object.keys(pj.dependencies ?? {})');
    expect(buildScript).toContain("if (dep.startsWith('@forgeax/')) queue.push(dep)");
    expect(buildScript).toContain("copyTree(join(ROOT, 'packages/brand'), join(RES, 'brand')");
  });

  it('does not package generated Engine build-control markers', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');

    expect(buildScript).toContain("const ENGINE_RUNTIME_COPY_EXCLUDES = new Set(['.gitignore'])");
    expect(buildScript).toContain(
      "const PREVIEW_PACKAGE_COPY_EXCLUDES = new Set(['node_modules', 'target', '.git', '.gitignore'])",
    );
    expect(buildScript).toContain(
      "copyTree(join(dir, 'pkg'), join(dest, 'pkg'), ENGINE_RUNTIME_COPY_EXCLUDES)",
    );
    expect(buildScript).toContain(
      "copyTree(pkgdir, join(ENG, 'node_modules', pj.name), PREVIEW_PACKAGE_COPY_EXCLUDES)",
    );
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
