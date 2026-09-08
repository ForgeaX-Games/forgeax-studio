import { resolve } from 'node:path';

/**
 * Resolve the Editor checkout consumed by this Studio workspace.
 */
export function editorRoot(root: string): string {
  return resolve(root, 'packages', 'editor');
}

/**
 * Resolve the Engine checkout nested in the consumed Editor.
 */
export function engineRoot(root: string): string {
  return resolve(editorRoot(root), 'packages', 'engine');
}

/**
 * Resolve the Engine wgpu-wasm package.
 */
export function wgpuWasmRoot(root: string): string {
  return resolve(engineRoot(root), 'packages', 'wgpu-wasm');
}
