import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const prepareSource = () => readFileSync(join(ROOT, 'scripts/prepare.ts'), 'utf8');

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
  it('scaffolds .env silently without readline key prompt', () => {
    const src = prepareSource();
    expect(src).not.toContain('createInterface');
    expect(src).not.toContain('ANTHROPIC_API_KEY (Enter to skip)');
  });
});
