import { describe, expect, it } from 'bun:test';
import { TYPECHECK_TASKS } from './run-package-typechecks.ts';

describe('package typecheck fan-out', () => {
  it('keeps the canonical package list and schedules editor early', () => {
    expect(TYPECHECK_TASKS.map((task) => task.name)).toEqual([
      '@forgeax/editor',
      '@forgeax/agent-runtime',
      '@forgeax/design',
      '@forgeax/host-sdk',
      '@forgeax/types',
      '@forgeax/server',
      '@forgeax/interface',
      '@forgeax/chat',
      '@forgeax/workbench',
      '@forgeax/settings',
      '@forgeax/dashboard',
      '@forgeax/studio',
    ]);
    expect(TYPECHECK_TASKS[0]?.name).toBe('@forgeax/editor');
  });
});
