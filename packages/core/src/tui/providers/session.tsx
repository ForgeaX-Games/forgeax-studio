/**
 * Session provider —— 消息历史(useSession)。
 *
 * 持有可渲染条目流(UiMessage[]),提供 push/clear。driver 的 onEvent reduce 进
 * 这里(经 Repl)。中→重:虚拟列表 / 持久化在此扩展,API 不变。
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { SessionState, UiMessage } from '../contracts';

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const push = useCallback((m: UiMessage) => setMessages((prev) => [...prev, m]), []);
  const clear = useCallback(() => setMessages([]), []);
  const rewindTo = useCallback((count: number) => setMessages((prev) => prev.slice(0, Math.max(0, count))), []);
  const replaceAll = useCallback((msgs: UiMessage[]) => setMessages(msgs), []);
  const value = useMemo<SessionState>(() => ({ messages, push, clear, rewindTo, replaceAll }), [messages, push, clear, rewindTo, replaceAll]);
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used within <SessionProvider>');
  return v;
}
