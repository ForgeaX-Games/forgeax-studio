import { afterEach, describe, expect, test } from 'bun:test';
import { startHttpMcpServer, type RunningHttpMcpServer } from '../src/mcp/http';
import type { McpServerSpec } from '../src/mcp/protocol';

const running: RunningHttpMcpServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

function spec(): McpServerSpec<{ value: string }> {
  return {
    serverInfo: { name: 'test-mcp', version: '1.0.0' },
    buildContext: () => ({ value: 'fresh' }),
    resources: [],
    tools: [{
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      run: (args, ctx) => ({ ...args, context: ctx.value }),
    }],
  };
}

async function post(url: string, body: unknown, token?: string, origin?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('Streamable HTTP MCP transport', () => {
  test('serves initialize and tool calls without changing the stdio dispatcher', async () => {
    const server = await startHttpMcpServer(spec(), { host: '127.0.0.1', port: 0 });
    running.push(server);

    const initialized = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('mcp-protocol-version')).toBe('2024-11-05');
    expect((await initialized.json() as any).result.serverInfo.name).toBe('test-mcp');

    const called = await post(server.url, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ok' } },
    });
    const payload = await called.json() as any;
    expect(payload.result.content[0].text).toContain('"context":"fresh"');
  });

  test('enforces bearer auth and rejects browser origins unless explicitly allowed', async () => {
    const server = await startHttpMcpServer(spec(), {
      host: '127.0.0.1', port: 0, authToken: 'secret', requireAuth: true,
      allowedOrigins: ['https://allowed.example'],
    });
    running.push(server);
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

    expect((await post(server.url, message)).status).toBe(401);
    expect((await post(server.url, message, 'wrong')).status).toBe(401);
    expect((await post(server.url, message, 'secret', 'https://blocked.example')).status).toBe(403);
    expect((await post(server.url, message, 'secret', 'https://allowed.example')).status).toBe(200);
  });

  test('refuses a non-loopback listener without authentication', async () => {
    await expect(startHttpMcpServer(spec(), { host: '0.0.0.0', port: 0 })).rejects.toThrow(
      'authentication token is required',
    );
  });
});
