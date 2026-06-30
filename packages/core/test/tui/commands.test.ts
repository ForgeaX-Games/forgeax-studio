/**
 * commands registry resolve 兜底/命中(A8 可扩展铁律的运行时证据)。
 *
 * (P7 从已删除的 registries.test.ts 抽出 commands 部分;tools/messages/permissions
 *  的 registry 覆盖已由 views.test.ts / permission.test.tsx 全量接管。)
 *   - 未注册 command → resolveCommand 返回 undefined(调用方给可读提示)。
 *   - 内置 /help /clear /model /exit 已注册。
 *   - 注册一个临时 command → resolve 命中且出现在 listCommands。
 */
import { test, expect, describe } from 'bun:test';
import {
  registerCommand,
  resolveCommand,
  listCommands,
} from '../../src/tui/commands/registry';
// barrel import → 触发内置命令副作用注册。
import '../../src/tui/commands/index';

describe('commands registry', () => {
  test('unknown command resolves to undefined (caller gives readable hint)', () => {
    expect(resolveCommand('__nope__')).toBeUndefined();
  });

  test('builtin /help /clear /model /exit registered', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('help');
    expect(names).toContain('clear');
    expect(names).toContain('model');
    expect(names).toContain('exit');
  });

  test('registered command resolves and appears in listCommands', () => {
    registerCommand({ name: 'dummycmd', desc: 'test', run: () => {} });
    expect(resolveCommand('dummycmd')?.name).toBe('dummycmd');
    expect(listCommands().some((c) => c.name === 'dummycmd')).toBe(true);
  });
});
