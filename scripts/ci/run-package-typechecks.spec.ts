import { describe, expect, it } from 'bun:test';
import { TYPECHECK_TASKS } from './run-package-typechecks.ts';

describe('package typecheck fan-out', () => {
  it('keeps the Studio-owned package list separate from Editor CI', () => {
    expect(TYPECHECK_TASKS.map((task) => task.name)).toEqual([
      '@forgeax/design',
      '@forgeax/server',
      '@forgeax/interface',
      '@forgeax/chat',
      '@forgeax/settings',
      '@forgeax/dashboard',
    ]);
    expect(TYPECHECK_TASKS.some((task) => task.name === '@forgeax/editor')).toBe(false);
    expect(TYPECHECK_TASKS.some((task) => task.path === 'studio')).toBe(false);
  });
});
