/**
 * Permission provider —— 桥接原生 askUser ↔ UI(usePermissionQueue)。
 *
 * 真实闭环(agent/dispatch.ts:156-181):引擎判 'ask' → await askUser(perm, use)。
 * 本 provider 提供一个 `ask` 回调:enqueue 一条 PendingPermission,返回 Promise,
 * UI 渲染审批卡 → 用户选择 → decide(id, allow) → resolve(boolean)。
 *
 * T7 在此续写专用渲染 + allow-always 决策映射。T0 提供可用的队列 + ask 桥。
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import type { AskUserFn, PendingPermission, PermissionQueue, PermissionResult, ToolUse } from '../contracts';

const PermissionContext = createContext<PermissionQueue | null>(null);

export function PermissionProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [pending, setPending] = useState<PendingPermission[]>([]);
  const idSeq = useRef(0);
  // resolve 映射:id → resolver(避免 stale closure)。
  const resolvers = useRef(new Map<string, (allow: boolean) => void>());

  const ask = useCallback<AskUserFn>((perm: PermissionResult, use: ToolUse) => {
    const id = `perm-${++idSeq.current}`;
    return new Promise<boolean>((resolve) => {
      resolvers.current.set(id, resolve);
      const entry: PendingPermission = {
        id,
        use,
        perm,
        resolve: (allow: boolean) => {
          resolvers.current.delete(id);
          setPending((prev) => prev.filter((p) => p.id !== id));
          resolve(allow);
        },
      };
      setPending((prev) => [...prev, entry]);
    });
  }, []);

  const decide = useCallback((id: string, allow: boolean) => {
    const r = resolvers.current.get(id);
    if (!r) return;
    resolvers.current.delete(id);
    setPending((prev) => prev.filter((p) => p.id !== id));
    r(allow);
  }, []);

  const value = useMemo<PermissionQueue>(() => ({ pending, ask, decide }), [pending, ask, decide]);
  return <PermissionContext.Provider value={value}>{props.children}</PermissionContext.Provider>;
}

export function usePermissionQueue(): PermissionQueue {
  const v = useContext(PermissionContext);
  if (!v) throw new Error('usePermissionQueue must be used within <PermissionProvider>');
  return v;
}
