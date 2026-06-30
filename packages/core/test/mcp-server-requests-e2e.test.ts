/**
 * MCP server→client 反向请求 —— 端到端集成 e2e(INTEGRATE-MCP)。
 *
 * M4 的单测(test/mcp-server-requests.test.ts)已覆盖 elicitation/sampling/roots 的
 * 纯路由 + 错误/不挂起语义。本文件补**跨缝集成**角度:
 *   - 把 `sampling/createMessage` 的 host handler 真接到一个 fake `LLMProvider`
 *     (sampling dep 调 provider.stream 取一条 assistant 文本作 result),证明 M4
 *     的 server-requests 缝能与 core 的 provider 缝端到端对接。
 *   - 在**同一** client 上依次跑通 sampling / elicitation / roots 三类反向请求,
 *     验证多类反向请求与正常 tools/call 并存不互扰。
 *
 * 全程经 `createLinkedTransportPair` + `InProcessMCPClient(serverRequestDeps)`,
 * server 端用 linked transport 对端模拟。Boundary:仅 core-local 相对 import。
 */
import { test, expect, describe } from 'bun:test';
import {
  createLinkedTransportPair,
  type Transport,
  type TransportMessage,
} from '../src/capability/mcp/transport';
import { InProcessMCPClient } from '../src/capability/mcp/client';
import type { ServerRequestDeps } from '../src/capability/mcp/server-requests';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

interface JsonRpcResponseFrame {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** server 端:发反向请求并按 id 等回包(同 M4 单测 idiom)。 */
function makeServer(serverT: Transport) {
  const waiters = new Map<number | string, (r: JsonRpcResponseFrame) => void>();
  serverT.onmessage = (m: TransportMessage) => {
    const frame = m as JsonRpcResponseFrame;
    if ('id' in frame && ('result' in frame || 'error' in frame)) {
      const w = waiters.get(frame.id);
      if (w) {
        waiters.delete(frame.id);
        w(frame);
      }
    }
  };
  return {
    sendRequest(req: { id: number | string; method: string; params?: unknown }) {
      return new Promise<JsonRpcResponseFrame>((resolve) => {
        waiters.set(req.id, resolve);
        void serverT.send({ jsonrpc: '2.0', ...req });
      });
    },
  };
}

/** fake LLMProvider:回一条固定 assistant 文本(供 sampling dep 借用)。 */
function fakeProvider(text: string): LLMProvider {
  return {
    api: 'stub',
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage: { ...EMPTY_USAGE } as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

describe('MCP server→client requests — 跨缝集成 e2e', () => {
  test('sampling/createMessage 的 host handler 真驱动 fake LLMProvider 并回 result', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const provider = fakeProvider('sampled-answer');

    // sampling dep:把 server 的采样请求翻成一次 provider.stream,抽文本回 result。
    const deps: ServerRequestDeps = {
      sampling: async (params, signal) => {
        const req = params as { messages?: unknown[] };
        let out = '';
        for await (const ev of provider.stream(
          {
            model: 'm',
            system: [],
            tools: [],
            messages: (req.messages as never) ?? [],
          },
          { signal: signal ?? new AbortController().signal },
        )) {
          if (ev.type === 'assistant') {
            const content = (ev.message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
            out = content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('');
          }
        }
        return { role: 'assistant', content: { type: 'text', text: out } };
      },
    };
    new InProcessMCPClient('srv', clientT, deps);
    const server = makeServer(serverT);

    const resp = await server.sendRequest({
      id: 'samp-1',
      method: 'sampling/createMessage',
      params: { messages: [{ role: 'user', content: 'q' }] },
    });

    expect(resp.id).toBe('samp-1');
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ role: 'assistant', content: { type: 'text', text: 'sampled-answer' } });
  });

  test('同一 client 上 sampling / elicitation / roots 依次往返,与 tools/call 并存', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const provider = fakeProvider('hello-from-llm');
    const deps: ServerRequestDeps = {
      sampling: async () => {
        let out = '';
        for await (const ev of provider.stream(
          { model: 'm', system: [], tools: [], messages: [] },
          { signal: new AbortController().signal },
        )) {
          if (ev.type === 'assistant') {
            const c = (ev.message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
            out = c.map((b) => b.text ?? '').join('');
          }
        }
        return { role: 'assistant', content: { type: 'text', text: out } };
      },
      elicit: async (params) => ({ action: 'accept', echoed: params }),
      roots: () => [{ uri: 'file:///w', name: 'w' }],
    };
    const client = new InProcessMCPClient('srv', clientT, deps);
    const server = makeServer(serverT);

    const samp = await server.sendRequest({ id: 1, method: 'sampling/createMessage', params: { messages: [] } });
    expect((samp.result as { content: { text: string } }).content.text).toBe('hello-from-llm');

    const elic = await server.sendRequest({ id: 2, method: 'elicitation/create', params: { ask: 'name' } });
    expect(elic.result).toEqual({ action: 'accept', echoed: { ask: 'name' } });

    const roots = await server.sendRequest({ id: 3, method: 'roots/list' });
    expect(roots.result).toEqual({ roots: [{ uri: 'file:///w', name: 'w' }] });

    // client 主流程(tools/call)与反向请求并存不互扰:server 端答 tools/call。
    serverT.onmessage = (m: TransportMessage) => {
      const f = m as { id?: number; method?: string };
      if (f.method === 'tools/call' && typeof f.id === 'number') {
        void serverT.send({ jsonrpc: '2.0', id: f.id, result: { content: [{ type: 'text', text: 'tool-ok' }] } });
      }
    };
    const callResult = await client.callTool('do', { a: 1 });
    expect(callResult.content).toEqual([{ type: 'text', text: 'tool-ok' }]);
  });
});
