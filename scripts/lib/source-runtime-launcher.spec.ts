import { describe, expect, test } from 'bun:test';
import { sourceRuntimePorts } from './source-runtime-launcher.ts';
import { resolveStartupEnvironment } from './startup-environment.ts';

describe('source runtime launcher contract', () => {
  test('derives every preflight port from StartupEnvironment', () => {
    const startup = resolveStartupEnvironment({
      root: '/tmp/forgeax-source-launcher',
      profile: 'web-dev',
      env: {},
    });

    expect(sourceRuntimePorts(startup)).toEqual([
      ['server', 18900],
      ['interface', 18920],
      ['engine', 15173],
    ]);
  });

  test('keeps the retired bridge out of preflight ports for every profile', () => {
    const startup = resolveStartupEnvironment({
      root: '/tmp/forgeax-source-launcher',
      profile: 'anydev-web',
      env: {
        FORGEAX_INTERFACE_PORT: '80',
        FORGEAX_BRIDGE: '0',
      },
    });

    expect(sourceRuntimePorts(startup)).toEqual([
      ['server', 18900],
      ['interface', 80],
      ['engine', 15173],
    ]);
  });
});
