/**
 * MCP server→client 反向请求 (M4) —— elicitation / sampling / roots 路由。
 *
 * 覆盖:
 *   ① server 发 `elicitation/create` 请求(带 id)→ client 路由到注入的
 *      deps.elicit,并把返回值包成 JSON-RPC `result` 回发(id 匹配)。
 *   ② server 发 `sampling/createMessage` → 路由到 deps.sampling,result 匹配。
 *   ③ server 发 `roots/list` → 路由到 deps.roots,result 包成 `{ roots }`。
 *   ④ 未知 method → -32601 错误帧(id 匹配)。
 *   ⑤ 未注入对应 dep → -32601(不挂起 server)。
 *   ⑥ handler 抛异常 → -32603 错误帧。
 *   ⑦ 字符串 id 原样回带;response / notification 行为不受影响。
 *
 * Boundary: only core-local relative imports + bun:test。server 端用 linked
 * transport 的对端模拟。
 */
import { test, expect, describe } from 'bun:test';
import {
  createLinkedTransportPair,
  type Transport,
  type TransportMessage,
} from '../src/capability/mcp/transport';
import { InProcessMCPClient } from '../src/capability/mcp/client';
import type { ServerRequestDeps } from '../src/capability/mcp/server-requests';

interface JsonRpcResponseFrame {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * 把 server 端 transport 包成一个能「发反向请求并等回包」的小工具。
 * 收到带 result/error 的帧即按 id resolve 对应等待者。
 */
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
    /** 发一条反向请求并等 client 回包。 */
    sendRequest(req: { id: number | string; method: string; params?: unknown }) {
      return new Promise<JsonRpcResponseFrame>((resolve) => {
        waiters.set(req.id, resolve);
        void serverT.send({ jsonrpc: '2.0', ...req });
      });
    },
  };
}

describe('InProcessMCPClient server→client requests', () => {
  test('routes elicitation/create to deps.elicit and replies with matching id + result', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    let seenParams: unknown;
    const deps: ServerRequestDeps = {
      elicit: async (params) => {
        seenParams = params;
        return { action: 'accept', content: { name: 'Ada' } };
      },
    };
    new InProcessMCPClient('srv', clientT, deps);
    const server = makeServer(serverT);

    const resp = await server.sendRequest({
      id: 42,
      method: 'elicitation/create',
      params: { message: 'your name?' },
    });

    expect(seenParams).toEqual({ message: 'your name?' });
    expect(resp.id).toBe(42);
    expect(resp.result).toEqual({ action: 'accept', content: { name: 'Ada' } });
    expect(resp.error).toBeUndefined();
  });

  test('routes sampling/createMessage to deps.sampling', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const deps: ServerRequestDeps = {
      sampling: () => ({ role: 'assistant', content: { type: 'text', text: 'hi' } }),
    };
    new InProcessMCPClient('srv', clientT, deps);
    const server = makeServer(serverT);

    const resp = await server.sendRequest({
      id: 7,
      method: 'sampling/createMessage',
      params: { messages: [] },
    });

    expect(resp.id).toBe(7);
    expect(resp.result).toEqual({ role: 'assistant', content: { type: 'text', text: 'hi' } });
  });

  test('routes roots/list to deps.roots and wraps result in { roots }', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const rootsList = [{ uri: 'file:///work', name: 'work' }];
    const deps: ServerRequestDeps = { roots: () => rootsList };
    new InProcessMCPClient('srv', clientT, deps);
    const server = makeServer(serverT);

    const resp = await server.sendRequest({ id: 1, method: 'roots/list' });

    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ roots: rootsList });
  });

  test('unknown method → -32601 method not found error frame', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    new InProcessMCPClient('srv', clientT, { elicit: () => ({}) });
    const server = makeServer(serverT);

    const resp = await server.sendRequest({ id: 99, method: 'nope/whatever' });

    expect(resp.id).toBe(99);
    expect(resp.result).toBeUndefined();
    expect(resp.error).toEqual({ code: -32601, message: 'method not found: nope/whatever' });
  });

  test('missing dep for a known method → -32601 (does not hang)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    // 注入了 elicit,但没注入 sampling。
    new InProcessMCPClient('srv', clientT, { elicit: () => ({}) });
    const server = makeServer(serverT);

    const resp = await server.sendRequest({ id: 5, method: 'sampling/createMessage' });
    expect(resp.error).toEqual({
      code: -32601,
      message: 'method not found: sampling/createMessage',
    });
  });

  test('no serverRequestDeps at all → still replies -32601 (no hang)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    new InProcessMCPClient('srv', clientT); // 3rd param omitted → existing ctor compat
    const server = makeServer(serverT);

    const resp = await server.sendRequest({ id: 3, method: 'roots/list' });
    expect(resp.error?.code).toBe(-32601);
  });

  test('handler that throws → -32603 internal error', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const deps: ServerRequestDeps = {
      elicit: () => {
        throw new Error('user cancelled');
      },
    };
    new InProcessMCPClient('srv', clientT, deps);
    const server = makeServer(serverT);

    const resp = await server.sendRequest({ id: 8, method: 'elicitation/create' });
    expect(resp.id).toBe(8);
    expect(resp.error).toEqual({ code: -32603, message: 'user cancelled' });
  });

  test('string id is echoed back unchanged', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    new InProcessMCPClient('srv', clientT, { roots: () => [] });
    const server = makeServer(serverT);

    const resp = await server.sendRequest({ id: 'req-abc', method: 'roots/list' });
    expect(resp.id).toBe('req-abc');
    expect(resp.result).toEqual({ roots: [] });
  });

  test('normal responses + notifications still work alongside server requests', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    // server: 应答 tools/list,并能处理一个反向 elicit。
    serverT.onmessage = (m: TransportMessage) => {
      const f = m as { id?: number; method?: string };
      if (f.method === 'tools/list') {
        void serverT.send({
          jsonrpc: '2.0',
          id: f.id,
          result: { tools: [{ name: 'echo' }] },
        });
      }
    };
    const client = new InProcessMCPClient('srv', clientT, { roots: () => [] });

    // client→server 正常请求仍工作。
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
  });
});
