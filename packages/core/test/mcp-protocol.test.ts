/**
 * MCP protocol depth (WS4) — initialize 握手 / capabilities / list_changed 通知 /
 * 重连退避。
 *
 * 覆盖:
 *   ① InProcessMCPClient.initialize() over createLinkedTransportPair + stub server:
 *      发 JSON-RPC `initialize`(protocolVersion/capabilities:{}/clientInfo) →
 *      存 server 回报的 capabilities 到 serverCapabilities;之后才 tools/list。
 *   ② notifications/tools/list_changed(无 id 通知帧)→ 触发 onToolsChanged;
 *      其余非 response 帧仍安全忽略(不挂起 pending)。
 *   ③ FetchMCPClient.initialize() 用假 fetch 跑握手 + 存 capabilities。
 *   ④ 重连/退避: FetchMCPClient 对瞬时网络错 / 5xx 有界重试(max 2),最终成功 /
 *      到顶抛错;abort 与 4xx 不重试。sleep 注入 no-op,测试零等待。
 *
 * Boundary: only core-local relative imports + node:. Stub transport/MCP server +
 * 假 fetch。
 */
import { test, expect, describe } from 'bun:test';
import {
  createLinkedTransportPair,
  type Transport,
  type TransportMessage,
} from '../src/capability/mcp/transport';
import {
  InProcessMCPClient,
  NOTIFICATION_TOOLS_LIST_CHANGED,
  MCP_PROTOCOL_VERSION,
} from '../src/capability/mcp/client';
import { FetchMCPClient } from '../src/capability/mcp/connect';

// ─── stub MCP server (server end of a linked transport) ───────────────────────

interface JsonRpcReq {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

type ServerHandler = (req: JsonRpcReq, transport: Transport) => void;

/** Handler that answers initialize + tools/list + tools/call. */
function protocolHandler(
  capabilities: Record<string, unknown>,
): ServerHandler {
  return (req, t) => {
    if (req.method === 'initialize') {
      void t.send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities,
          serverInfo: { name: 'stub', version: '1.0' },
        },
      });
      return;
    }
    if (req.method === 'tools/list') {
      void t.send({
        jsonrpc: '2.0',
        id: req.id,
        result: { tools: [{ name: 'echo' }] },
      });
      return;
    }
    void t.send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `method not found: ${req.method}` },
    });
  };
}

function attachServer(
  serverTransport: Transport,
  handler: ServerHandler,
): { seen: JsonRpcReq[] } {
  const seen: JsonRpcReq[] = [];
  serverTransport.onmessage = (m: TransportMessage) => {
    const req = m as JsonRpcReq;
    seen.push(req);
    handler(req, serverTransport);
  };
  return { seen };
}

// ─── ① initialize handshake (InProcessMCPClient) ──────────────────────────────

describe('InProcessMCPClient.initialize handshake', () => {
  test('sends initialize with protocolVersion/capabilities/clientInfo and stores server capabilities', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const caps = { tools: { listChanged: true }, logging: {} };
    const { seen } = attachServer(serverT, protocolHandler(caps));
    const client = new InProcessMCPClient('srv', clientT);

    // 握手前无 capabilities。
    expect(client.serverCapabilities).toBeUndefined();

    const init = await client.initialize({ name: 'tester', version: '9.9' });

    // 发出的 initialize 帧形状对齐 MCP spec。
    const initReq = seen.find((r) => r.method === 'initialize')!;
    expect(initReq).toBeDefined();
    expect(initReq.params).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tester', version: '9.9' },
    });

    // server 回报的 capabilities 被存下 + 由返回值带出。
    expect(client.serverCapabilities).toEqual(caps);
    expect(init.capabilities).toEqual(caps);
    expect(init.serverInfo).toEqual({ name: 'stub', version: '1.0' });
  });

  test('initialize uses default clientInfo when none passed', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const { seen } = attachServer(serverT, protocolHandler({}));
    const client = new InProcessMCPClient('srv', clientT);

    await client.initialize();
    const initReq = seen.find((r) => r.method === 'initialize')!;
    const params = initReq.params as { clientInfo: { name: string; version: string } };
    expect(typeof params.clientInfo.name).toBe('string');
    expect(params.clientInfo.name.length).toBeGreaterThan(0);
    expect(typeof params.clientInfo.version).toBe('string');
  });

  test('initialize precedes tools/list in real flow (handshake-then-list)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const { seen } = attachServer(serverT, protocolHandler({ tools: {} }));
    const client = new InProcessMCPClient('srv', clientT);

    await client.initialize();
    const tools = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(seen.map((r) => r.method)).toEqual(['initialize', 'tools/list']);
  });

  test('initialize tolerates a result without capabilities → serverCapabilities undefined', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT, (req, t) => {
      void t.send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 'x' } });
    });
    const client = new InProcessMCPClient('srv', clientT);
    const init = await client.initialize();
    expect(init.protocolVersion).toBe('x');
    expect(client.serverCapabilities).toBeUndefined();
  });
});

// ─── ② notifications/tools/list_changed ───────────────────────────────────────

describe('InProcessMCPClient notifications', () => {
  test('tools/list_changed notification invokes onToolsChanged', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const client = new InProcessMCPClient('srv', clientT);
    let changed = 0;
    client.onToolsChanged = () => changed++;

    // server emits an id-less notification frame.
    await serverT.send({ jsonrpc: '2.0', method: NOTIFICATION_TOOLS_LIST_CHANGED });
    await new Promise<void>((r) => queueMicrotask(r));

    expect(changed).toBe(1);
  });

  test('missing onToolsChanged callback is safe (no throw)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    new InProcessMCPClient('srv', clientT); // no onToolsChanged attached
    await serverT.send({ jsonrpc: '2.0', method: NOTIFICATION_TOOLS_LIST_CHANGED });
    await new Promise<void>((r) => queueMicrotask(r));
    // 到这里没抛即通过。
    expect(true).toBe(true);
  });

  test('other notifications do NOT invoke onToolsChanged and do not settle pending requests', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    // Server: on tools/list, first send an unrelated notification, then never answer.
    attachServer(serverT, (req) => {
      if (req.method === 'tools/list') {
        void serverT.send({ jsonrpc: '2.0', method: 'notifications/progress' });
      }
    });
    const client = new InProcessMCPClient('srv', clientT);
    let changed = 0;
    client.onToolsChanged = () => changed++;

    let settled = false;
    const p = client.listTools().then(() => {
      settled = true;
    });
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(changed).toBe(0); // unrelated notification ignored
    expect(settled).toBe(false); // request still pending (not resolved by notification)

    await client.close();
    await expect(p).rejects.toThrow('MCP transport closed');
  });

  test('notification after a normal response still routes correctly', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT, (req, t) => {
      if (req.method === 'tools/list') {
        void t.send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'a' }] } });
        // 紧跟一个 list_changed 通知。
        void t.send({ jsonrpc: '2.0', method: NOTIFICATION_TOOLS_LIST_CHANGED });
      }
    });
    const client = new InProcessMCPClient('srv', clientT);
    let changed = 0;
    client.onToolsChanged = () => changed++;

    const tools = await client.listTools();
    await new Promise<void>((r) => queueMicrotask(r));

    expect(tools.map((t) => t.name)).toEqual(['a']);
    expect(changed).toBe(1);
  });
});

// ─── ③ FetchMCPClient.initialize ──────────────────────────────────────────────

describe('FetchMCPClient.initialize handshake', () => {
  test('sends initialize over fetch and stores capabilities', async () => {
    const bodies: { method: string; params?: unknown }[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
      bodies.push({ method: body.method, params: body.params });
      const result =
        body.method === 'initialize'
          ? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true } } }
          : {};
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient('remote', 'https://h/mcp', undefined, fakeFetch);
    expect(client.serverCapabilities).toBeUndefined();

    const init = await client.initialize();
    expect(bodies[0].method).toBe('initialize');
    expect(bodies[0].params).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: expect.any(String) },
    });
    expect(client.serverCapabilities).toEqual({ tools: { listChanged: true } });
    expect(init.capabilities).toEqual({ tools: { listChanged: true } });
  });
});

// ─── ④ reconnect / bounded backoff (FetchMCPClient) ───────────────────────────

describe('FetchMCPClient bounded backoff', () => {
  /** no-op sleep so tests don't actually wait; record delays for assertions. */
  function recordingSleep() {
    const delays: number[] = [];
    return {
      delays,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    };
  }

  function ok(id: number, result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  test('retries transient 5xx then succeeds (max 2 retries, exponential delay)', async () => {
    const { delays, sleep } = recordingSleep();
    let n = 0;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      n++;
      if (n <= 2) return new Response('boom', { status: 503, statusText: 'Unavailable' });
      return ok(body.id, { tools: [{ name: 'recovered' }] });
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch, {
      baseDelayMs: 10,
      sleep,
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['recovered']);
    expect(n).toBe(3); // 1 initial + 2 retries
    expect(delays).toEqual([10, 20]); // 10*2^0, 10*2^1
  });

  test('gives up after maxRetries on persistent 5xx and surfaces the error', async () => {
    const { delays, sleep } = recordingSleep();
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return new Response('down', { status: 500, statusText: 'Server Error' });
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch, {
      baseDelayMs: 5,
      sleep,
    });
    await expect(client.listTools()).rejects.toThrow('HTTP 500');
    expect(n).toBe(3); // 1 + 2 retries, no more
    expect(delays).toEqual([5, 10]);
  });

  test('does NOT retry permanent 4xx', async () => {
    const { sleep } = recordingSleep();
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return new Response('bad', { status: 400, statusText: 'Bad Request' });
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch, { sleep });
    await expect(client.listTools()).rejects.toThrow('HTTP 400');
    expect(n).toBe(1); // no retries
  });

  test('retries transient network TypeError then succeeds', async () => {
    const { sleep } = recordingSleep();
    let n = 0;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      return ok(body.id, { tools: [{ name: 'back' }] });
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch, {
      baseDelayMs: 1,
      sleep,
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['back']);
    expect(n).toBe(2);
  });

  test('does NOT retry on abort', async () => {
    const { sleep } = recordingSleep();
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch, { sleep });
    await expect(client.listTools()).rejects.toThrow('aborted');
    expect(n).toBe(1); // abort is not transient
  });

  test('maxRetries:0 disables retry', async () => {
    const { sleep } = recordingSleep();
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return new Response('x', { status: 502, statusText: 'Bad Gateway' });
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch, {
      maxRetries: 0,
      sleep,
    });
    await expect(client.listTools()).rejects.toThrow('HTTP 502');
    expect(n).toBe(1);
  });
});
