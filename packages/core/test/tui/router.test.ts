/**
 * input/router.ts —— routeKey 路由决策单测,重点钉死 command-menu「编辑 + 菜单导航」混合态。
 *
 * 回归点(本次修复):命令菜单一弹起后**必须**还能继续敲字实时过滤,而不是把字符键吞给
 * 纯 nav、只能在全集里上下选(旧 bug:command-menu 当纯浮层 → 字符 no-op + 输入框被隐藏)。
 *
 * 纯函数直调,不挂 Ink。
 */
import { test, expect, describe } from 'bun:test';
import { routeKey, type RouterCtx } from '../../src/tui/input/router';
import { isOverlayMode } from '../../src/tui/input/mode';
import type { Key, PromptState } from '../../src/tui/contracts';

const k = (kind: Key['kind'], over: Partial<Key> = {}): Key => ({ kind, ...over } as Key);
const ctx = (over: Partial<RouterCtx> = {}): RouterCtx => ({
  mode: 'command-menu',
  prompt: { value: '/s', cursor: 2 },
  overlayIndex: 0,
  overlayLength: 3,
  escArmed: false,
  busy: false,
  ...over,
});

describe('command-menu 不再是纯浮层(混合态)', () => {
  test('command-menu 已移出 OVERLAY_MODES(isOverlayMode=false)', () => {
    expect(isOverlayMode('command-menu')).toBe(false);
    // 其余浮层不受影响。
    expect(isOverlayMode('model-picker')).toBe(true);
    expect(isOverlayMode('rewind')).toBe(true);
    expect(isOverlayMode('permission')).toBe(true);
  });

  test('敲字符 → edit(实时过滤),而非被吞成 none', () => {
    const action = routeKey(ctx({ prompt: { value: '/s', cursor: 2 } }), k('char', { text: 't' }));
    expect(action).toEqual({ kind: 'edit', next: { value: '/st', cursor: 3 } });
  });

  test('退格 → edit(回退过滤;删到只剩 / 时上层会自动收菜单)', () => {
    const action = routeKey(ctx({ prompt: { value: '/st', cursor: 3 } }), k('backspace', { count: 1 }));
    expect(action).toEqual({ kind: 'edit', next: { value: '/s', cursor: 2 } });
  });

  test('左右/home/you → edit(移动光标,值不变)', () => {
    expect(routeKey(ctx({ prompt: { value: '/abc', cursor: 4 } }), k('left'))).toEqual({
      kind: 'edit',
      next: { value: '/abc', cursor: 3 },
    });
  });

  test('↑↓ 在过滤后的列表里环形移高亮', () => {
    expect(routeKey(ctx({ overlayIndex: 0, overlayLength: 3 }), k('down'))).toEqual({ kind: 'overlay-move', index: 1 });
    expect(routeKey(ctx({ overlayIndex: 2, overlayLength: 3 }), k('down'))).toEqual({ kind: 'overlay-move', index: 0 });
    expect(routeKey(ctx({ overlayIndex: 0, overlayLength: 3 }), k('up'))).toEqual({ kind: 'overlay-move', index: 2 });
  });

  test('空过滤结果:↑↓ → none(不动)', () => {
    expect(routeKey(ctx({ overlayLength: 0 }), k('down'))).toEqual({ kind: 'none' });
    expect(routeKey(ctx({ overlayLength: 0 }), k('up'))).toEqual({ kind: 'none' });
  });

  test('enter 有匹配且未带参数 → 选中高亮命令执行', () => {
    expect(routeKey(ctx({ prompt: { value: '/st', cursor: 3 }, overlayIndex: 1, overlayLength: 3 }), k('enter'))).toEqual({
      kind: 'overlay-select',
      index: 1,
    });
  });

  test('enter 无匹配 → 按原文提交', () => {
    expect(routeKey(ctx({ prompt: { value: '/zzz', cursor: 4 }, overlayLength: 0 }), k('enter'))).toEqual({
      kind: 'submit',
      value: '/zzz',
    });
  });

  test('enter 已带参数(value 含空格,如 /model sonnet)→ 按原文提交,保住参数', () => {
    expect(
      routeKey(ctx({ prompt: { value: '/model sonnet', cursor: 13 }, overlayLength: 1 }), k('enter')),
    ).toEqual({ kind: 'submit', value: '/model sonnet' });
  });

  test('tab 有高亮 → overlay-complete(回填输入框)', () => {
    expect(routeKey(ctx({ overlayIndex: 2, overlayLength: 3 }), k('tab'))).toEqual({ kind: 'overlay-complete', index: 2 });
  });

  test('tab 无匹配 → none', () => {
    expect(routeKey(ctx({ overlayLength: 0 }), k('tab'))).toEqual({ kind: 'none' });
  });

  test('esc → 关菜单', () => {
    expect(routeKey(ctx(), k('esc'))).toEqual({ kind: 'overlay-close' });
  });

  test('ctrl-c 在 command-menu 仍走中断', () => {
    expect(routeKey(ctx(), k('ctrl-c'))).toEqual({ kind: 'interrupt' });
  });
});

describe('prompt 模式基线(未回归)', () => {
  const p = (value: string, cursor: number): PromptState => ({ value, cursor });

  test('空输入敲 / → 开命令菜单(把 / 插入)', () => {
    const action = routeKey({ mode: 'prompt', prompt: p('', 0), overlayIndex: 0, overlayLength: 0, escArmed: false, busy: false }, k('char', { text: '/' }));
    expect(action).toEqual({ kind: 'open-command-menu', next: { value: '/', cursor: 1 } });
  });

  test('普通敲字 → edit', () => {
    const action = routeKey({ mode: 'prompt', prompt: p('a', 1), overlayIndex: 0, overlayLength: 0, escArmed: false, busy: false }, k('char', { text: 'b' }));
    expect(action).toEqual({ kind: 'edit', next: { value: 'ab', cursor: 2 } });
  });

  test('enter 提交;↑↓ 走历史', () => {
    const base = { mode: 'prompt' as const, prompt: p('hi', 2), overlayIndex: 0, overlayLength: 0, escArmed: false, busy: false };
    expect(routeKey(base, k('enter'))).toEqual({ kind: 'submit', value: 'hi' });
    expect(routeKey(base, k('up'))).toEqual({ kind: 'history-prev' });
    expect(routeKey(base, k('down'))).toEqual({ kind: 'history-next' });
  });
});

describe('esc 语义:busy 单击打断 vs 空闲双击清空(回归:发送后按 esc「卡住」)', () => {
  const base = (over: Partial<RouterCtx> = {}): RouterCtx => ({
    mode: 'prompt',
    prompt: { value: '', cursor: 0 },
    overlayIndex: 0,
    overlayLength: 0,
    escArmed: false,
    busy: false,
    ...over,
  });

  test('busy 时单次 esc → interrupt(不再先 arm 等第二次)', () => {
    expect(routeKey(base({ busy: true }), k('esc'))).toEqual({ kind: 'interrupt' });
    // 有草稿在输入框时也优先打断 turn(对齐 cc:loading 时 esc 取消请求)。
    expect(routeKey(base({ busy: true, prompt: { value: 'draft', cursor: 5 } }), k('esc'))).toEqual({ kind: 'interrupt' });
  });

  test('空闲时首次 esc 仅 arm,第二次才清空/开 rewind(双击手势保留)', () => {
    expect(routeKey(base(), k('esc'))).toEqual({ kind: 'prompt-esc-arm' });
    expect(routeKey(base({ escArmed: true }), k('esc'))).toEqual({ kind: 'open-rewind' });
    expect(routeKey(base({ escArmed: true, prompt: { value: 'x', cursor: 1 } }), k('esc'))).toEqual({ kind: 'prompt-clear' });
  });
});

describe('question 模式(导航 + 多选勾选 + 自填编辑混合态)', () => {
  // overlayLength=3 表示「2 真选项 + 1 自填行」;自填行 = 末行(index 2)。
  const qctx = (over: Partial<RouterCtx> = {}): RouterCtx => ({
    mode: 'question',
    prompt: { value: '', cursor: 0 },
    overlayIndex: 0,
    overlayLength: 3,
    escArmed: false,
    busy: false,
    ...over,
  });

  test('question 不在 OVERLAY_MODES(自带 routeQuestion,不走 navReduce)', () => {
    expect(isOverlayMode('question')).toBe(false);
  });

  test('↑↓ 环形移高亮(含自填末行)', () => {
    expect(routeKey(qctx({ overlayIndex: 2 }), k('down'))).toEqual({ kind: 'overlay-move', index: 0 });
    expect(routeKey(qctx({ overlayIndex: 0 }), k('up'))).toEqual({ kind: 'overlay-move', index: 2 });
  });

  test('enter → overlay-select(确认当前题)', () => {
    expect(routeKey(qctx({ overlayIndex: 1 }), k('enter'))).toEqual({ kind: 'overlay-select', index: 1 });
  });

  test('真选项高亮:空格 → overlay-toggle(多选勾选;单选题由 P6 no-op)', () => {
    expect(routeKey(qctx({ overlayIndex: 0 }), k('char', { text: ' ' }))).toEqual({ kind: 'overlay-toggle', index: 0 });
  });

  test('真选项高亮:非空格字符吞掉(选项不可编辑)', () => {
    expect(routeKey(qctx({ overlayIndex: 0 }), k('char', { text: 'a' }))).toEqual({ kind: 'none' });
  });

  test('自填末行高亮:字符 → edit(写自填缓冲;空格也算文本)', () => {
    expect(routeKey(qctx({ overlayIndex: 2 }), k('char', { text: 'a' }))).toEqual({
      kind: 'edit',
      next: { value: 'a', cursor: 1 },
    });
    expect(routeKey(qctx({ overlayIndex: 2 }), k('char', { text: ' ' }))).toEqual({
      kind: 'edit',
      next: { value: ' ', cursor: 1 },
    });
  });

  test('自填末行高亮:退格 → edit', () => {
    expect(
      routeKey(qctx({ overlayIndex: 2, prompt: { value: 'ab', cursor: 2 } }), k('backspace', { count: 1 })),
    ).toEqual({ kind: 'edit', next: { value: 'a', cursor: 1 } });
  });

  test('esc → overlay-close(跳过整组)', () => {
    expect(routeKey(qctx(), k('esc'))).toEqual({ kind: 'overlay-close' });
  });

  test('overlayLength=0 吞掉移动/选择', () => {
    expect(routeKey(qctx({ overlayLength: 0 }), k('down'))).toEqual({ kind: 'none' });
    expect(routeKey(qctx({ overlayLength: 0 }), k('enter'))).toEqual({ kind: 'none' });
  });
});
