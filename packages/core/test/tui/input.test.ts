/**
 * P3 单测 —— input/{normalize,promptReducer}(梁③ 纯函数,R1 铺满)。
 *
 * normalizeKey:R4 实测形状钉死(单次退格走 raw 标志、连按退格 '\x7f\x7f\x7f' 同 chunk
 *   → backspace{count}、esc(=meta 同置,先判 escape)、方向键、tab/enter、粘贴 vs 单字符、
 *   CJK 逐码点、ctrl+a/e→home/end、混合 chunk 拆段)。
 * promptReducer:多行/光标/删词/连按退格(count 一次删够)/粘贴(含换行)/CJK 光标列号/越界夹紧。
 *
 * 不渲染、不挂 Ink;纯函数直调,bun test。
 */
import { test, expect, describe } from 'bun:test';
import type { Key as InkKey } from 'ink';
import { normalizeKey } from '../../src/tui/input/normalize';
import { promptReducer, deleteWordBefore, lineColOf } from '../../src/tui/input/promptReducer';
import type { PromptState } from '../../src/tui/contracts';

/** 造一枚完整的 Ink Key(全 false),再覆盖指定字段。对齐 ink 6.8 use-input.js 的字段集。 */
function mkKey(over: Partial<InkKey> = {}): InkKey {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...over,
  } as InkKey;
}

const S = (value: string, cursor: number): PromptState => ({ value, cursor });

describe('normalizeKey — R4 实测形状', () => {
  test('单次 Backspace 物理键:input="" + key.delete → 一枚 backspace{count:1}', () => {
    expect(normalizeKey('', mkKey({ delete: true }))).toEqual([{ kind: 'backspace', count: 1 }]);
  });

  test('单次 BS(0x08):input="" + key.backspace → backspace{count:1}', () => {
    expect(normalizeKey('', mkKey({ backspace: true }))).toEqual([{ kind: 'backspace', count: 1 }]);
  });

  test('连按退格(同 chunk \\x7f\\x7f\\x7f,无 key 标志)→ 一枚 backspace{count:3}(count 可恢复)', () => {
    const keys = normalizeKey('\x7f\x7f\x7f', mkKey());
    expect(keys).toEqual([{ kind: 'backspace', count: 3 }]);
  });

  test('连按 BS8(\\x08\\x08)同 chunk → backspace{count:2}', () => {
    expect(normalizeKey('\x08\x08', mkKey())).toEqual([{ kind: 'backspace', count: 2 }]);
  });

  test('esc(escape 与 meta 同置)→ 一枚 esc(先判 escape,不被 meta 吞)', () => {
    expect(normalizeKey('', mkKey({ escape: true, meta: true }))).toEqual([{ kind: 'esc' }]);
  });

  test('方向键 → 对应 kind', () => {
    expect(normalizeKey('', mkKey({ leftArrow: true }))).toEqual([{ kind: 'left' }]);
    expect(normalizeKey('', mkKey({ rightArrow: true }))).toEqual([{ kind: 'right' }]);
    expect(normalizeKey('', mkKey({ upArrow: true }))).toEqual([{ kind: 'up' }]);
    expect(normalizeKey('', mkKey({ downArrow: true }))).toEqual([{ kind: 'down' }]);
  });

  test('home/end 标志 → home/end', () => {
    expect(normalizeKey('', mkKey({ home: true }))).toEqual([{ kind: 'home' }]);
    expect(normalizeKey('', mkKey({ end: true }))).toEqual([{ kind: 'end' }]);
  });

  test('ctrl+a / ctrl+e → home / end', () => {
    expect(normalizeKey('a', mkKey({ ctrl: true }))).toEqual([{ kind: 'home' }]);
    expect(normalizeKey('e', mkKey({ ctrl: true }))).toEqual([{ kind: 'end' }]);
  });

  test('ctrl+c / ctrl+o → ctrl-c / ctrl-o', () => {
    expect(normalizeKey('c', mkKey({ ctrl: true }))).toEqual([{ kind: 'ctrl-c' }]);
    expect(normalizeKey('o', mkKey({ ctrl: true }))).toEqual([{ kind: 'ctrl-o' }]);
  });

  test('tab / enter → tab / enter', () => {
    expect(normalizeKey('', mkKey({ tab: true }))).toEqual([{ kind: 'tab' }]);
    expect(normalizeKey('\r', mkKey({ return: true }))).toEqual([{ kind: 'enter' }]);
  });

  test('单字符 → char;多字符整块 → paste', () => {
    expect(normalizeKey('a', mkKey())).toEqual([{ kind: 'char', text: 'a' }]);
    expect(normalizeKey('hello world', mkKey())).toEqual([{ kind: 'paste', text: 'hello world' }]);
  });

  test('含换行的粘贴 → 单枚 paste(\\n 原样保留)', () => {
    expect(normalizeKey('a\nb', mkKey())).toEqual([{ kind: 'paste', text: 'a\nb' }]);
  });

  test('CJK 单字符 → char(按码点)', () => {
    expect(normalizeKey('中', mkKey())).toEqual([{ kind: 'char', text: '中' }]);
    expect(normalizeKey('中文', mkKey())).toEqual([{ kind: 'paste', text: '中文' }]);
  });

  test('混合 chunk:文本夹退格 → 多枚 Key 按段拆(text → backspace → text)', () => {
    expect(normalizeKey('ab\x7f\x7fcd', mkKey())).toEqual([
      { kind: 'paste', text: 'ab' },
      { kind: 'backspace', count: 2 },
      { kind: 'paste', text: 'cd' },
    ]);
  });

  test('丢弃不可见控制字符(保留普通文本)', () => {
    // \x01(SOH)等 < 0x20 控制字符被丢,'x' 保留为 char。
    expect(normalizeKey('\x01x', mkKey())).toEqual([{ kind: 'char', text: 'x' }]);
  });

  test('空 input + 无识别标志 → 空数组(不污染)', () => {
    expect(normalizeKey('', mkKey())).toEqual([]);
    expect(normalizeKey('', mkKey({ ctrl: true }))).toEqual([]); // ctrl 无文本 → 交上层
  });
});

describe('promptReducer — 编辑纯函数', () => {
  test('char 在光标处插入,光标右移', () => {
    expect(promptReducer(S('ac', 1), { kind: 'char', text: 'b' })).toEqual(S('abc', 2));
  });

  test('paste 整块插入(含换行 → 多行)', () => {
    expect(promptReducer(S('xy', 1), { kind: 'paste', text: 'A\nB' })).toEqual(S('xA\nBy', 4));
  });

  test('backspace{count:1} 删光标前一字符', () => {
    expect(promptReducer(S('abc', 3), { kind: 'backspace', count: 1 })).toEqual(S('ab', 2));
  });

  test('连按退格 backspace{count:3} 一次删够 3 个', () => {
    expect(promptReducer(S('abcde', 5), { kind: 'backspace', count: 3 })).toEqual(S('ab', 2));
  });

  test('退格 count 超过光标前可删数 → 删到行首,不越界', () => {
    expect(promptReducer(S('ab', 2), { kind: 'backspace', count: 9 })).toEqual(S('', 0));
  });

  test('退格在光标=0 → no-op', () => {
    expect(promptReducer(S('abc', 0), { kind: 'backspace', count: 1 })).toEqual(S('abc', 0));
  });

  test('left/right 移动光标(不改值)', () => {
    expect(promptReducer(S('abc', 2), { kind: 'left' })).toEqual(S('abc', 1));
    expect(promptReducer(S('abc', 1), { kind: 'right' })).toEqual(S('abc', 2));
  });

  test('left 在 0 / right 在末尾 → 夹紧', () => {
    expect(promptReducer(S('abc', 0), { kind: 'left' })).toEqual(S('abc', 0));
    expect(promptReducer(S('abc', 3), { kind: 'right' })).toEqual(S('abc', 3));
  });

  test('home/end 跳行首行尾(全文偏移)', () => {
    expect(promptReducer(S('a\nbc', 3), { kind: 'home' })).toEqual(S('a\nbc', 0));
    expect(promptReducer(S('a\nbc', 1), { kind: 'end' })).toEqual(S('a\nbc', 4));
  });

  test('CJK:在中文中间插入,光标按码点(非字节)', () => {
    // '中文' cursor=1(在 中 与 文 之间)插 'X' → '中X文',cursor=2
    expect(promptReducer(S('中文', 1), { kind: 'char', text: 'X' })).toEqual(S('中X文', 2));
  });

  test('CJK:退格删一个中文码点(非半个字节)', () => {
    expect(promptReducer(S('中文', 2), { kind: 'backspace', count: 1 })).toEqual(S('中', 1));
  });

  test('越界 cursor 输入时夹紧后再编辑', () => {
    // cursor=99 越界 → 夹到 len=3 后插入
    expect(promptReducer(S('abc', 99), { kind: 'char', text: 'd' })).toEqual(S('abcd', 4));
  });

  test('非编辑 Key(enter/esc/up/down/tab)→ no-op', () => {
    for (const kind of ['enter', 'esc', 'up', 'down', 'tab'] as const) {
      expect(promptReducer(S('abc', 1), { kind })).toEqual(S('abc', 1));
    }
  });
});

describe('deleteWordBefore — 删词', () => {
  test('删光标前一个词(含尾随空白)', () => {
    expect(deleteWordBefore(S('foo bar', 7))).toEqual(S('foo ', 4));
  });

  test('词后有空格:先吃空白再吃词', () => {
    expect(deleteWordBefore(S('foo bar  ', 9))).toEqual(S('foo ', 4));
  });

  test('光标=0 → no-op', () => {
    expect(deleteWordBefore(S('foo', 0))).toEqual(S('foo', 0));
  });

  test('CJK 词:按码点删', () => {
    expect(deleteWordBefore(S('你好 世界', 5))).toEqual(S('你好 ', 3));
  });
});

describe('lineColOf — 多行光标定位(渲染用)', () => {
  test('单行:line=0 col=cursor', () => {
    expect(lineColOf('abc', 2)).toEqual({ line: 0, col: 2 });
  });

  test('多行:换行后行号++,列重置', () => {
    expect(lineColOf('ab\ncd', 4)).toEqual({ line: 1, col: 1 });
  });

  test('恰在换行符后(行首)', () => {
    expect(lineColOf('ab\ncd', 3)).toEqual({ line: 1, col: 0 });
  });

  test('CJK:列号按码点', () => {
    expect(lineColOf('中文x', 3)).toEqual({ line: 0, col: 3 });
  });

  test('越界 cursor 夹紧', () => {
    expect(lineColOf('abc', 99)).toEqual({ line: 0, col: 3 });
  });
});
