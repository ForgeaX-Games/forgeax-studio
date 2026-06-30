/**
 * MCP 兼容性测试 (C2 / MCP bridge).
 *
 * 覆盖:
 *  ① parseMcpConfig 解析一份真实 `.mcp.json`（stdio 省略 type + sse + http），
 *     断言 servers 正确 + 必填校验报错 + `${VAR}` 展开。
 *  ② FetchMCPClient（resolveMcpClient http）用假 fetch 跑 tools/list + tools/call
 *     往返（含 SSE Content-Type 帧解析）。
 *  ③ stdio 经假 stdioFactory 解析出 client。
 *  ④ 解析出的 config → resolveMcpClient → getMcpTools 映射出 `mcp__name__tool`。
 */
import { test, expect, describe } from 'bun:test';
import {
  parseMcpConfig,
  expandEnvVarsInString,
  type McpServerConfig,
} from '../src/capability/mcp/config';
import { resolveMcpClient } from '../src/capability/mcp/connect';
import { getMcpTools } from '../src/capability/mcp/bridge';
import type {
  MCPClient,
  MCPTool,
  MCPToolResult,
  MCPCallOptions,
} from '../src/capability/mcp/client';

// ─── ① parseMcpConfig ──────────────────────────────────────────────────────────

describe('parseMcpConfig (.mcp.json compat)', () => {
  // 一份真实形状的 .mcp.json：stdio 省略 type、sse、http 三种。
  const realConfig = JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { FOO: 'bar' },
      },
      linear: {
        type: 'sse',
        url: 'https://mcp.linear.app/sse',
        headers: { Authorization: 'Bearer xyz' },
      },
      sentry: {
        type: 'http',
        url: 'https://mcp.sentry.dev/mcp',
      },
    },
  });

  test('parses all three server kinds with stdio type defaulted', () => {
    const { servers, errors } = parseMcpConfig(realConfig);
    expect(errors).toEqual([]);
    expect(servers.map((s) => s.name)).toEqual(['filesystem', 'linear', 'sentry']);

    const fs = servers[0].config as Extract<McpServerConfig, { command: string }>;
    expect(fs.type).toBe('stdio'); // 省略 type → 归一化为 stdio
    expect(fs.command).toBe('npx');
    expect(fs.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    expect(fs.env).toEqual({ FOO: 'bar' });

    const linear = servers[1].config;
    expect(linear).toEqual({
      type: 'sse',
      url: 'https://mcp.linear.app/sse',
      headers: { Authorization: 'Bearer xyz' },
    });

    const sentry = servers[2].config;
    expect(sentry).toEqual({ type: 'http', url: 'https://mcp.sentry.dev/mcp' });
  });

  test('accepts already-parsed object too', () => {
    const { servers, errors } = parseMcpConfig(JSON.parse(realConfig));
    expect(errors).toEqual([]);
    expect(servers).toHaveLength(3);
  });

  test('reports required-field errors fail-soft (bad one skipped, good ones kept)', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: {
        ok: { type: 'http', url: 'https://ok.example/mcp' },
        noCommand: { type: 'stdio', args: ['x'] }, // 缺 command
        noUrl: { type: 'sse' }, // 缺 url
        badType: { type: 'grpc', url: 'x' }, // 未知 type
      },
    });
    expect(servers.map((s) => s.name)).toEqual(['ok']);
    expect(errors).toHaveLength(3);
    expect(errors.some((e) => e.includes('noCommand') && e.includes('command'))).toBe(true);
    expect(errors.some((e) => e.includes('noUrl') && e.includes('url'))).toBe(true);
    expect(errors.some((e) => e.includes('badType') && e.includes('unknown type'))).toBe(true);
  });

  test('invalid JSON / missing mcpServers reported, not thrown', () => {
    expect(parseMcpConfig('{not json').errors[0]).toContain('invalid JSON');
    expect(parseMcpConfig({}).errors[0]).toContain('mcpServers');
  });

  test('${VAR} expansion when env injected (and default fallback)', () => {
    const { servers, errors } = parseMcpConfig(
      {
        mcpServers: {
          api: {
            type: 'http',
            url: 'https://${HOST}/mcp',
            headers: { Authorization: 'Bearer ${TOKEN:-anon}' },
          },
        },
      },
      { env: { HOST: 'api.example.com' } },
    );
    expect(errors).toEqual([]);
    const cfg = servers[0].config as Extract<McpServerConfig, { type: 'http' }>;
    expect(cfg.url).toBe('https://api.example.com/mcp');
    expect(cfg.headers).toEqual({ Authorization: 'Bearer anon' }); // default 生效
  });

  test('no env injected → ${VAR} left verbatim', () => {
    const { servers } = parseMcpConfig({
      mcpServers: { x: { type: 'ws', url: 'wss://${HOST}/x' } },
    });
    expect((servers[0].config as { url: string }).url).toBe('wss://${HOST}/x');
  });

  test('expandEnvVarsInString tracks missing vars', () => {
    const r = expandEnvVarsInString('${A}-${B:-d}-${C}', { A: '1' });
    expect(r.expanded).toBe('1-d-${C}');
    expect(r.missingVars).toEqual(['C']);
  });
});

// ─── ② http client via fake fetch ──────────────────────────────────────────────

describe('resolveMcpClient http (native fetch JSON-RPC)', () => {
  /** 假 fetch：按 method 脚本化回 tools/list + tools/call。记录所有 POST body。 */
  function makeFakeFetch(opts: { sse?: boolean } = {}) {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
      calls.push({
        url: String(url),
        body,
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      let result: unknown;
      if (body.method === 'tools/list') {
        result = { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }] };
      } else if (body.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'pong' }] };
      } else {
        result = {};
      }
      const rpc = { jsonrpc: '2.0', id: body.id, result };
      const bodyText = opts.sse
        ? `event: message\ndata: ${JSON.stringify(rpc)}\n\n`
        : JSON.stringify(rpc);
      return new Response(bodyText, {
        status: 200,
        headers: {
          'content-type': opts.sse ? 'text/event-stream' : 'application/json',
        },
      });
    }) as unknown as typeof fetch;
    return { fakeFetch, calls };
  }

  test('tools/list + tools/call round-trip over JSON body', async () => {
    const { fakeFetch, calls } = makeFakeFetch();
    const client = await resolveMcpClient(
      'remote',
      { type: 'http', url: 'https://h/mcp', headers: { 'x-key': 'k' } },
      { fetch: fakeFetch },
    );

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);

    const result = await client.callTool('echo', { msg: 'ping' });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);

    // 校验 wire：POST + JSON-RPC envelope + 注入 headers + arguments 形状。
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({ jsonrpc: '2.0', method: 'tools/list' });
    expect(calls[0].headers['x-key']).toBe('k');
    expect(calls[1].body).toMatchObject({
      method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'ping' } },
    });
  });

  test('parses SSE (text/event-stream) response frames', async () => {
    const { fakeFetch } = makeFakeFetch({ sse: true });
    const client = await resolveMcpClient(
      'sse-srv',
      { type: 'sse', url: 'https://h/sse' },
      { fetch: fakeFetch },
    );
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    const r = await client.callTool('echo', {});
    expect(r.content).toEqual([{ type: 'text', text: 'pong' }]);
  });

  test('non-2xx HTTP surfaces as error', async () => {
    const fail = (async () =>
      new Response('nope', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;
    const client = await resolveMcpClient(
      'bad',
      { type: 'http', url: 'https://h/mcp' },
      { fetch: fail },
    );
    await expect(client.listTools()).rejects.toThrow('HTTP 500');
  });
});

// ─── ③ stdio via injected factory ──────────────────────────────────────────────

describe('resolveMcpClient stdio (injected factory)', () => {
  class StubStdioClient implements MCPClient {
    readonly serverName: string;
    constructor(name: string) {
      this.serverName = name;
    }
    async listTools(): Promise<MCPTool[]> {
      return [{ name: 'run' }];
    }
    async callTool(): Promise<MCPToolResult> {
      return { content: 'done' };
    }
  }

  test('stdio (type omitted) resolves via stdioFactory', async () => {
    let seen: { name: string; command: string } | undefined;
    const { servers } = parseMcpConfig({
      mcpServers: { local: { command: 'mybin', args: ['--serve'] } },
    });
    const client = await resolveMcpClient('local', servers[0].config, {
      stdioFactory: (name, cfg) => {
        seen = { name, command: cfg.command };
        return new StubStdioClient(name);
      },
    });
    expect(seen).toEqual({ name: 'local', command: 'mybin' });
    expect(client.serverName).toBe('local');
    expect((await client.listTools()).map((t) => t.name)).toEqual(['run']);
  });

  test('stdio without factory throws (core does not spawn)', async () => {
    await expect(
      resolveMcpClient('local', { type: 'stdio', command: 'x', args: [] }, {}),
    ).rejects.toThrow('stdioFactory');
  });
});

// ─── ④ config → resolve → getMcpTools → mcp__name__tool ─────────────────────────

describe('end-to-end: parsed config → getMcpTools maps mcp__name__tool', () => {
  /** 假 fetch 回带 readOnlyHint 的两个工具。 */
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result =
      body.method === 'tools/list'
        ? {
            tools: [
              { name: 'get_issue', annotations: { readOnlyHint: true } },
              { name: 'create_issue' },
            ],
          }
        : { content: 'ok' };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  test('full chain yields fully-qualified tool names + predicates', async () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
    });
    expect(errors).toEqual([]);

    const { name, config } = servers[0];
    const client = await resolveMcpClient(name, config, { fetch: fakeFetch });
    const tools = await getMcpTools(client, name);

    expect(tools.map((t) => t.name)).toEqual([
      'mcp__linear__get_issue',
      'mcp__linear__create_issue',
    ]);
    expect(tools[0].isReadOnly({})).toBe(true);
    expect(tools[1].isReadOnly({})).toBe(false);
    expect(tools[0].isMcp).toBe(true);
    expect(tools[0].mcpInfo).toEqual({ serverName: 'linear', toolName: 'get_issue' });
  });
});

// 触及未使用的 import 以满足 strict（McpCallOptions 仅类型）。
export type _UsedTypes = MCPCallOptions;
