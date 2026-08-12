import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureEngineWgpuWasm } from './ensure-engine-wgpu-wasm';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-engine-wgpu-wasm-'));
  fixtures.push(root);
  return root;
}

describe('Engine wgpu WASM provisioning contract', () => {
  test('accepts the complete wasm-pack output without invoking a toolchain', () => {
    const root = fixture();
    const pkg = join(root, 'packages/editor/packages/engine/packages/wgpu-wasm/pkg');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'wgpu_wasm.js'), 'glue');
    writeFileSync(join(pkg, 'wgpu_wasm_bg.wasm'), 'wasm');

    expect(ensureEngineWgpuWasm({ root, strict: true })).toBe(true);
  });

  test('fails closed when the Engine wgpu package is absent', () => {
    const root = fixture();

    expect(() => ensureEngineWgpuWasm({ root, strict: true })).toThrow('Engine wgpu-wasm package is missing');
  });
});
