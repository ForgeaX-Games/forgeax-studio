import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  allocateStandaloneRuntimePlugins,
  discoverStandalonePlugins,
  standalonePluginInvocation,
  standalonePluginPortMap,
} from './standalone-plugins.ts';

const fixtures: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-standalone-plugins-'));
  fixtures.push(root);
  return root;
}

function writePlugin(
  root: string,
  directory: string,
  manifestName: 'forgeax-extension.json' | 'forgeax-plugin.json',
  manifest: unknown,
): string {
  const dir = join(root, directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, manifestName), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    packageManager: 'bun@1.3.14',
    scripts: { dev: 'vite' },
  })}\n`);
  return dir;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('standalone plugin lifecycle', () => {
  test('discovers canonical and legacy standalone manifests without admitting embedded plugins', () => {
    const root = fixtureRoot();
    const reel = writePlugin(root, 'reel', 'forgeax-extension.json', {
      id: '@forgeax-extension/reel',
      entry: { standalone: { embeddedAlso: false, start: 'bun run dev', port: 15175 } },
    });
    const legacy = writePlugin(root, 'legacy', 'forgeax-plugin.json', {
      id: '@forgeax-plugin/legacy',
      entry: { standalone: { embeddedAlso: false, start: 'pnpm dev', port: 15180 } },
    });
    writePlugin(root, 'embedded', 'forgeax-extension.json', {
      id: '@forgeax-extension/embedded',
      entry: { standalone: { embeddedAlso: true, start: 'bun run dev', port: 15190 } },
    });

    expect(discoverStandalonePlugins(root)).toEqual([
      { dir: realpathSync(legacy), id: '@forgeax-plugin/legacy', shortId: 'legacy', port: 15180, start: 'pnpm dev' },
      { dir: realpathSync(reel), id: '@forgeax-extension/reel', shortId: 'reel', port: 15175, start: 'bun run dev' },
    ]);
  });

  test('allocates instance-scoped frontend/backend ports and publishes the server override map', () => {
    const root = fixtureRoot();
    const plugins = allocateStandaloneRuntimePlugins([
      { dir: '/extensions/reel', id: '@forgeax-extension/reel', shortId: 'reel', port: 15175, start: 'npm run dev' },
      { dir: '/extensions/video-game', id: '@forgeax-extension/video-game', shortId: 'video-game', port: 15185, start: 'bun run dev' },
    ], {
      projectRoot: root,
      portOffset: 20_000,
      reservedPorts: [35175, 35177],
      isPortBusy: (port) => port === 35185,
    });

    expect(plugins).toEqual([
      {
        dir: '/extensions/reel',
        id: '@forgeax-extension/reel',
        shortId: 'reel',
        port: 15175,
        start: 'npm run dev',
        frontendPort: 35176,
        backendPort: 35178,
        projectRoot: join(root, '.forgeax/extension-runtime/reel'),
      },
      {
        dir: '/extensions/video-game',
        id: '@forgeax-extension/video-game',
        shortId: 'video-game',
        port: 15185,
        start: 'bun run dev',
        frontendPort: 35186,
        backendPort: 35187,
        projectRoot: join(root, '.forgeax/extension-runtime/video-game'),
      },
    ]);
    expect(standalonePluginPortMap(plugins)).toEqual({
      generatedBy: 'scripts/local-runtime.ts',
      plugins: {
        '@forgeax-extension/reel': { frontendPort: 35176, backendPort: 35178 },
        '@forgeax-extension/video-game': { frontendPort: 35186, backendPort: 35187 },
      },
    });
  });

  test('executes the manifest-declared standalone command without a shell', () => {
    expect(standalonePluginInvocation('pnpm run dev -- --host "127.0.0.1"')).toEqual({
      cmd: 'pnpm',
      args: ['run', 'dev', '--', '--host', '127.0.0.1'],
    });
    expect(() => standalonePluginInvocation('bun run dev && echo unsafe')).toThrow('shell operator');
  });

  test('does not discover extension implementations from Marketplace metadata', () => {
    const marketplace = resolve(import.meta.dir, '../../packages/marketplace/extensions');
    const current = discoverStandalonePlugins(marketplace);
    expect(current).toEqual([]);
  });
});
