/**
 * stdio MCP client factory — CLI host 侧 spawn 实现（WS-A）。
 *
 * core 本体（`src/capability/mcp/connect.ts`）**不引 `child_process`**：stdio 传输
 * 由 host 经 `deps.stdioFactory` 注入。本文件就是 CLI host 提供的那一份注入——把
 * 一个 stdio MCP server `spawn` 成子进程,把它的 stdin/stdout 包成 core 的最小
 * `Transport`(newline-framed JSON-RPC),再交给 core 自带的 `InProcessMCPClient`
 * 跑握手 / tools/list / tools/call。
 *
 * 帧格式(对齐 MCP stdio transport spec):每条 JSON-RPC 消息一行 `JSON.stringify(msg)+"\n"`
 * 写进 child stdin;child stdout 同样逐行回。处理跨 data 事件的半行(buffer + split
 * on '\n')。child 退出 / spawn 失败 → onerror + onclose,挂起的请求被 InProcessMCPClient
 * 的 onclose 统一 reject(不泄漏 pending)。
 *
 * close() 先 SIGTERM,grace 超时后 SIGKILL —— 确保 disposers 跑完后子进程不残留。
 *
 * Boundary: 这是 host 层(src/cli/),允许 import `node:child_process`(对齐 io.ts)。
 * 依赖方向仍是 cli→core(只 import core-local 相对路径 + node:)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { McpStdioServerConfig } from '../capability/mcp/config';
import type { ResolveMcpDeps } from '../capability/mcp/connect';
import type { MCPClient } from '../capability/mcp/client';
import { InProcessMCPClient } from '../capability/mcp/client';
import type { Transport, TransportMessage } from '../capability/mcp/transport';

/** SIGTERM → SIGKILL 之间的宽限期(ms)。 */
const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * 把一个 spawn 出来的子进程包成 core 的 `Transport`。
 *   - `send(msg)`: `JSON.stringify(msg)+"\n"` 写进 child stdin。
 *   - child stdout: buffer + 按 '\n' 切,每整行 `JSON.parse` → `onmessage`;半行留 buffer。
 *   - child stderr: 逐行 → `onerror`(诊断用,不视为致命)。
 *   - child exit / spawn error: `onerror`(error 时) + `onclose`(InProcessMCPClient 据此
 *     reject 全部 pending)。
 *   - `close()`: SIGTERM,grace 后 SIGKILL,并触发一次 onclose。
 */
function makeChildTransport(child: ChildProcess, killGraceMs: number): Transport {
  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let stdoutBuf = '';
  let stderrBuf = '';

  const transport: Transport = {
    async start(): Promise<void> {
      // spawn 已经启动;无额外握手。
    },
    async send(message: TransportMessage): Promise<void> {
      if (closed) throw new Error('MCP stdio transport is closed');
      if (!child.stdin || !child.stdin.writable) {
        throw new Error('MCP stdio transport: child stdin not writable');
      }
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, killGraceMs);
      // close() 的语义是「主动关」:立即触发 onclose,让 InProcessMCPClient reject pending。
      transport.onclose?.();
    },
  };

  // stdout: 累积 + 逐行 JSON.parse。半行(跨 data 事件)留在 stdoutBuf 等下一块。
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let parsed: TransportMessage;
      try {
        parsed = JSON.parse(line) as TransportMessage;
      } catch (e) {
        transport.onerror?.(
          e instanceof Error ? e : new Error(`MCP stdio: bad JSON line: ${line.slice(0, 120)}`),
        );
        continue;
      }
      transport.onmessage?.(parsed);
    }
  });

  // stderr: 逐行抛给 onerror(诊断;非致命)。
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk;
    let nl: number;
    while ((nl = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, nl).trim();
      stderrBuf = stderrBuf.slice(nl + 1);
      if (line) transport.onerror?.(new Error(`MCP stdio stderr: ${line}`));
    }
  });

  // spawn 失败(命令不存在等)→ onerror + onclose。
  child.on('error', (err: Error) => {
    transport.onerror?.(err);
    if (!closed) {
      closed = true;
      transport.onclose?.();
    }
  });

  // child 退出 → onclose(若非主动 close 触发的)。clearTimeout 防 SIGKILL timer 泄漏。
  child.on('exit', () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (!closed) {
      closed = true;
      transport.onclose?.();
    }
  });

  return transport;
}

/**
 * 造一份 stdio MCP client factory,供 CLI 注入到 `assembleCapabilities` 的
 * `mcp.deps.stdioFactory`。每次调用 `spawn` 一个子进程并返回一个 `MCPClient`,
 * 其 `close()` 同时 tear down 子进程(InProcessMCPClient.close() → transport.close()
 * → SIGTERM/SIGKILL)。
 *
 * @param killGraceMs SIGTERM 后等多久 SIGKILL(默认 2000ms)。
 */
export function makeStdioMcpFactory(
  killGraceMs: number = DEFAULT_KILL_GRACE_MS,
): NonNullable<ResolveMcpDeps['stdioFactory']> {
  return (name: string, config: McpStdioServerConfig): MCPClient => {
    const child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const transport = makeChildTransport(child, killGraceMs);
    // InProcessMCPClient 构造时把 transport.onmessage / onclose 接管;它的 close()
    // 会 await transport.close() → 杀子进程。serverRequestDeps 暂不注入(host 无 deps
    // 透传到此 —— stdioFactory 签名只给 name+config;反向请求 handler 走默认 fail-open)。
    return new InProcessMCPClient(name, transport);
  };
}
