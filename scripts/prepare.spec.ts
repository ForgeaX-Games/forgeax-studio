import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PREPARE_ENGINE_BUILD_FILTERS } from './ci/build-engine-packages';

const ROOT = resolve(import.meta.dir, '..');
const prepareSource = () => readFileSync(join(ROOT, 'scripts/prepare.ts'), 'utf8');
const runSource = () => readFileSync(join(ROOT, 'scripts/run.ts'), 'utf8');
const studioViteSource = () => readFileSync(join(ROOT, 'packages/studio/vite.config.ts'), 'utf8');
const engineEntryFreshnessSource = () =>
  readFileSync(join(ROOT, 'scripts/lib/engine-entry-freshness.ts'), 'utf8');

describe('scripts/prepare.ts contracts', () => {
  it('does not run root bun install (lifecycle already did)', () => {
    const src = prepareSource();
    expect(src).not.toContain('bunInstallWithRetry(ROOT)');
    expect(src).not.toContain("run('bun', ['install'], { cwd: ROOT");
    expect(src).not.toContain("run('bun', ['install', '--frozen-lockfile'], { cwd: ROOT");
    expect(src).not.toMatch(/spawnSync\([^)]*bun[^)]*install[^)]*cwd:\s*ROOT/s);
  });
  it('honours FORGEAX_SKIP_PREPARE and FORGEAX_FORCE_PREPARE', () => {
    const src = prepareSource();
    expect(src).toContain('FORGEAX_SKIP_PREPARE');
    expect(src).toContain('FORGEAX_FORCE_PREPARE');
  });
  it('builds linked shared contracts before the CLI consumes their exports', () => {
    const src = prepareSource();
    const contractsBuild = "spawnSync('node', ['scripts/build-packages.mjs']";
    const cliBuild = "spawnSync('bun', ['run', 'build']";
    expect(src).toContain("join(ROOT, 'packages/contracts')");
    expect(src).toContain('types/dist/permission-rules.js');
    expect(src).toContain('agent-runtime/dist/index.js');
    expect(src.indexOf(contractsBuild)).toBeLessThan(src.indexOf(cliBuild));
  });
  it('covers assets-runtime in prepare and start engine entry gates', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toMatch(/const engineEntryPkgs = \[[\s\S]*'assets-runtime'/);
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-assets-runtime...');
    expect(run).toMatch(/const engineEntryPkgs = \[[\s\S]*'assets-runtime'/);
  });
  it('covers every VFX package imported by editor config and runtime entry points', () => {
    const prepare = prepareSource();
    const run = runSource();
    for (const packageName of ['vfx', 'vfx-compiler', 'vfx-render']) {
      expect(prepare).toMatch(new RegExp(`engineEntryPkgs\\s*=\\s*\\[[\\s\\S]*['"]${packageName}['"]`));
      expect(run).toMatch(new RegExp(`engineEntryPkgs\\s*=\\s*\\[[\\s\\S]*['"]${packageName}['"]`));
      expect(PREPARE_ENGINE_BUILD_FILTERS).toContain(`@forgeax/engine-${packageName}...`);
    }
  });
  it('requires declaration outputs for engine entry freshness gates', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toContain('ENGINE_ENTRY_OUTPUTS');
    expect(prepare).toContain('isEngineEntryDistFresh(pdir, engineDeclarationSentinel)');
    expect(run).toContain('ENGINE_ENTRY_OUTPUTS');
    expect(run).toContain('isEngineEntryDistFresh(join(enginePkgDir, p), engineDeclarationSentinel)');
    expect(engineEntryFreshnessSource()).toContain("['index.mjs', 'index.d.ts']");
  });
  it('records a freshness sentinel after successful incremental declaration builds', () => {
    const src = prepareSource();
    expect(src).toContain(".forgeax/sentinels/engine-declarations.built");
    expect(src).toContain('if (declarationsBuilt)');
    expect(src).toContain('writeFileSync(engineDeclarationSentinel');
  });
  it('repairs @forgeax links in both the worktree root and Studio roots', () => {
    const src = prepareSource();
    expect(src).toMatch(
      /const forgeaxLinkRoots = \[[\s\S]*join\(ROOT, 'node_modules\/@forgeax'\)[\s\S]*join\(ROOT, 'packages\/studio\/node_modules\/@forgeax'\)/,
    );
    expect(src).toContain('ensureWorkspacePackageLink(linkPath, join(parent, e.name), ROOT, isWin)');
    expect(src).toContain('existing path is not a symlink; leaving it unchanged');
  });
  it('honours FORGEAX_SKIP_HARNESS (skip harness sync + skill install)', () => {
    const src = prepareSource();
    expect(src).toContain('FORGEAX_SKIP_HARNESS');
    expect(src).toMatch(/FORGEAX_SKIP_HARNESS\s*===\s*['"]1['"]/);
  });
  it('provisions toolchain via bootstrap.ts (gated) and keeps the hard gate', () => {
    const src = prepareSource();
    expect(src).toContain('bootstrap.ts');
    expect(src).toContain('FORGEAX_SKIP_BOOTSTRAP');
    expect(src).toContain("has('git')");
    expect(src).toContain("has('pnpm')");
  });
  it('preserves prebuilt-release wasm fetch + codec provisioning', () => {
    const src = prepareSource();
    expect(src).toContain('tryFetchWasm');
    expect(src).toContain('ensureEngineWgpuWasm');
    expect(src).toContain('@forgeax/engine-codec');
    expect(src).toContain('healDanglingEngineSymlinks');
  });
  it('treats the scaffold NPC adapter as a required cached engine entry', () => {
    const src = prepareSource();
    expect(src).toMatch(/engineEntryPkgs\s*=\s*\[[^\]]*['"]npc['"]/);
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-npc...');
  });
  it('builds the network packages required by the editor engine Vitest graph', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toMatch(/engineEntryPkgs\s*=\s*\[[\s\S]*['"]net['"]/);
    expect(run).toMatch(/engineEntryPkgs\s*=\s*\[[\s\S]*['"]net['"]/);
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-net...');
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-net-websocket...');
    expect(prepare).toContain("join(enginePkgDir, 'net-websocket', 'dist', 'browser.mjs')");
    expect(prepare).toContain("join(enginePkgDir, 'net-websocket', 'dist', 'node.mjs')");
  });
  it('uses each standalone plugin package manager while preserving Bun retry behavior', () => {
    const src = prepareSource();
    expect(src).not.toMatch(/statSync\(nm\)\.mtimeMs\s*>\s*statSync\(join\(dir,\s*['"]package\.json['"]\)\)\.mtimeMs/);
    expect(src).toContain('resolvePluginPackageManager(d, pkg, e.name)');
    expect(src).toContain("extensionPackageManager(pkg ?? {}, fallback)");
    expect(src).toContain('extensionPackageManagerFallback');
    expect(src).toContain("join(dir, 'bun.lock')");
    expect(src).toContain("run('pnpm', installArgs, { cwd: dir, env: gitEnv })");
    expect(src).toContain('ensurePluginPlaywrightBrowsers(d, e.name)');
    expect(src).toContain("join(dir, 'node_modules/playwright/cli.js')");
    expect(src).toContain("['install', 'chromium', 'chromium-headless-shell']");
    expect(src).toContain('PLAYWRIGHT_DOWNLOAD_MIRROR');
    expect(src).toContain('PLAYWRIGHT_DOWNLOAD_HOST');
    expect(src).toContain('configured public browser mirror');
    expect(src).toContain('normalizePackageManagerRegistry');
    expect(src).toContain('npm_config_registry');
    expect(src).toContain('repairPluginDirectoryLink(d)');
    expect(src).toContain('if (bunInstallWithRetry(dir))');
    expect(src).toContain("run('bun', installArgs, { cwd: dir, env: gitEnv })");
    expect(src).toContain("else fail(`${dir} dependency install failed`)");
    expect(src).not.toContain('dependency install failed — continuing');
    expect(src).not.toContain("['install', '--ignore-scripts']");
  });
  it('does not retry optional headless renderers when their browser cache is unavailable', () => {
    const src = runSource();
    expect(src).toContain('hasPlaywrightHeadlessBrowser(p.dir)');
    expect(src).toContain('headless renderer skipped: Playwright browser unavailable');
    expect(src).toContain("chromium.launch({headless:true})");
  });
  it('keeps Studio config compatible with the current editor preset and diagnostics facade', () => {
    const src = studioViteSource();
    expect(src).toContain("from '../editor/scripts/vite/engine-vite-preset'");
    expect(src).toContain("'@forgeax/editor-core/diagnostics'");
    expect(src).toContain("packages/core/src/io/diagnostics.ts");
  });
  // Regression: Studio mounted the preview panel shells but never injected the
  // host preview viewports, so material/mesh/vfx previews rendered the
  // "not registered by the host" placeholder. The wiring must go through the
  // @forgeax/editor/previews facade subpath (boundary rule 6), at module scope.
  it('registers the editor preview viewports through the facade at module scope', () => {
    const src = readFileSync(join(ROOT, 'packages/studio/src/panels/editorRenderers.tsx'), 'utf8');
    expect(src).toContain("from '@forgeax/editor/previews'");
    expect(src).toContain('registerEditorPreviewViewports()');
    const editorPkg = JSON.parse(
      readFileSync(join(ROOT, 'packages/editor/package.json'), 'utf8'),
    ) as { exports?: Record<string, string> };
    expect(editorPkg.exports?.['./previews']).toBe(
      './packages/edit-runtime/src/viewport/preview-registrations.ts',
    );
  });
  it('fails prepare when plugin dependencies, builds, or required runtime artefacts are incomplete', () => {
    const src = prepareSource();
    expect(src).toContain("join(pluginsDir, '_shared')");
    expect(src).toContain('dependency install failed');
    expect(src).toContain('plugin build failed');
    expect(src).toContain('required engine artefacts missing after prepare');
    expect(src).toContain('required CLI artefact missing after prepare');
  });
  it('builds the engine package imported by the new-game NPC template', () => {
    const src = prepareSource();
    expect(src).toContain("'npc'");
    expect(PREPARE_ENGINE_BUILD_FILTERS).toContain('@forgeax/engine-npc...');
  });
  it('installs plugins before running bounded parallel builds', () => {
    const src = prepareSource();
    expect(src).toContain('FORGEAX_PLUGIN_BUILD_CONCURRENCY');
    expect(src).toContain('mapConcurrent(builds, concurrency');
    expect(src.indexOf('installDir(d)')).toBeLessThan(src.indexOf('mapConcurrent(builds, concurrency'));
  });
  it('does not bypass the asset-canvas plugin build', () => {
    const src = prepareSource();
    expect(src).not.toContain('localOnlyPluginRequirements');
    expect(src).not.toContain('local-only source dependency absent (skipped)');
  });
  it('treats an incomplete wgpu/codec pkg/ as stale (gates on the glue, not just .wasm)', () => {
    const src = prepareSource();
    // wgpuWasmStale must re-provision when the JS glue engine-app imports is
    // missing — not just when wgpu_wasm_bg.wasm is absent.
    expect(src).toContain('!existsSync(wasmArtefact) || !existsSync(wgpuJs)');
    // codec skip must gate on the .mjs loaders too, not only the .wasm binaries.
    expect(src).toContain('codecTranscoderMjs');
    expect(src).toContain('codecEncoderMjs');
  });
  it('updates submodules with credential-hardened env and reports at end', () => {
    const src = prepareSource();
    expect(src).not.toContain('submodule.recurse');
    expect(src).toContain("'submodule', 'update', '--init', '--recursive', ...depth, '--', path]");
    expect(src).not.toContain("fail('git submodule update failed.')");
    expect(src).toContain('formatPrepareReport');
  });

  it('can trust the parallel worktree bootstrap instead of repeating serial submodule init', () => {
    const src = prepareSource();
    expect(src).toContain('FORGEAX_SKIP_SUBMODULE_INIT');
    expect(src).toContain('materialized by bun fx worktree');
  });
  it('prints per-submodule start/end diagnostics with exit and duration', () => {
    const src = prepareSource();
    expect(src).toContain('[submodule:start]');
    expect(src).toContain('[submodule:end]');
    expect(src).toContain('duration_ms=');
  });
  it('prints bun fx start as the next step, no auto-start', () => {
    const src = prepareSource();
    expect(src).toContain('bun fx start');
    expect(src).not.toContain("['fx', 'start']");
  });
  it('does not require Git metadata when preparing the public distribution', () => {
    const src = prepareSource();
    expect(src).toContain('if (publicDistribution)');
    expect(src).toContain('recursive input result skipped (public distribution has no Git metadata)');
    expect(src.indexOf('recursive input result skipped')).toBeLessThan(src.indexOf('writeRecursiveInputResult(ROOT)'));
  });
  it('scaffolds .env silently without readline key prompt', () => {
    const src = prepareSource();
    expect(src).not.toContain('createInterface');
    expect(src).not.toContain('ANTHROPIC_API_KEY (Enter to skip)');
  });
});
