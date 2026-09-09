import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { ideDesktopInvocation, ideProcessEnv, runIdeCommand, type IdeCommandDependencies } from './ide.ts';

const source = readFileSync(new URL('./ide.ts', import.meta.url), 'utf8');

describe('IDE public command environment', () => {
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
      spawnSync: ((command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        return { status: 0 };
      }) as IdeCommandDependencies['spawnSync'],
    };

    expect(runIdeCommand(root, ['desktop', 'debug'], dependencies)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: process.execPath,
      args: ['run', 'dev:desktop', 'debug'],
      cwd: resolve(root, 'packages/ide'),
    });
    expect(ideDesktopInvocation(['debug'])).toEqual(['run', 'dev:desktop', 'debug']);
  });

  test('propagates desktop lifecycle failure', () => {
    const dependencies: IdeCommandDependencies = {
      existsSync: () => true,
      spawnSync: (() => ({ status: 17 })) as IdeCommandDependencies['spawnSync'],
    };
    expect(runIdeCommand('/workspace/forgeax-studio', ['desktop'], dependencies)).toBe(17);
  });

  test('executes the IDE-owned desktop build script', () => {
    const calls: Array<readonly string[]> = [];
    const dependencies: IdeCommandDependencies = {
      existsSync: () => true,
      spawnSync: ((_command: string, args: readonly string[]) => {
        calls.push(args);
        return { status: 0 };
      }) as IdeCommandDependencies['spawnSync'],
    };
    expect(runIdeCommand('/workspace/forgeax-studio', ['build'], dependencies)).toBe(0);
    expect(calls).toEqual([['run', 'build:desktop']]);
  });

  test('documents the desktop command on the public IDE surface', () => {
    expect(source).toContain("command === 'desktop'");
    expect(source).toContain('ideDesktopInvocation(commandArgs)');
  });
});
