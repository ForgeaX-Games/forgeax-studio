import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ideDesktopInvocation, ideProcessEnv, runIdeCommand, runIdeDesktopCommand, type IdeCommandDependencies } from './ide.ts';

const source = readFileSync(new URL('./ide.ts', import.meta.url), 'utf8');

describe('IDE public command environment', () => {
  test('forwards desktop debug environment through the real asynchronous subprocess', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ide-desktop-env-'));
    const ide = join(root, 'packages/ide');
    mkdirSync(join(ide, 'node_modules'), { recursive: true });
    writeFileSync(join(ide, 'package.json'), JSON.stringify({ scripts: { 'dev:desktop': 'bun capture.ts' } }));
    writeFileSync(join(ide, 'capture.ts'), `await Bun.write('captured.json', JSON.stringify({ root: process.env.FORGEAX_INTEGRATION_ROOT, profile: process.env.FORGEAX_STARTUP_PROFILE, devtools: process.env.FORGEAX_DEVTOOLS }));`);
    try {
      expect(await runIdeDesktopCommand(root, ['debug'])).toBe(0);
      expect(JSON.parse(readFileSync(join(ide, 'captured.json'), 'utf8'))).toEqual({
        root, profile: 'desktop-dev', devtools: '1',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('binds every IDE subprocess to the owning Studio root', () => {
    expect(ideProcessEnv('/workspace/forgeax-studio', { PATH: '/bin' })).toEqual({
      PATH: '/bin',
      FORGEAX_INTEGRATION_ROOT: '/workspace/forgeax-studio',
    });
  });

  test('does not accept a caller override for the integration authority', () => {
    expect(ideProcessEnv('/workspace/forgeax-studio', {
      FORGEAX_INTEGRATION_ROOT: '/tmp/other-root',
    }).FORGEAX_INTEGRATION_ROOT).toBe('/workspace/forgeax-studio');
  });

  test('executes desktop debug through the mounted IDE development lifecycle', () => {
    const root = '/workspace/forgeax-studio';
    const calls: Array<{ command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const dependencies: IdeCommandDependencies = {
      existsSync: () => true,
      desktopDevUrl: () => 'http://127.0.0.1:19920',
      spawnSync: ((command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        return { status: 0 };
      }) as IdeCommandDependencies['spawnSync'],
    };

    expect(runIdeCommand(root, ['desktop', 'debug'], dependencies)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: process.execPath,
      args: ['run', 'dev:desktop', '--config', JSON.stringify({ build: { devUrl: 'http://127.0.0.1:19920' } })],
      cwd: resolve(root, 'packages/ide'),
    });
    expect(calls[0]?.env?.FORGEAX_DEVTOOLS).toBe('1');
    expect(calls[0]?.env?.FORGEAX_STARTUP_PROFILE).toBe('desktop-dev');
    expect(ideDesktopInvocation(['--config', 'custom.json', '--', '--mode', 'debug'], 'http://127.0.0.1:19920')).toEqual([
      'run', 'dev:desktop', '--config', 'custom.json', '--config',
      JSON.stringify({ build: { devUrl: 'http://127.0.0.1:19920' } }), '--', '--mode', 'debug',
    ]);
  });

  test('propagates desktop lifecycle failure', () => {
    const dependencies: IdeCommandDependencies = {
      existsSync: () => true,
      desktopDevUrl: () => 'http://127.0.0.1:19920',
      spawnSync: (() => ({ status: 17 })) as IdeCommandDependencies['spawnSync'],
    };
    expect(runIdeCommand('/workspace/forgeax-studio', ['desktop'], dependencies)).toBe(17);
  });

  test('executes the IDE-owned desktop build script', () => {
    const calls: Array<readonly string[]> = [];
    const dependencies: IdeCommandDependencies = {
      existsSync: () => true,
      desktopDevUrl: () => 'http://127.0.0.1:19920',
      spawnSync: ((_command: string, args: readonly string[]) => {
        calls.push(args);
        return { status: 0 };
      }) as IdeCommandDependencies['spawnSync'],
    };
    expect(runIdeCommand('/workspace/forgeax-studio', ['build'], dependencies)).toBe(0);
    expect(calls).toEqual([['run', 'package:desktop:local']]);
  });

  test.each([
    { installStatus: 0, checkStatus: 0 },
    { installStatus: 19, checkStatus: 0 },
    { installStatus: 0, checkStatus: 23 },
  ])('delegates CI to the IDE gate and propagates failures (%j)', ({ installStatus, checkStatus }) => {
    const root = '/workspace/forgeax-studio';
    const calls: Array<readonly string[]> = [];
    const dependencies: IdeCommandDependencies = {
      existsSync: () => true,
      desktopDevUrl: () => 'http://127.0.0.1:19920',
      spawnSync: ((_command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        calls.push(args);
        expect(options.cwd).toBe(resolve(root, 'packages/ide'));
        expect(options.env?.FORGEAX_INTEGRATION_ROOT).toBe(root);
        return { status: args[0] === 'install' ? installStatus : checkStatus };
      }) as IdeCommandDependencies['spawnSync'],
    };

    expect(runIdeCommand(root, ['ci', '--verbose'], dependencies)).toBe(installStatus || checkStatus);
    expect(calls).toEqual([
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      ...(installStatus === 0 ? [['run', 'check:web', '--verbose']] : []),
    ]);
  });

  test('documents the desktop command on the public IDE surface', () => {
    expect(source).toContain("command === 'desktop'");
    expect(source).toContain('ideDesktopInvocation(commandArgs,');
  });

  test('delegates CI to the IDE Web gate after a frozen install and propagates failure', () => {
    for (const failInstall of [false, true]) {
      const calls: Array<readonly string[]> = [];
      const dependencies: IdeCommandDependencies = {
        existsSync: () => true,
        spawnSync: ((_command: string, args: readonly string[]) => {
          calls.push(args);
          return { status: args[0] === 'install' ? (failInstall ? 19 : 0) : 23 };
        }) as IdeCommandDependencies['spawnSync'],
      };
      expect(runIdeCommand('/workspace/forgeax-studio', ['ci'], dependencies)).toBe(failInstall ? 19 : 23);
      expect(calls).toEqual(failInstall
        ? [['install', '--frozen-lockfile', '--ignore-scripts']]
        : [['install', '--frozen-lockfile', '--ignore-scripts'], ['run', 'check:web']]);
    }
  });
});
