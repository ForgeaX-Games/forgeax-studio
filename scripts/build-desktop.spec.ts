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

  it('uses the NSIS Windows installer instead of the large-payload WiX linker', () => {
    const workflow = readFileSync(
      join(root, '.github/workflows/desktop-build.yml'),
      'utf8',
    );

    expect(workflow).toContain('"ext":"exe"');
    expect(workflow).toContain('"tauri_args":"--bundles nsis"');
    expect(workflow).not.toContain('"ext":"msi"');
    expect(workflow).toContain('Measure Windows desktop payload');
    expect(workflow).toContain('Payload: {0:N2} GiB across {1:N0} files');
    expect(workflow).toContain('windows_only:');
    expect(workflow).not.toContain('macos-13');
  });

  it('derives the packaged server role from the desktop bundle profile', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');

    expect(buildScript).toContain('resolveDesktopBundleProfile(process.env)');
    expect(buildScript).toContain('desktopBundleServerProfile(DESKTOP_BUNDLE_PROFILE)');
    expect(buildScript).toContain('profile: desktopBundleServerProfile(DESKTOP_BUNDLE_PROFILE)');
    expect(buildScript).not.toContain('FORGEAX_SERVER_PROFILE');
  });

  it('keeps full resources intact while selecting lite extensions and excluding games', () => {
    const buildScript = readFileSync(join(root, 'scripts/build-desktop.ts'), 'utf8');

    expect(buildScript).toContain("scanDesktopExtensions(join(ROOT, 'packages/marketplace/extensions'))");
    expect(buildScript).toContain("selectDesktopExtensionClosure(parsedExtensions, 'lite')");
    expect(buildScript).toContain("const selectorModule = './lib/desktop-extension-selection.ts'");
    expect(buildScript).toContain('await import(selectorModule)');
    expect(buildScript).not.toMatch(/from ['"]\.\/lib\/desktop-extension-selection\.ts['"]/);
    expect(buildScript).toContain("new Set(['extensions', 'plugins', 'node_modules', '.git'])");
    expect(buildScript).toContain("join(RES, 'marketplace/extensions', desktopExtensionOutputName(extension))");
    expect(buildScript).toContain("copyTree(join(ROOT, 'packages/marketplace'), join(RES, 'marketplace'), new Set(['node_modules', '.git', 'plugins']))");
    expect(buildScript).toContain("copyTree(join(ROOT, 'packages/marketplace/extensions'), join(RES, 'marketplace/extensions'), new Set(['node_modules', '.git']), true)");
    expect(buildScript).toContain("process.env.FORGEAX_SKIP_GAMES === '1'");
    expect(buildScript).toContain('process.env.DESKTOP_GAMES');
    expect(buildScript).toContain("DESKTOP_BUNDLE_PROFILE === 'lite'");
    expect(buildScript).toContain('desktopBundleManifest(DESKTOP_BUNDLE_PROFILE)');
    expect(buildScript).toContain("join(RES, 'runtime', 'desktop-bundle.json')");
    expect(buildScript).toContain("existsSync(join(RES, 'games'))");
    expect(buildScript).toContain('capabilities.productWorkbench');
    expect(buildScript).toContain("full desktop bundle cannot set FORGEAX_SKIP_GAMES=1");
    expect(buildScript).toContain("full desktop bundle must contain at least one sample game");
    expect(buildScript).toContain("IS_PLUGIN_RUNTIME");
    expect(buildScript).toContain("desktop bundle manifest — skipped for Game Runtime staging");
    expect(buildScript).toContain('required copy failed');
    expect(buildScript).toContain('full desktop bundle extension count mismatch');
    expect(buildScript).toContain('lite desktop bundle extension mismatch');
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
    expect(buildScript).toContain(
      "const DESKTOP_CONTROL_PATH_EXCLUDES = new Set(['.forgeax-harness'])",
    );
    expect(buildScript).toContain('if (DESKTOP_CONTROL_PATH_EXCLUDES.has(base)) return true');
  });

  it('rejects private harness state if payload assembly ever regresses', () => {
    const workflow = readFileSync(
      join(root, '.github/workflows/desktop-build.yml'),
      'utf8',
    );

    expect(workflow).toContain("-Filter '.forgeax-harness'");
    expect(workflow).toContain('private harness-state directories');
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
