/**
 * 016 — MCP 连接态巡检(inspectMcpServers)测试。
 *
 * 覆盖 `/mcp` 命令 A 层底层能力:
 *   (a) 连上的 server → status='connected' + 正确 toolCount。
 *   (b) 连不上的 server(stdioFactory 抛错)→ status='failed' + error。
 *   (c) 401 + 配了 auth → status='auth-pending';401 + 无 auth → 'failed'。
 *   (d) deferred 标记与生产装配同源(default=defer → async;auto + 工具少 → sync)。
 *   (e) 配置解析错误进 configErrors,坏一条不连累其它(fail-soft)。
 *
 * 全用注入接缝(fetch / stdioFactory),不触真网络 / 子进程。对齐 test/mcp*.test.ts 风格。
 */
import { test, expect, describe } from 'bun:test';
import { inspectMcpServers } from '../src/capability/mcp/inspect';
import type { MCPClient, MCPTool, MCPToolResult } from '../src/capability/mcp/client';

// ─── helpers ────────────────────────────────────────────────────────────────

/** 假 MCPClient —— listTools 返回脚本化工具;callTool 不在巡检里触发。 */
class FakeClient implements MCPClient {
  readonly serverName: string;
  constructor(
    serverName: string,
    private readonly tools: MCPTool[],
  ) {
    this.serverName = serverName;
  }
  listTools(): Promise<MCPTool[]> {
    return Promise.resolve(this.tools);
  }
  callTool(): Promise<MCPToolResult> {
    throw new Error('callTool not used in inspect');
  }
}

function mkTool(name: string): MCPTool {
  return { name, description: name, inputSchema: { type: 'object' } };
}

/** 一个总回 401 的假 fetch(http/sse 连接经它走 FetchMCPClient → initialize/list 抛 401)。 */
function fetch401(): typeof fetch {
  return (async () =>
    new Response('unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    })) as unknown as typeof fetch;
}

// ─── (a) 连上 ──────────────────────────────────────────────────────────────────

describe('inspectMcpServers — connected', () => {
  test('stdio server 连上 → connected + 正确 toolCount', async () => {
    const config = {
      mcpServers: {
        local: { command: 'echo', args: [] },
      },
    };
    const result = await inspectMcpServers({
      config,
      env: { FORGEAX_MCP_DEFER_DEFAULT: 'auto' }, // 工具少 → 不延迟,便于断 deferred=false
      deps: {
        stdioFactory: (name) =>
          new FakeClient(name, [mkTool('a'), mkTool('b'), mkTool('c')]),
      },
    });
    expect(result.configErrors).toEqual([]);
    expect(result.servers).toHaveLength(1);
    const s = result.servers[0];
    expect(s.name).toBe('local');
    expect(s.type).toBe('stdio');
    expect(s.status).toBe('connected');
    expect(s.toolCount).toBe(3);
    expect(s.deferred).toBe(false);
    expect(s.error).toBeUndefined();
  });
});

// ─── (b) 连不上 ────────────────────────────────────────────────────────────────

describe('inspectMcpServers — failed', () => {
  test('stdioFactory 抛错 → failed + error,toolCount=0', async () => {
    const config = { mcpServers: { broken: { command: 'nope', args: [] } } };
    const result = await inspectMcpServers({
      config,
      deps: {
        stdioFactory: () => {
          throw new Error('spawn nope ENOENT');
        },
      },
    });
    const s = result.servers[0];
    expect(s.status).toBe('failed');
    expect(s.toolCount).toBe(0);
    expect(s.error).toContain('ENOENT');
  });

  test('一连上 + 一连不上 → 各自状态独立(fail-soft)', async () => {
    const config = {
      mcpServers: {
        ok: { command: 'echo', args: [] },
        bad: { command: 'echo', args: [] },
      },
    };
    const result = await inspectMcpServers({
      config,
      deps: {
        stdioFactory: (name) => {
          if (name === 'bad') throw new Error('boom');
          return new FakeClient(name, [mkTool('x')]);
        },
      },
    });
    const ok = result.servers.find((s) => s.name === 'ok')!;
    const bad = result.servers.find((s) => s.name === 'bad')!;
    expect(ok.status).toBe('connected');
    expect(ok.toolCount).toBe(1);
    expect(bad.status).toBe('failed');
  });
});

// ─── (c) 认证待办 ──────────────────────────────────────────────────────────────

describe('inspectMcpServers — auth-pending', () => {
  test('http 401 + 配了 auth → auth-pending', async () => {
    const config = {
      mcpServers: {
        secured: {
          type: 'http',
          url: 'https://example.com/mcp',
          auth: { type: 'bearer' },
        },
      },
    };
    const result = await inspectMcpServers({
      config,
      deps: { fetch: fetch401() },
    });
    const s = result.servers[0];
    expect(s.type).toBe('http');
    expect(s.status).toBe('auth-pending');
    expect(s.error).toMatch(/401/i);
  });

  test('http 401 + 无 auth → failed(不当认证待办)', async () => {
    const config = {
      mcpServers: {
        open: { type: 'http', url: 'https://example.com/mcp' },
      },
    };
    const result = await inspectMcpServers({
      config,
      deps: { fetch: fetch401() },
    });
    expect(result.servers[0].status).toBe('failed');
  });
});

// ─── (d) deferred 标记 ─────────────────────────────────────────────────────────

describe('inspectMcpServers — deferred 裁决', () => {
  test('全局默认 defer → connected server deferred=true', async () => {
    const config = { mcpServers: { s1: { command: 'echo', args: [] } } };
    const result = await inspectMcpServers({
      config,
      // env 不传 FORGEAX_MCP_DEFER_DEFAULT → 默认 defer。
      deps: { stdioFactory: (name) => new FakeClient(name, [mkTool('a')]) },
    });
    expect(result.servers[0].deferred).toBe(true);
  });

  test('server 显式 defer_loading=false → deferred=false(覆盖全局 defer)', async () => {
    const config = {
      mcpServers: { s1: { command: 'echo', args: [], defer_loading: false } },
    };
    const result = await inspectMcpServers({
      config,
      deps: { stdioFactory: (name) => new FakeClient(name, [mkTool('a')]) },
    });
    expect(result.servers[0].deferred).toBe(false);
  });
});

// ─── (e) 配置解析错误 ──────────────────────────────────────────────────────────

describe('inspectMcpServers — config 解析 fail-soft', () => {
  test('坏一条 server → 进 configErrors,好的仍巡检', async () => {
    const config = {
      mcpServers: {
        good: { command: 'echo', args: [] },
        bad: { type: 'http' }, // 缺 url → 解析错
      },
    };
    const result = await inspectMcpServers({
      config,
      deps: { stdioFactory: (name) => new FakeClient(name, [mkTool('a')]) },
    });
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe('good');
    expect(result.configErrors.length).toBe(1);
    expect(result.configErrors[0]).toContain('bad');
  });

  test('整个 config 非法 → servers 空 + configErrors 非空', async () => {
    const result = await inspectMcpServers({ config: 'not json {' });
    expect(result.servers).toEqual([]);
    expect(result.configErrors.length).toBeGreaterThan(0);
  });
});
