/**
 * serve sidecar e2e(hermetic)—— 驱动**真实 `forgeax-core --serve` 子进程**,经 unix-socket
 * 上的双向 JSON-RPC(rpc.ts 同款线协议)验证第三种形态(AgentKernel sidecar)的整条协议面,
 * **全程离线**:provider 从 env `ANTHROPIC_BASE_URL` 造,指向本地 mock Anthropic SSE。
 *
 * 这条补的是覆盖空白:原有 serve e2e(subagent-serve-e2e.ts / observability-serve-e2e.ts /
 * plan-serve-e2e.ts)都需真 API key、不进 `bun test` —— sidecar 协议改坏(方法重命名 / 帧
 * 变化 / 错误码 / 反向 hostTool 桥断)在 hermetic 套件里此前无人兜底。
 *
 * 覆盖(控制面 + 反向面 + 事件面):
 *   - ping                         → {ok:true}(健康探测)
 *   - runTurn(纯文本)             → `event` 通知流回 message.delta(assistant 文本)+ turn.done;请求 resolve
 *   - runTurn(工具)               → tool.call(name=compute)→ **反向 hostTool 请求回宿主** → tool.result → message.delta → turn.done
 *   - 未知方法                     → JSON-RPC error code -32601
 *   - setModel / setPermissionMode → {ok:true}(经 openHandle 透传)
 *
 * Boundary(test 层):core-local rpc.ts + agent-runtime 契约 + node:,与 src 同源线协议。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcConnection } from '../src/cli/rpc';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── mock Anthropic SSE(与 cli-e2e.test.ts 同款帧)────────────────────────────
function sse(frames: Array<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}
function toolUseTurn(name: string, input: unknown): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'm', role: 'assistant', model: 'x', usage: { input_tokens: 9, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}
function textTurn(text: string): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'm', role: 'assistant', model: 'x', usage: { input_tokens: 9, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

// mock 状态:每条独立 turn 调一次(纯文本)或两次(工具→续轮)。以"请求里是否已含 tool_result"
// 决定回文本还是回工具,避免跨 test 的计数串扰(无状态、按请求内容决策)。
let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: Array<{ role: string; content: unknown }> };
      const msgs = body.messages ?? [];
      const flat = JSON.stringify(msgs);
      // 已经回灌了 compute 的 tool_result → 收口文本;否则若提示要工具 → 发 tool_use(compute)。
      const hasToolResult = flat.includes('tool_result') || flat.includes('"compute-done"');
      const wantsTool = flat.includes('USE_TOOL');
      let payload: string;
      if (wantsTool && !hasToolResult) payload = toolUseTurn('compute', { expr: '6*7' });
      else payload = textTurn('SIDECAR_OK');
      return new Response(payload, { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_serve_e2e' } });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});
afterAll(() => server?.stop(true));

// ─── serve 子进程 + 客户端连接 ─────────────────────────────────────────────────
interface Serve {
  proc: ReturnType<typeof Bun.spawn>;
  conn: RpcConnection;
  events: KernelEvent[];
  hostToolCalls: Array<{ name: string; args: unknown }>;
  close(): void;
}

async function connectRetry(sock: string, deadlineMs = 10000): Promise<RpcConnection> {
  const end = Date.now() + deadlineMs;
  // 先等 socket 文件出现 —— connect() 对尚不存在的 unix sock 在 Bun 下会冒出无法稳定捕获的
  // ENOENT 'error',故用 fs 存在性把门,避免在 serve boot 完成前去 connect。
  while (!existsSync(sock)) {
    if (Date.now() > end) throw new Error(`serve socket never appeared: ${sock}`);
    await sleep(100);
  }
  for (;;) {
    const conn = await new Promise<RpcConnection | null>((res) => {
      const s = connect(sock, () => res(new RpcConnection(s)));
      s.on('error', () => res(null));
    });
    if (conn) return conn;
    if (Date.now() > end) throw new Error(`serve endpoint not reachable: ${sock}`);
    await sleep(150);
  }
}

/** 起 serve,连上,装好反向 hostTool 处理器 + event 收集。 */
async function startServe(): Promise<Serve> {
  const sock = join(tmpdir(), `fxc-serve-e2e-${Date.now()}-${Math.floor(performance.now())}.sock`);
  const proc = Bun.spawn(['bun', MAIN, '--serve', '--sock', sock], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'dummy-serve-e2e',
      ANTHROPIC_BASE_URL: baseUrl,
      FORGEAX_THINKING: 'off', // 简化 SSE(不掺 thinking 流)
      FORGEAX_OTEL: 'off', // 不挂 OTLP exporter
      FORGEAX_PEER_AGENTS: '0', // 不挂子 agent 调度器
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const conn = await connectRetry(sock);
  const events: KernelEvent[] = [];
  const hostToolCalls: Array<{ name: string; args: unknown }> = [];
  // 反向 hostTool 桥:serve 的工具执行回调宿主,这里复跑并回结果(compute 恒成功)。
  conn.setRequestHandler(async (method, params) => {
    if (method === 'hostTool') {
      const p = params as { name: string; args: unknown };
      hostToolCalls.push({ name: p.name, args: p.args });
      return { result: 'compute-done: 42' };
    }
    throw Object.assign(new Error(`unknown ${method}`), { code: -32601 });
  });
  conn.onNotify((method, params) => {
    if (method === 'event') events.push((params as { event: KernelEvent }).event);
  });
  return {
    proc,
    conn,
    events,
    hostToolCalls,
    close() {
      try { conn.close(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}

function turnReq(callId: string, prompt: string, withTool: boolean): TurnRequest {
  return {
    session: { threadId: callId, agentId: 'forge' },
    callId,
    input: { text: prompt },
    systemPrompt: { charter: 'You are a terse test agent.', persona: '' },
    tools: withTool
      ? [{ name: 'compute', description: 'Compute a number. Always succeeds.', inputSchema: { type: 'object', properties: { expr: { type: 'string' } } } }]
      : [],
    budget: { maxTurns: 6 },
    model: 'claude-opus-4-8',
    hostSessionId: 'sid-serve-e2e',
    trustTier: 'own',
  } as TurnRequest;
}

describe('serve sidecar e2e (real --serve subprocess, JSON-RPC over unix socket, mock SSE)', () => {
  test('ping → {ok:true}', async () => {
    const s = await startServe();
    try {
      const res = (await s.conn.request('ping')) as { ok?: boolean };
      expect(res?.ok).toBe(true);
    } finally {
      s.close();
    }
  }, 30000);

  test('runTurn (text) → message.delta streams assistant text + turn.done', async () => {
    const s = await startServe();
    try {
      const res = (await s.conn.request('runTurn', turnReq('c-text', 'say hi', false))) as { ok?: boolean };
      expect(res?.ok).toBe(true);
      const kinds = s.events.map((e) => e.kind);
      expect(kinds).toContain('turn.done');
      const text = s.events
        .filter((e): e is Extract<KernelEvent, { kind: 'message.delta' }> => e.kind === 'message.delta')
        .map((e) => e.text)
        .join('');
      expect(text).toContain('SIDECAR_OK');
    } finally {
      s.close();
    }
  }, 30000);

  test('runTurn (tool) → tool.call + reverse hostTool bridge invoked + tool.result + turn.done', async () => {
    const s = await startServe();
    try {
      const res = (await s.conn.request('runTurn', turnReq('c-tool', 'USE_TOOL please compute', true))) as { ok?: boolean };
      expect(res?.ok).toBe(true);
      const kinds = s.events.map((e) => e.kind);
      // 模型发了工具调用,serve 把它经反向桥回调了宿主。
      expect(kinds).toContain('tool.call');
      expect(s.hostToolCalls.map((c) => c.name)).toContain('compute');
      // 宿主回的结果流回成 tool.result,随后续轮收口。
      expect(kinds).toContain('tool.result');
      expect(kinds).toContain('turn.done');
    } finally {
      s.close();
    }
  }, 30000);

  test('unknown method → JSON-RPC error -32601', async () => {
    const s = await startServe();
    try {
      let code: number | undefined;
      try {
        await s.conn.request('nonsense-method', {});
      } catch (e) {
        code = (e as { code?: number }).code;
      }
      expect(code).toBe(-32601);
    } finally {
      s.close();
    }
  }, 30000);

  test('setModel / setPermissionMode → {ok:true} (control-plane passthrough)', async () => {
    const s = await startServe();
    try {
      const m = (await s.conn.request('setModel', { callId: 'c-ctl', model: 'claude-sonnet-4-6' })) as { ok?: boolean };
      expect(m?.ok).toBe(true);
      const p = (await s.conn.request('setPermissionMode', { callId: 'c-ctl', mode: 'planning' })) as { ok?: boolean };
      expect(p?.ok).toBe(true);
    } finally {
      s.close();
    }
  }, 30000);
});
