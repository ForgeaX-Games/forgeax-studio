import { describe, expect, test } from 'bun:test';

import { editorRoot, engineRoot, wgpuWasmRoot } from './workspace-paths.ts';

describe('Studio workspace paths', () => {
  test('derives the nested Editor and Engine roots from the Studio root', () => {
    const root = '/workspace/forgeax-studio';

    expect(editorRoot(root)).toBe('/workspace/forgeax-studio/packages/editor');
    expect(engineRoot(root)).toBe('/workspace/forgeax-studio/packages/editor/packages/engine');
    expect(wgpuWasmRoot(root)).toBe(
      '/workspace/forgeax-studio/packages/editor/packages/engine/packages/wgpu-wasm',
    );
  });
});
