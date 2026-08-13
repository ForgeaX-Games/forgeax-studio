import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readyRuntimePublicOrigin } from './open-web.ts';
import {
  resolveRuntimeInstance,
  runtimeInstanceProcessEnv,
  writeRuntimeInstanceConfig,
} from './lib/runtime-instance.ts';
import { RuntimeStateStore } from './lib/runtime-state.ts';
import { resolveStartupEnvironment } from './lib/startup-environment.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-open-web-'));
  roots.push(root);
  return root;
}

function readyState(root: string, publicOrigin: string) {
  const serverDir = join(root, 'packages/server');
  mkdirSync(join(serverDir, 'src'), { recursive: true });
  writeFileSync(join(serverDir, 'package.json'), JSON.stringify({ name: '@forgeax/server' }));
  writeFileSync(join(serverDir, 'src/main.ts'), '');
  writeRuntimeInstanceConfig({ root, slot: 1 });
  const instance = resolveRuntimeInstance({ root });
  const startup = resolveStartupEnvironment({
    root,
    profile: 'anydev-web',
    env: {
      ...runtimeInstanceProcessEnv(instance),
      FORGEAX_PUBLIC_ORIGIN: publicOrigin,
    },
  });
  const state = new RuntimeStateStore(startup, 4242).markReady({
    ready: true,
    checkedAt: '2026-08-09T00:00:00.000Z',
    services: {
      server: { ready: true, url: 'http://127.0.0.1:28900/api/health', status: 200 },
      interface: { ready: true, url: 'http://127.0.0.1:28920/api/health', status: 200 },
      engine: { ready: true, url: 'http://127.0.0.1:25173/preview/', status: 200 },
    },
  });
  return { instance, state };
}

function liveDeps(instance: ReturnType<typeof resolveRuntimeInstance>) {
  return {
    isAlive: () => true,
    readProcessSnapshot: () => ({
      pid: 4242,
      commandLine: `bun ${instance.root}/scripts/local-runtime.ts --profile anydev-web`,
      cwd: instance.root,
    }),
  };
}

describe('open-web runtime state contract', () => {
  test('uses only the current instance ready state publicOrigin', () => {
    const root = fixtureRoot();
    const { instance } = readyState(root, 'https://studio.anydev.example');

    expect(readyRuntimePublicOrigin(root, liveDeps(instance))).toBe('https://studio.anydev.example');
  });

  test('fails explicitly for a ready state whose launcher is dead or reused by another process', () => {
    const root = fixtureRoot();
    const { instance } = readyState(root, 'http://127.0.0.1:28920');

    expect(() => readyRuntimePublicOrigin(root, {
      ...liveDeps(instance),
      isAlive: () => false,
    })).toThrow(/no ready runtime state/);
    expect(() => readyRuntimePublicOrigin(root, {
      ...liveDeps(instance),
      readProcessSnapshot: () => ({
        pid: 4242,
        commandLine: 'bun scripts/unrelated.ts',
        cwd: instance.root,
      }),
    })).toThrow(/no ready runtime state/);
  });
});
