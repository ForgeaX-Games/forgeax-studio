/**
 * RemoteController —— /remote-control 的命令式核心(无 React)。
 *
 * 持有 N 个 RemoteChannel(每个 = 一个已添加账号),把它们的事件多路复用成两条出口:
 *   - on(listener)        → 账号状态/二维码变化(provider 据此重渲 overlay);
 *   - setInbound(sink)     → 唯一一条入站消息中转 sink(Repl 据此驱动一轮 agent)。
 * 并提供 send(origin) 把 agent 回复定址回正确通道的正确对端。
 *
 * 通道实现经 ChannelFactory 注入(app.tsx 给):故本文件不 import wechaty——保持 wechaty
 * 惰性、controller 可用 FakeChannel 离线单测。
 *
 * Boundary(HOST 层):仅 core 相对 import,无 react/ink。
 */
import type { RemoteChannel, RemoteKind, RemotePeer, RemoteStatus } from './channel';

/** 一轮远端来源(消息来自哪个通道的哪个对端 → 回复定址依据)。 */
export interface RemoteOrigin {
  remoteId: string;
  peer: RemotePeer;
}

/** 账号快照(overlay 渲染用)。 */
export interface RemoteAccount {
  id: string;
  kind: RemoteKind;
  label: string;
  status: RemoteStatus;
  qr: string | null;
}

/** 入站中转消息(controller → Repl)。 */
export interface RemoteInboundMsg {
  remoteId: string;
  peer: RemotePeer;
  text: string;
}

/** 注入的通道工厂:按种类造一个未连接的 RemoteChannel。 */
export type ChannelFactory = (kind: RemoteKind) => RemoteChannel;

export interface RemoteController {
  /** 添加并连接一个账号;返回 remoteId。 */
  addAccount(kind: RemoteKind): Promise<string>;
  /** 全部账号快照(状态/二维码)。 */
  listRemotes(): RemoteAccount[];
  /** 取某账号当前二维码(scan 态有值)。 */
  getQr(remoteId: string): string | null;
  /** 订阅账号状态变化(provider 用);返回退订。 */
  on(listener: () => void): () => void;
  /** 注册唯一入站 sink(Repl 用);覆盖上一个。 */
  setInbound(sink: (msg: RemoteInboundMsg) => void): void;
  /** 把 agent 回复发回来源对端。 */
  send(origin: RemoteOrigin, text: string): Promise<void>;
  /** 释放全部通道。 */
  dispose(): Promise<void>;
}

export function createRemoteController(factory: ChannelFactory): RemoteController {
  const entries = new Map<string, { channel: RemoteChannel; unsub: () => void }>();
  const stateListeners = new Set<() => void>();
  let inbound: ((msg: RemoteInboundMsg) => void) | null = null;
  let seq = 0;

  const notifyState = (): void => {
    for (const l of stateListeners) l();
  };

  return {
    async addAccount(kind: RemoteKind): Promise<string> {
      const id = `${kind}-${++seq}`;
      const channel = factory(kind);
      const unsub = channel.on((e) => {
        if (e.type === 'message') {
          inbound?.({ remoteId: id, peer: e.inbound.peer, text: e.inbound.text });
          return;
        }
        // status / qr → 账号快照变了,通知 provider 重渲。
        notifyState();
      });
      entries.set(id, { channel, unsub });
      notifyState();
      try {
        await channel.connect();
      } catch (err) {
        // connect 失败不抛断 UI:留在列表里显示 error 态(graceful degradation)。
        notifyState();
        void err;
      }
      return id;
    },

    listRemotes(): RemoteAccount[] {
      return [...entries.entries()].map(([id, { channel }]) => ({
        id,
        kind: channel.kind,
        label: channel.label,
        status: channel.status(),
        qr: channel.qr(),
      }));
    },

    getQr(remoteId: string): string | null {
      return entries.get(remoteId)?.channel.qr() ?? null;
    },

    on(listener: () => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    setInbound(sink: (msg: RemoteInboundMsg) => void): void {
      inbound = sink;
    },

    async send(origin: RemoteOrigin, text: string): Promise<void> {
      const entry = entries.get(origin.remoteId);
      if (!entry) return;
      await entry.channel.send(origin.peer, text);
    },

    async dispose(): Promise<void> {
      for (const { channel, unsub } of entries.values()) {
        try {
          unsub();
          await channel.dispose();
        } catch {
          /* ignore */
        }
      }
      entries.clear();
      stateListeners.clear();
      inbound = null;
    },
  };
}
