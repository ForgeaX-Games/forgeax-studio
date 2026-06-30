/**
 * In-process linked MCP transport pair (C2 / MCP bridge).
 *
 * 在同一进程内跑
 * MCP server + client，不 spawn 子进程。一端 `send()` 经 `queueMicrotask` 异步
 * 投递到对端 `onmessage`（避免同步 request/response 循环把调用栈打深）；任一端
 * `close()` 双向触发 `onclose`。
 *
 * Boundary: 仅定义 core-local 的最小 `Transport` 接口 —— **不引外部 MCP SDK**
 * （`@modelcontextprotocol/sdk`），core 不依赖 boundary。host 若用真 SDK，可把
 * 本接口适配到 SDK 的 `Transport`（结构兼容 send/onmessage/close/start）。
 */

/** 透传的 JSON-RPC 消息（core 不解析其结构，原样投递）。 */
export type TransportMessage = unknown;

/**
 * 最小 MCP transport 接口。形状对齐 MCP SDK `Transport`（子集）：
 *   - `send(msg)`: 发往对端。
 *   - `onmessage`: 收到对端消息的回调（host/SDK 挂）。
 *   - `onclose` / `onerror`: 生命周期回调。
 *   - `start()`: 启动（in-process 下为空实现）。
 *   - `close()`: 关闭，双向触发 onclose。
 */
export interface Transport {
  start?(): Promise<void>;
  send(message: TransportMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: TransportMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

/**
 * 进程内 linked transport。两端互为 peer：本端 send → 对端 onmessage（异步）。
 */
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined;
  private closed = false;

  onmessage?: (message: TransportMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  /** @internal —— 仅 createLinkedTransportPair 配对时调用。 */
  _setPeer(peer: InProcessTransport): void {
    this.peer = peer;
  }

  /** @internal —— peer.close() 标记本端已关，用于幂等。 */
  get _closed(): boolean {
    return this.closed;
  }

  /** @internal */
  _markClosed(): void {
    this.closed = true;
  }

  async start(): Promise<void> {
    // in-process: 无连接建立，空实现。
  }

  async send(message: TransportMessage): Promise<void> {
    if (this.closed) {
      throw new Error('Transport is closed');
    }
    // 异步投递到对端，避免同步 request/response 循环把栈打深。
    queueMicrotask(() => {
      this.peer?.onmessage?.(message);
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onclose?.();
    // 双向关闭：对端尚未关则一并关并触发其 onclose。
    if (this.peer && !this.peer._closed) {
      this.peer._markClosed();
      this.peer.onclose?.();
    }
  }
}

/**
 * 创建一对 linked transport：一端 send 的消息投递到另一端 onmessage。
 *
 * @returns `[clientTransport, serverTransport]`
 */
export function createLinkedTransportPair(): [Transport, Transport] {
  const a = new InProcessTransport();
  const b = new InProcessTransport();
  a._setPeer(b);
  b._setPeer(a);
  return [a, b];
}
