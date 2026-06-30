/**
 * TUI file 指令桥 + 注册表动态 provider 测试。
 *
 * 覆盖:
 *   - registerCommandProvider:file 指令并入 listCommands/resolveCommand;
 *     内置(静态)同名优先;provider 抛错优雅降级。
 *   - registerFileCommands:从 ~/.forgeax/commands(经 FORGEAX_CONFIG_DIR 模拟)发现
 *     userInvocable 指令,带 expand;热更新(运行中新增即时可见)。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerCommand,
  registerCommandProvider,
  listCommands,
  resolveCommand,
} from '../../src/tui/commands/registry';
import { registerFileCommands } from '../../src/tui/commands/file-commands';
import type { SlashCommand } from '../../src/tui/contracts';

const tmps: string[] = [];
afterEach(() => {
  registerCommandProvider(() => []); // 复位 provider(registry 是模块单例)
  delete process.env.FORGEAX_CONFIG_DIR;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noopRun = () => undefined;

describe('registry — 动态 provider 合并', () => {
  test('provider 的 file 指令进 listCommands / resolveCommand', () => {
    registerCommandProvider(() => [{ name: 'zzz-file', desc: 'f', source: 'file', run: noopRun }]);
    expect(listCommands().some((c) => c.name === 'zzz-file')).toBe(true);
    expect(resolveCommand('zzz-file')?.source).toBe('file');
  });

  test('内置同名优先,file 让位', () => {
    registerCommand({ name: 'zzz-dup', desc: 'builtin', run: noopRun });
    registerCommandProvider(() => [{ name: 'zzz-dup', desc: 'file', source: 'file', run: noopRun }]);
    const hit = resolveCommand('zzz-dup');
    expect(hit?.desc).toBe('builtin');
    expect(hit?.source).toBeUndefined();
    // listCommands 不出现重复 name。
    expect(listCommands().filter((c) => c.name === 'zzz-dup')).toHaveLength(1);
  });

  test('provider 抛错 → 优雅降级(不影响内置解析)', () => {
    registerCommand({ name: 'zzz-safe', desc: 'b', run: noopRun });
    registerCommandProvider(() => {
      throw new Error('boom');
    });
    expect(resolveCommand('zzz-safe')?.desc).toBe('b');
    expect(() => listCommands()).not.toThrow();
  });
});

describe('registerFileCommands — 用户级 ~/.forgeax/commands', () => {
  function setupConfigHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'fc-home-'));
    tmps.push(home);
    process.env.FORGEAX_CONFIG_DIR = home;
    return home;
  }

  test('发现 userInvocable 指令并带 expand;disable-model-invocation 仍是 userInvocable 默认', () => {
    const home = setupConfigHome();
    const dir = join(home, 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'greet.md'), '---\ndescription: hi\n---\nHello $ARGUMENTS');

    // cwd 用一个无 .forgeax 的临时目录,确保只命中用户级。
    const cwd = mkdtempSync(join(tmpdir(), 'fc-cwd-'));
    tmps.push(cwd);
    const prevCwd = process.cwd();
    process.chdir(cwd);
    try {
      registerFileCommands(undefined, undefined);
      const greet = resolveCommand('greet');
      expect(greet?.source).toBe('file');
      expect(greet?.expand?.('world')).toContain('Hello world');
    } finally {
      process.chdir(prevCwd);
    }
  });

  test('热更新:运行中新增指令即时可见', () => {
    const home = setupConfigHome();
    const dir = join(home, 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'first.md'), '---\ndescription: f\n---\nFirst');

    const cwd = mkdtempSync(join(tmpdir(), 'fc-cwd-'));
    tmps.push(cwd);
    const prevCwd = process.cwd();
    process.chdir(cwd);
    try {
      registerFileCommands(undefined, undefined);
      expect(resolveCommand('second')).toBeUndefined();
      writeFileSync(join(dir, 'second.md'), '---\ndescription: s\n---\nSecond');
      expect(resolveCommand('second')?.source).toBe('file'); // provider 现取 → 即时可见
    } finally {
      process.chdir(prevCwd);
    }
  });
});
