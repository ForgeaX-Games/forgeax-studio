/**
 * 终端文本宽度工具测试 —— displayWidth(CJK=2)+ clampToLines(宽字符感知 N 行截断)。
 */
import { test, expect, describe } from 'bun:test';
import { displayWidth, clampToLines } from '../../src/tui/text-width';

describe('displayWidth', () => {
  test('ASCII=1,CJK/全角=2', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中')).toBe(3);
    expect(displayWidth('ＡＢ')).toBe(4); // 全角
  });
});

describe('clampToLines', () => {
  test('短文本 → 单行原样', () => {
    expect(clampToLines('hello', 20, 2)).toEqual(['hello']);
  });

  test('空白/换行折叠为单空格', () => {
    expect(clampToLines('a\n\n  b   c', 20, 2)).toEqual(['a b c']);
  });

  test('超长 ASCII → 至多 2 行,每行不超宽,末行省略号', () => {
    const lines = clampToLines('abcdefghij klmnopqrst uvwxyz0123', 10, 2);
    expect(lines).toHaveLength(2);
    for (const ln of lines) expect(displayWidth(ln)).toBeLessThanOrEqual(10);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });

  test('恰好放下 → 不加省略号', () => {
    const lines = clampToLines('abcdefghij', 5, 2); // 10 字 → 两行 5+5,刚好
    expect(lines).toEqual(['abcde', 'fghij']);
    expect(lines.some((l) => l.includes('…'))).toBe(false);
  });

  test('CJK 宽字符按 2 列预算折行(不劈半角)', () => {
    // 每个汉字占 2 列;width=6 → 每行最多 3 字。
    const lines = clampToLines('一二三四五六七八', 6, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('一二三');
    for (const ln of lines) expect(displayWidth(ln)).toBeLessThanOrEqual(6);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });

  test('width<=0 / 空文本 → []', () => {
    expect(clampToLines('x', 0, 2)).toEqual([]);
    expect(clampToLines('   ', 10, 2)).toEqual([]);
  });
});
