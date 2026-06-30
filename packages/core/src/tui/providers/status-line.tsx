/**
 * StatusLine provider —— 状态栏数据聚合(useStatusLine)。
 *
 * 字段:model / ctxPct / tokens / elapsedMs / busy。T8 接线:turn_end.usageContextRatio
 * → ctxPct、stream usage → tokens、当前 model → model。
 *
 * **耗时时钟收口在此(SSOT)**:`set({ busy:true })` 记起点并启墙钟 interval(~100ms),
 * 持续把 elapsedMs 推到 `Date.now()-start`——与是否有流事件无关,空闲期(等首 token /
 * thinking / 长工具调用)照样平滑递增。`set({ busy:false })` 清 interval 并定格最终值。
 * Repl 不再手动刷 elapsedMs(那是事件驱动 → 事件稀疏时跳变)。
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { StatusState } from '../contracts';

const StatusContext = createContext<StatusState | null>(null);

/** 墙钟刷新间隔:0.1s 一格(显示精度即 0.1s),既平滑又不过度重渲。 */
const TICK_MS = 100;

export function StatusLineProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = useState<Omit<StatusState, 'set'>>({ busy: false });
  const startRef = useRef(0); // busy 上升沿记下的墙钟起点
  const set = useCallback((p: Partial<StatusState>) => {
    setState((prev) => {
      const next = { ...prev, ...p };
      // busy 上升沿:记起点 + 立即归零耗时(本轮从此刻起算)。
      if (p.busy === true && !prev.busy) {
        startRef.current = Date.now();
        next.elapsedMs = 0;
      }
      return next;
    });
  }, []);

  // 墙钟驱动:busy 期间每 TICK_MS 把 elapsedMs 推到 now-start(与流事件解耦);
  // busy 收尾(cleanup)时清 interval 并定格最终墙钟值。
  useEffect(() => {
    if (!state.busy) return;
    const id = setInterval(() => {
      setState((prev) => (prev.busy ? { ...prev, elapsedMs: Date.now() - startRef.current } : prev));
    }, TICK_MS);
    return () => {
      clearInterval(id);
      setState((prev) => ({ ...prev, elapsedMs: Date.now() - startRef.current }));
    };
  }, [state.busy]);

  const value = useMemo<StatusState>(() => ({ ...state, set }), [state, set]);
  return <StatusContext.Provider value={value}>{props.children}</StatusContext.Provider>;
}

export function useStatusLine(): StatusState {
  const v = useContext(StatusContext);
  if (!v) throw new Error('useStatusLine must be used within <StatusLineProvider>');
  return v;
}
