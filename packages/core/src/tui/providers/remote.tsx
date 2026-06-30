/**
 * Remote provider —— /remote-control 的反应式状态(useRemote)。
 *
 * 持有命令式 controller(app.tsx 注入)+ 把它的账号状态/二维码变化映射成 React state,
 * overlay 据此实时重渲(扫码 → 在线 等)。Repl 经 controller 注册入站 sink + 回发回复。
 * 与 permission/question provider 同形(Context + 订阅 + 快照)。
 *
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { RemoteAccount, RemoteController } from '../remote/controller';
import type { RemoteKind } from '../remote/channel';

export interface RemoteContextValue {
  controller: RemoteController;
  /** 账号快照(反应式;状态/二维码变化即更新)。 */
  accounts: RemoteAccount[];
  /** 添加并连接一个账号(触发重渲)。 */
  addAccount(kind: RemoteKind): Promise<string>;
}

const RemoteContext = createContext<RemoteContextValue | null>(null);

export function RemoteProvider(props: {
  controller: RemoteController;
  children: React.ReactNode;
}): React.ReactElement {
  const { controller } = props;
  const [accounts, setAccounts] = useState<RemoteAccount[]>(() => controller.listRemotes());

  useEffect(() => {
    const refresh = (): void => setAccounts(controller.listRemotes());
    const unsub = controller.on(refresh);
    refresh(); // 订阅瞬间对齐一次(controller 可能已有账号)
    return unsub;
  }, [controller]);

  const addAccount = useCallback((kind: RemoteKind) => controller.addAccount(kind), [controller]);

  const value = useMemo<RemoteContextValue>(
    () => ({ controller, accounts, addAccount }),
    [controller, accounts, addAccount],
  );
  return <RemoteContext.Provider value={value}>{props.children}</RemoteContext.Provider>;
}

export function useRemote(): RemoteContextValue {
  const v = useContext(RemoteContext);
  if (!v) throw new Error('useRemote must be used within <RemoteProvider>');
  return v;
}
