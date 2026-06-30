/**
 * InputHistoryProvider 单测 —— ↑/↓ 翻历史 + resume 换栈(reset)。
 *
 * 重点钉死回归:resume 选中历史会话后必须用该会话的 user prompts 重播种,
 * 否则 ↑/↓ 翻的还是 resume 前本会话敲过的内容(本次修复的 bug)。
 *
 * 用 ink-testing-library 真渲染 Provider,经一个 capture 子组件把 InputHistory
 * 句柄取出来直调(provider 内部是 ref,不触发 re-render,直调即可观察)。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputHistoryProvider, useInputHistory } from '../../src/tui/providers/input-history';
import type { InputHistory } from '../../src/tui/contracts';

function mount(): InputHistory {
  let captured: InputHistory | undefined;
  function Capture(): null {
    captured = useInputHistory();
    return null;
  }
  render(
    <InputHistoryProvider>
      <Capture />
    </InputHistoryProvider>,
  );
  if (!captured) throw new Error('hook not captured');
  return captured;
}

describe('InputHistoryProvider', () => {
  test('add + prev/next 在游标上移动,空栈返回 undefined', () => {
    const h = mount();
    expect(h.prev()).toBeUndefined(); // 空栈
    h.add('a');
    h.add('b');
    expect(h.prev()).toBe('b'); // 最近一条
    expect(h.prev()).toBe('a');
    expect(h.prev()).toBe('a'); // 夹到最旧
    expect(h.next()).toBe('b');
  });

  test('上翻暂存草稿,下翻回底部还原草稿', () => {
    const h = mount();
    h.add('old');
    expect(h.prev('draft-in-progress')).toBe('old'); // 首次上翻暂存草稿
    expect(h.next()).toBe('draft-in-progress'); // 回到底部还原
  });

  test('add 去重相邻重复,游标复位到 live', () => {
    const h = mount();
    h.add('x');
    h.add('x'); // 相邻重复不入栈
    expect(h.items.length).toBe(1);
  });

  test('reset 整体换栈:翻的是新栈、游标复位、旧草稿清空(resume 修复点)', () => {
    const h = mount();
    h.add('before-resume-1');
    h.add('before-resume-2');
    h.prev('typing'); // 制造非 live 游标 + 草稿
    // resume:用恢复会话的 user prompts 重播种
    h.reset(['resumed-a', 'resumed-b']);
    expect(h.items).toEqual(['resumed-a', 'resumed-b']);
    expect(h.prev()).toBe('resumed-b'); // 翻的是新栈,不是 before-resume-*
    expect(h.prev()).toBe('resumed-a');
    expect(h.next()).toBe('resumed-b');
    expect(h.next()).toBe(''); // 草稿已清空(回底部得空串)
  });

  test('reset 空数组:栈清空,prev 返回 undefined', () => {
    const h = mount();
    h.add('stale');
    h.reset([]);
    expect(h.items.length).toBe(0);
    expect(h.prev()).toBeUndefined();
  });
});
