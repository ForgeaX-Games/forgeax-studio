/**
 * 输入历史 provider —— ↑/↓ 翻历史(useInputHistory)。
 *
 * in-session 历史:add 入栈,prev/next 在游标上移动。T5 输入框消费。
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useContext, useRef, useCallback, useMemo } from 'react';
import type { InputHistory } from '../contracts';

const InputHistoryContext = createContext<InputHistory | null>(null);

export function InputHistoryProvider(props: { children: React.ReactNode }): React.ReactElement {
  const items = useRef<string[]>([]);
  // cursor: items.length = 当前(未进历史)位置;0 = 最旧。
  const cursor = useRef<number>(0);
  // draft: 离开 live 位置时暂存的输入框草稿,下翻回底部时还原(对齐 bash/zsh:上翻不丢草稿)。
  const draft = useRef<string>('');

  const add = useCallback((s: string) => {
    const t = s.trim();
    if (!t) return;
    if (items.current[items.current.length - 1] !== t) items.current.push(t);
    cursor.current = items.current.length;
    draft.current = '';
  }, []);

  const prev = useCallback((current?: string): string | undefined => {
    if (items.current.length === 0) return undefined;
    // 首次从 live 位置上翻:暂存当前草稿,供回到底部时还原。
    if (cursor.current >= items.current.length) draft.current = current ?? '';
    cursor.current = Math.max(0, cursor.current - 1);
    return items.current[cursor.current];
  }, []);

  const next = useCallback((): string | undefined => {
    if (items.current.length === 0) return undefined;
    cursor.current = Math.min(items.current.length, cursor.current + 1);
    return cursor.current >= items.current.length ? draft.current : items.current[cursor.current];
  }, []);

  // resume 选中历史会话后整体换栈:用该会话的 user prompts 重播种,游标复位到 live、清草稿。
  const reset = useCallback((next: string[]) => {
    items.current = next.slice();
    cursor.current = items.current.length;
    draft.current = '';
  }, []);

  const value = useMemo<InputHistory>(
    () => ({
      get items() {
        return items.current;
      },
      add,
      prev,
      next,
      reset,
    }),
    [add, prev, next, reset],
  );
  return <InputHistoryContext.Provider value={value}>{props.children}</InputHistoryContext.Provider>;
}

export function useInputHistory(): InputHistory {
  const v = useContext(InputHistoryContext);
  if (!v) throw new Error('useInputHistory must be used within <InputHistoryProvider>');
  return v;
}
