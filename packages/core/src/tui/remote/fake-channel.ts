/**
 * FakeChannel —— 离线远端通道桩(--demo / 单测)。
 *
 * 不联网:connect() 立刻吐一个假二维码进 'scan' 态;可选 autoLoginMs 后自动转 'online'
 * (demo 用),或由测试显式调 simulateLogin() / simulateInbound() 驱动。send() 把回复
 * 记进 sent[],供测试断言「回复路由到了正确对端」。
 *
 * Boundary(HOST 层):仅 core 相对 import,无 react/ink。
 */
import type {
  RemoteChannel,
  RemoteEvent,
  RemoteListener,
  RemotePeer,
  RemoteStatus,
} from './channel';

export interface FakeChannelOptions {
  label?: string;
  /** 'scan' 时展示的假二维码 payload。 */
  qrPayload?: string;
  /** connect 后自动登录的延时(ms);省略/0 = 手动(测试用 simulateLogin)。 */
  autoLoginMs?: number;
  /** 自动登录后再自动投一条入站消息的延时(ms);省略/0 = 不自动(demo 自证中转链路用)。 */
  autoInboundMs?: number;
  /** 自动投递的入站文本(默认一句问候)。 */
  autoInboundText?: string;
}

/** FakeChannel:RemoteChannel + 测试驱动钩子(simulateLogin / simulateInbound / sent)。 */
export interface FakeChannel extends RemoteChannel {
  simulateLogin(): void;
  simulateInbound(peer: RemotePeer, text: string): void;
  /** 已发出的回复(send 调用记录),供测试断言。 */
  readonly sent: ReadonlyArray<{ peer: RemotePeer; text: string }>;
}

export function createFakeChannel(opts: FakeChannelOptions = {}): FakeChannel {
  const label = opts.label ?? 'fake-account';
  const qrPayload = opts.qrPayload ?? 'https://fake.local/qr/demo';
  const listeners = new Set<RemoteListener>();
  const sent: Array<{ peer: RemotePeer; text: string }> = [];
  let status: RemoteStatus = 'idle';
  let qr: string | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const emit = (e: RemoteEvent): void => {
    for (const l of listeners) l(e);
  };
  const setStatus = (s: RemoteStatus, detail?: string): void => {
    status = s;
    emit({ type: 'status', status: s, detail });
  };
  const inboundEmit = (peer: RemotePeer, text: string): void => {
    emit({ type: 'message', inbound: { peer, text } });
  };

  const login = (): void => {
    if (status === 'online') return;
    qr = null;
    setStatus('online');
    if (opts.autoInboundMs && opts.autoInboundMs > 0) {
      const t = setTimeout(
        () => inboundEmit({ id: 'fake-peer', name: '演示联系人' }, opts.autoInboundText ?? '你好,帮我看看现在几点'),
        opts.autoInboundMs,
      );
      timers.add(t);
    }
  };

  const channel: FakeChannel = {
    kind: 'fake',
    label,
    get sent() {
      return sent;
    },
    on(listener: RemoteListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async connect(): Promise<void> {
      setStatus('connecting');
      qr = qrPayload;
      setStatus('scan');
      emit({ type: 'qr', payload: qrPayload });
      if (opts.autoLoginMs && opts.autoLoginMs > 0) {
        const t = setTimeout(login, opts.autoLoginMs);
        timers.add(t);
      }
    },
    status: () => status,
    qr: () => qr,
    async send(peer: RemotePeer, text: string): Promise<void> {
      sent.push({ peer, text });
    },
    async dispose(): Promise<void> {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      listeners.clear();
      status = 'offline';
    },
    simulateLogin(): void {
      login();
    },
    simulateInbound(peer: RemotePeer, text: string): void {
      inboundEmit(peer, text);
    },
  };
  return channel;
}
