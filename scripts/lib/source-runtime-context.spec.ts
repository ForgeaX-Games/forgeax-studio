import { describe, expect, test } from 'bun:test';
import {
  consumeSourceRuntimeContext,
  publishSourceRuntimeContext,
} from './source-runtime-context.ts';
import { resolveStartupEnvironment } from './startup-environment.ts';

describe('source runtime in-process context', () => {
  test('hands the exact resolved startup object to run.ts exactly once', () => {
    const startup = resolveStartupEnvironment({
      root: '/tmp/forgeax-source-runtime-context',
      profile: 'web-dev',
      env: {},
    });

    publishSourceRuntimeContext(startup);
    expect(consumeSourceRuntimeContext()).toBe(startup);
    expect(() => consumeSourceRuntimeContext()).toThrow(/context is unavailable; start through `bun fx start`/);
  });
});
