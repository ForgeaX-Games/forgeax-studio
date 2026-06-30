/**
 * MCP validation cases (≥90% target) — fills the uncovered gaps in:
 *   - client.ts  (InProcessMCPClient, 0% funcs): JSON-RPC round-trip over a
 *     linked transport against a fake MCP server, errors, close semantics,
 *     send-after-close, transport-close rejecting pending requests.
 *   - transport.ts (58-60): _markClosed / peer-close from the *unclosed* side.
 *   - config.ts (152-205): env expansion ${VAR}/${VAR:-default}, per-transport
 *     required-field validation, type-omitted default stdio, illegal config.
 *
 * Boundary: only core-local relative imports + node:. Stub transport/MCP server.
 */
import { test, expect, describe } from 'bun:test';
import {
  createLinkedTransportPair,
  type Transport,
  type TransportMessage,
} from '../src/capability/mcp/transport';
import { InProcessMCPClient } from '../src/capability/mcp/client';
import {
  parseMcpConfig,
  expandEnvVarsInString,
} from '../src/capability/mcp/config';

// ─── fake MCP server: drives the server end of a linked transport pair ────────
//
// Replies to JSON-RPC tools/list + tools/call. `respond` lets a test override
// per-request behavior (errors, malformed responses, swallowing the request).

interface JsonRpcReq {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

type ServerHandler = (req: JsonRpcReq, transport: Transport) => void;

function defaultHandler(req: JsonRpcReq, transport: Transport): void {
  if (req.method === 'tools/list') {
    void transport.send({
      jsonrpc: '2.0',
      id: req.id,
      result: { tools: [{ name: 'echo' }, { name: 'add' }] },
    });
    return;
  }
  if (req.method === 'tools/call') {
    void transport.send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [{ type: 'text', text: 'pong' }],
        _meta: { server: 'fake' },
      },
    });
    return;
  }
  void transport.send({
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32601, message: `method not found: ${req.method}` },
  });
}

/** Attach a server handler to one end of a transport; records seen requests. */
function attachServer(
  serverTransport: Transport,
  handler: ServerHandler = defaultHandler,
): { seen: JsonRpcReq[] } {
  const seen: JsonRpcReq[] = [];
  serverTransport.onmessage = (m: TransportMessage) => {
    const req = m as JsonRpcReq;
    seen.push(req);
    handler(req, serverTransport);
  };
  return { seen };
}

// ─── client.ts — InProcessMCPClient round-trip & errors ───────────────────────

describe('InProcessMCPClient round-trip', () => {
  test('listTools returns server tools (tools/list JSON-RPC round-trip)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const { seen } = attachServer(serverT);
    const client = new InProcessMCPClient('srv', clientT);

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'add']);
    expect(seen[0].method).toBe('tools/list');
    expect(client.serverName).toBe('srv');
  });

  test('listTools tolerates a result without a tools array → []', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT, (req, t) => {
      void t.send({ jsonrpc: '2.0', id: req.id, result: {} });
    });
    const client = new InProcessMCPClient('srv', clientT);
    expect(await client.listTools()).toEqual([]);
  });

  test('callTool forwards name + arguments and returns result', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const { seen } = attachServer(serverT);
    const client = new InProcessMCPClient('srv', clientT);

    const res = await client.callTool('echo', { msg: 'hi' });
    expect(res.content).toEqual([{ type: 'text', text: 'pong' }]);
    const callReq = seen.find((r) => r.method === 'tools/call')!;
    expect(callReq.params).toEqual({ name: 'echo', arguments: { msg: 'hi' } });
  });

  test('callTool attaches opts.meta as _meta in params', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    const { seen } = attachServer(serverT);
    const client = new InProcessMCPClient('srv', clientT);

    await client.callTool('echo', { a: 1 }, { meta: { 'bc/toolUseId': 'tu-7' } });
    const callReq = seen.find((r) => r.method === 'tools/call')!;
    expect(callReq.params).toEqual({
      name: 'echo',
      arguments: { a: 1 },
      _meta: { 'bc/toolUseId': 'tu-7' },
    });
  });

  test('concurrent requests resolve by matching id (independent pending)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    // Server replies to tools/call with the id echoed so we can verify routing.
    attachServer(serverT, (req, t) => {
      void t.send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: `id=${req.id}` },
      });
    });
    const client = new InProcessMCPClient('srv', clientT);
    const [r1, r2] = await Promise.all([
      client.callTool('a', {}),
      client.callTool('b', {}),
    ]);
    // Two distinct ids → two distinct results, neither dropped.
    expect(r1.content).not.toEqual(r2.content);
    expect([r1.content, r2.content].sort()).toEqual(['id=1', 'id=2']);
  });

  test('JSON-RPC error response rejects callTool with the error message', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT, (req, t) => {
      void t.send({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32000, message: 'tool blew up' },
      });
    });
    const client = new InProcessMCPClient('srv', clientT);
    await expect(client.callTool('boom', {})).rejects.toThrow('tool blew up');
  });

  test('non-response messages (notifications) are ignored, leaving request pending', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    // First emit a notification (no id), then never answer → request stays pending.
    attachServer(serverT, () => {
      void serverT.send({ jsonrpc: '2.0', method: 'notifications/progress' });
    });
    const client = new InProcessMCPClient('srv', clientT);
    let settled = false;
    const p = client.listTools().then(() => {
      settled = true;
    });
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    expect(settled).toBe(false); // notification didn't resolve it
    // close to release the dangling promise so the test doesn't leak.
    await client.close();
    await expect(p).rejects.toThrow('MCP transport closed');
  });

  test('response with unknown id is ignored (no pending entry)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT, (req, t) => {
      // reply with a bogus id 999 first, then the correct one.
      void t.send({ jsonrpc: '2.0', id: 999, result: { tools: [] } });
      void t.send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'ok' }] } });
    });
    const client = new InProcessMCPClient('srv', clientT);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['ok']);
  });
});

describe('InProcessMCPClient close / failure semantics', () => {
  test('transport onclose rejects all pending requests', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    // Server never replies → request stays pending until close.
    attachServer(serverT, () => {});
    const client = new InProcessMCPClient('srv', clientT);

    const pending = client.listTools();
    await client.close(); // closes clientT → triggers onclose → reject pending
    await expect(pending).rejects.toThrow('MCP transport closed');
  });

  test('request after close rejects synchronously (closed guard)', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT);
    const client = new InProcessMCPClient('srv', clientT);
    await client.close();
    await expect(client.listTools()).rejects.toThrow('MCP transport closed');
    await expect(client.callTool('x', {})).rejects.toThrow('MCP transport closed');
  });

  test('close is idempotent', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT);
    const client = new InProcessMCPClient('srv', clientT);
    await client.close();
    await client.close(); // second close is a no-op, must not throw
    expect(true).toBe(true);
  });

  test('client closed by the *server* side: peer close marks client closed → request rejects', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    attachServer(serverT);
    const client = new InProcessMCPClient('srv', clientT);

    // server closes its end → bidirectional onclose flips client.closed.
    await serverT.close();
    await expect(client.listTools()).rejects.toThrow('MCP transport closed');
  });

  test('send() failure inside request rejects and cleans up pending', async () => {
    // Custom transport whose send always rejects (covers request() catch path).
    const failing: Transport = {
      async send() {
        throw new Error('send failed');
      },
      async close() {},
    };
    const client = new InProcessMCPClient('srv', failing);
    await expect(client.callTool('x', {})).rejects.toThrow('send failed');
  });

  test('send() rejecting with a non-Error is wrapped into an Error', async () => {
    const failing: Transport = {
      async send() {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string failure';
      },
      async close() {},
    };
    const client = new InProcessMCPClient('srv', failing);
    await expect(client.listTools()).rejects.toThrow('string failure');
  });
});

// ─── transport.ts — peer close from the unclosed side (lines 56-60) ───────────

describe('linked transport peer close (server-initiated)', () => {
  test('closing the server end triggers client onclose AND blocks client send', async () => {
    const [clientT, serverT] = createLinkedTransportPair();
    let clientClosed = 0;
    let serverClosed = 0;
    clientT.onclose = () => clientClosed++;
    serverT.onclose = () => serverClosed++;

    await serverT.close();
    expect(serverClosed).toBe(1);
    expect(clientClosed).toBe(1); // _markClosed + onclose on the peer

    // peer was _markClosed → its send now throws (covers closed guard via peer).
    await expect(clientT.send('x')).rejects.toThrow('Transport is closed');

    // re-closing the already-marked client end is idempotent (no extra onclose).
    await clientT.close();
    expect(clientClosed).toBe(1);
  });
});

// ─── config.ts — env expansion ────────────────────────────────────────────────

describe('expandEnvVarsInString', () => {
  test('expands ${VAR} when present', () => {
    const r = expandEnvVarsInString('Bearer ${TOKEN}', { TOKEN: 'abc' });
    expect(r.expanded).toBe('Bearer abc');
    expect(r.missingVars).toEqual([]);
  });

  test('uses :-default when var missing', () => {
    const r = expandEnvVarsInString('${HOST:-localhost}', {});
    expect(r.expanded).toBe('localhost');
    expect(r.missingVars).toEqual([]);
  });

  test('present var wins over its :-default', () => {
    const r = expandEnvVarsInString('${HOST:-localhost}', { HOST: 'example.com' });
    expect(r.expanded).toBe('example.com');
  });

  test('missing var with no default is left verbatim and recorded', () => {
    const r = expandEnvVarsInString('x=${MISSING}', {});
    expect(r.expanded).toBe('x=${MISSING}');
    expect(r.missingVars).toEqual(['MISSING']);
  });

  test('multiple vars in one string', () => {
    const r = expandEnvVarsInString('${A}/${B:-bb}/${C}', { A: 'aa' });
    expect(r.expanded).toBe('aa/bb/${C}');
    expect(r.missingVars).toEqual(['C']);
  });

  test('empty-string default is honored', () => {
    const r = expandEnvVarsInString('p=${X:-}', {});
    expect(r.expanded).toBe('p=');
    expect(r.missingVars).toEqual([]);
  });
});

// ─── config.ts — parseMcpConfig per-transport validation + defaults ───────────

describe('parseMcpConfig — stdio', () => {
  test('type omitted defaults to stdio (back-compat) and expands env in command/args/env', () => {
    const { servers, errors } = parseMcpConfig(
      {
        mcpServers: {
          local: {
            command: '${BIN}',
            args: ['--port', '${PORT:-8080}'],
            env: { KEY: '${SECRET}' },
          },
        },
      },
      { env: { BIN: '/usr/bin/node', SECRET: 's3cr3t' } },
    );
    expect(errors).toEqual([]);
    expect(servers).toHaveLength(1);
    const cfg = servers[0].config as {
      type: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(cfg.type).toBe('stdio');
    expect(cfg.command).toBe('/usr/bin/node');
    expect(cfg.args).toEqual(['--port', '8080']); // default applied
    expect(cfg.env).toEqual({ KEY: 's3cr3t' });
  });

  test('stdio without env injection leaves ${VAR} verbatim and defaults args to []', () => {
    const { servers } = parseMcpConfig({
      mcpServers: { local: { type: 'stdio', command: 'run-${X}' } },
    });
    const cfg = servers[0].config as { command: string; args: string[] };
    expect(cfg.command).toBe('run-${X}'); // no env → no expansion
    expect(cfg.args).toEqual([]);
  });

  test('stdio missing/empty command → error', () => {
    const a = parseMcpConfig({ mcpServers: { x: { type: 'stdio' } } });
    expect(a.servers).toEqual([]);
    expect(a.errors[0]).toContain('requires non-empty "command"');

    const b = parseMcpConfig({ mcpServers: { x: { command: '' } } });
    expect(b.errors[0]).toContain('requires non-empty "command"');
  });

  test('stdio non-string-array args → error', () => {
    const { errors } = parseMcpConfig({
      mcpServers: { x: { command: 'c', args: ['ok', 3] } },
    });
    expect(errors[0]).toContain('"args" must be a string array');
  });

  test('stdio non-string-record env → error', () => {
    const { errors } = parseMcpConfig({
      mcpServers: { x: { command: 'c', env: { A: 1 } } },
    });
    expect(errors[0]).toContain('"env" must be a string→string record');
  });
});

describe('parseMcpConfig — http / sse', () => {
  test('http expands url + headers', () => {
    const { servers, errors } = parseMcpConfig(
      {
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://${HOST}/mcp',
            headers: { Authorization: 'Bearer ${TOKEN}' },
          },
        },
      },
      { env: { HOST: 'api.test', TOKEN: 'tok' } },
    );
    expect(errors).toEqual([]);
    const cfg = servers[0].config as { type: string; url: string; headers: Record<string, string> };
    expect(cfg.type).toBe('http');
    expect(cfg.url).toBe('https://api.test/mcp');
    expect(cfg.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  test('sse without headers omits the headers field', () => {
    const { servers } = parseMcpConfig({
      mcpServers: { s: { type: 'sse', url: 'https://x/y' } },
    });
    const cfg = servers[0].config as { type: string; headers?: unknown };
    expect(cfg.type).toBe('sse');
    expect('headers' in cfg).toBe(false);
  });

  test('http/sse missing url → error', () => {
    const h = parseMcpConfig({ mcpServers: { x: { type: 'http' } } });
    expect(h.errors[0]).toContain('http config requires non-empty "url"');
    const s = parseMcpConfig({ mcpServers: { x: { type: 'sse', url: '' } } });
    expect(s.errors[0]).toContain('sse config requires non-empty "url"');
  });

  test('http non-string-record headers → error', () => {
    const { errors } = parseMcpConfig({
      mcpServers: { x: { type: 'http', url: 'https://x', headers: { a: 5 } } },
    });
    expect(errors[0]).toContain('"headers" must be a string→string record');
  });
});

describe('parseMcpConfig — ws / sdk', () => {
  test('ws expands url', () => {
    const { servers } = parseMcpConfig(
      { mcpServers: { w: { type: 'ws', url: 'ws://${HOST}:9' } } },
      { env: { HOST: 'h' } },
    );
    expect(servers[0].config).toEqual({ type: 'ws', url: 'ws://h:9' });
  });

  test('ws missing url → error', () => {
    const { errors } = parseMcpConfig({ mcpServers: { w: { type: 'ws' } } });
    expect(errors[0]).toContain('ws config requires non-empty "url"');
  });

  test('sdk requires non-empty name (name is NOT env-expanded)', () => {
    const ok = parseMcpConfig(
      { mcpServers: { k: { type: 'sdk', name: '${NAME}' } } },
      { env: { NAME: 'expanded' } },
    );
    // sdk.name is taken verbatim per impl (raw.name), not expanded.
    expect(ok.servers[0].config).toEqual({ type: 'sdk', name: '${NAME}' });

    const bad = parseMcpConfig({ mcpServers: { k: { type: 'sdk' } } });
    expect(bad.errors[0]).toContain('sdk config requires non-empty "name"');
  });
});

describe('parseMcpConfig — top-level + illegal config', () => {
  test('JSON string input is parsed', () => {
    const raw = JSON.stringify({ mcpServers: { x: { command: 'c' } } });
    const { servers, errors } = parseMcpConfig(raw);
    expect(errors).toEqual([]);
    expect(servers[0].name).toBe('x');
  });

  test('invalid JSON string → single invalid-JSON error', () => {
    const { servers, errors } = parseMcpConfig('{ not json');
    expect(servers).toEqual([]);
    expect(errors[0]).toContain('invalid JSON');
  });

  test('non-object root → error', () => {
    expect(parseMcpConfig(42).errors).toEqual(['config root must be an object']);
    expect(parseMcpConfig([]).errors).toEqual(['config root must be an object']);
  });

  test('missing/invalid mcpServers → error', () => {
    expect(parseMcpConfig({}).errors).toEqual(['missing or invalid "mcpServers" object']);
    expect(parseMcpConfig({ mcpServers: [] }).errors).toEqual([
      'missing or invalid "mcpServers" object',
    ]);
  });

  test('non-object server entry → per-server error', () => {
    const { errors } = parseMcpConfig({ mcpServers: { x: 'nope' } });
    expect(errors[0]).toContain('config must be an object');
  });

  test('unknown type → per-server error', () => {
    const { errors } = parseMcpConfig({ mcpServers: { x: { type: 'grpc', url: 'u' } } });
    expect(errors[0]).toContain('unknown type "grpc"');
  });

  test('fail-soft: one bad server does not block the others', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: {
        good: { command: 'ok' },
        bad: { type: 'http' }, // missing url
      },
    });
    expect(servers.map((s) => s.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bad');
  });
});
