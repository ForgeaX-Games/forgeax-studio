/**
 * 最小 stdio JSON-RPC 2.0 client(LSP wire format)——给 LSP 子系统用。
 *
 * Language Server Protocol 走「Content-Length + \r\n\r\n + JSON body」的报文帧
 * (即 base protocol),本文件实现:
 *   - 出站:`request()`(带 id、等响应)/ `notify()`(无 id、即发即忘);
 *   - 入站:按 Content-Length 切帧、解析 JSON、按 id 把响应 resolve 回 request;
 *     server→client 的 request/notification(如 window/logMessage)默认忽略
 *     (本子系统只发请求、读结果,不暴露 server 主动推送)。
 *
 * 传输是开放接缝:本 client 只认一对「write(bytes) + 一个产出 bytes 的可读流」
 * 的 `RpcTransport`,真正的 spawn 由 lsp/client.ts 经注入的 spawner 提供——
 * core 自己不直接 spawn(对齐「IO 经注入」约定;真 child_process 留给 host /
 * 默认 spawner)。
 *
 * Boundary: 仅 import core-local + node:(无第三方依赖)。
 */

/** 一对双向字节传输:出站写、入站读。 */
export interface RpcTransport {
  /** 写出站字节(已是完整一帧或片段,本 client 总是整帧写)。 */
  write(data: Uint8Array): void;
  /** 入站字节流(server stdout)。client 自行按 Content-Length 切帧。 */
  onData(handler: (data: Uint8Array) => void): void;
  /** 关闭传输(kill 进程 / 关管道)。 */
  close(): void;
  /** 进程/传输异常退出(可选,用于把未决 request 全部 reject)。 */
  onClose?(handler: (info: { code: number | null; signal: string | null }) => void): void;
}

/** JSON-RPC 响应里的错误对象。 */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 把 JSON-RPC 消息编成「Content-Length 头 + body」的 LSP 帧字节。 */
export function encodeMessage(msg: unknown): Uint8Array {
  const body = JSON.stringify(msg);
  const bodyBytes = encoder.encode(body);
  const header = encoder.encode(`Content-Length: ${bodyBytes.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + bodyBytes.length);
  out.set(header, 0);
  out.set(bodyBytes, header.length);
  return out;
}

/** 入站字节缓冲 + 按 Content-Length 切出一条条完整 JSON 消息。 */
export class MessageFramer {
  private buf = new Uint8Array(0);

  /** 追加新字节,返回这次能完整切出的所有消息(可能 0 条或多条)。 */
  push(chunk: Uint8Array): unknown[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: unknown[] = [];
    for (;;) {
      const text = decoder.decode(this.buf);
      const sep = text.indexOf('\r\n\r\n');
      if (sep === -1) break;
      const headerText = text.slice(0, sep);
      const m = /content-length:\s*(\d+)/i.exec(headerText);
      if (!m) {
        // 头里没有 Content-Length:跳过这段无效头,避免死循环。
        this.buf = this.buf.slice(encoder.encode(text.slice(0, sep + 4)).length);
        continue;
      }
      const len = Number(m[1]);
      const headerBytes = encoder.encode(text.slice(0, sep + 4)).length;
      if (this.buf.length < headerBytes + len) break; // body 还没收齐
      const bodyBytes = this.buf.slice(headerBytes, headerBytes + len);
      this.buf = this.buf.slice(headerBytes + len);
      try {
        out.push(JSON.parse(decoder.decode(bodyBytes)));
      } catch {
        // 坏 body 丢弃,继续切下一条。
      }
    }
    return out;
  }
}

/** 一个 stdio JSON-RPC client:发 request/notification,按 id 收响应。 */
export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly framer = new MessageFramer();
  private closed = false;

  constructor(private readonly transport: RpcTransport) {
    transport.onData((data) => {
      for (const msg of this.framer.push(data)) this.dispatch(msg);
    });
    transport.onClose?.((info) => {
      this.closed = true;
      const err = new Error(
        `lsp: language server exited (code=${info.code}, signal=${info.signal}) with ${this.pending.size} pending request(s)`,
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { id?: number; result?: unknown; error?: RpcError };
    // 只关心带 id 的「响应」;server→client 的 request/notification 一律忽略。
    if (typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) {
      const e = m.error;
      p.reject(new Error(`lsp rpc error ${e.code}: ${e.message}`));
    } else {
      p.resolve(m.result ?? null);
    }
  }

  /** 发一个带 id 的请求,等到对应响应。可选 AbortSignal 中断等待。 */
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('lsp: client is closed'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('lsp: request aborted'));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const onAbort = (): void => {
        if (this.pending.delete(id)) reject(new Error('lsp: request aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.transport.write(encodeMessage(msg));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** 发一个无 id 的通知(即发即忘)。 */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.transport.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  /** 关闭底层传输并 reject 所有未决请求。 */
  dispose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('lsp: client disposed'));
    this.pending.clear();
    try {
      this.transport.close();
    } catch {
      // 已退出的进程 close 失败可忽略。
    }
  }
}
