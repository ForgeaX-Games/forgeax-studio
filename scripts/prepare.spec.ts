import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const prepareSource = () => readFileSync(join(ROOT, 'scripts/prepare.ts'), 'utf8');
const runSource = () => readFileSync(join(ROOT, 'scripts/run.ts'), 'utf8');

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
  it('covers assets-runtime in prepare and start engine entry gates', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toMatch(/const engineEntryPkgs = \[[\s\S]*'assets-runtime'/);
    expect(prepare).toContain("'@forgeax/engine-assets-runtime...'");
    expect(run).toMatch(/const engineEntryPkgs = \[[\s\S]*'assets-runtime'/);
  });
  it('requires declaration outputs for engine entry freshness gates', () => {
    const prepare = prepareSource();
    const run = runSource();
    expect(prepare).toContain("const engineEntryOutputs = ['index.mjs', 'index.d.ts'];");
    expect(prepare).toContain('Math.min(...outputs.map((output) => statSync(output).mtimeMs))');
    expect(prepare).toContain("dist/index.d.ts");
    expect(run).toContain("const engineEntryOutputs = ['index.mjs', 'index.d.ts'];");
    expect(run).toContain('Math.min(...outputs.map((output) => statSync(output).mtimeMs))');
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
    expect(src).toContain('@forgeax/engine-codec');
    expect(src).toContain('healDanglingEngineSymlinks');
  });
  it('always lets bun verify standalone plugin installs instead of trusting node_modules mtime', () => {
    const src = prepareSource();
    expect(src).not.toMatch(/statSync\(nm\)\.mtimeMs\s*>\s*statSync\(join\(dir,\s*['"]package\.json['"]\)\)\.mtimeMs/);
    expect(src).toContain('if (bunInstallWithRetry(dir))');
    expect(src).toContain("else fail(`${dir} dependency install failed`)");
    expect(src).not.toContain('dependency install failed — continuing');
    expect(src).not.toContain("['install', '--ignore-scripts']");
  });
  it('fails prepare when plugin dependencies, builds, or required runtime artefacts are incomplete', () => {
    const src = prepareSource();
    expect(src).toContain("join(pluginsDir, '_shared')");
    expect(src).toContain('dependency install failed');
    expect(src).toContain('build failed');
    expect(src).toContain('required engine artefacts missing after prepare');
    expect(src).toContain('required CLI artefact missing after prepare');
  });
  it('builds the engine package imported by the new-game NPC template', () => {
    const src = prepareSource();
    expect(src).toContain("'npc'");
    expect(src).toContain("'@forgeax/engine-npc...'");
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
    expect(src).toContain('setup version snapshot skipped (public distribution has no Git metadata)');
    expect(src.indexOf('setup version snapshot skipped')).toBeLessThan(src.indexOf('writeSetupSnapshot(ROOT)'));
  });
  it('scaffolds .env silently without readline key prompt', () => {
    const src = prepareSource();
    expect(src).not.toContain('createInterface');
    expect(src).not.toContain('ANTHROPIC_API_KEY (Enter to skip)');
  });
});
