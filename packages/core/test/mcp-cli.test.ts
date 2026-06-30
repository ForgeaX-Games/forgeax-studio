/**
 * WS-A — MCP CLI 接线:env-token 解析 + tokenEnv 兑现 + token provider refresh。
 *
 *   - "env var token"            → config auth.token='${TOK}' + env{TOK:'x'} → 假 fetch 见 Bearer x。
 *   - "tokenEnv"                 → config auth.tokenEnv='MY_TOK' + env{MY_TOK:'abc'} → 解析 token==='abc'
 *                                  + 假 fetch 见 Bearer abc;显式 token 胜过 tokenEnv。
 *   - "env token provider refresh" → makeEnvTokenProvider 返回 env token;改 env 后 {refresh:true} 返回新值。
 *
 * Boundary: test 层,假 fetch,只 import core-local。
 */
import { test, expect, describe } from 'bun:test';
import { parseMcpConfig } from '../src/capability/mcp/config';
import { resolveMcpClient } from '../src/capability/mcp/connect';
import { makeEnvTokenProvider } from '../src/cli/mcp-token';

/** 取出某次请求所带的 Authorization header。 */
function authOf(init: RequestInit | undefined): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return h.Authorization ?? h.authorization;
}

function ok(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MCP CLI env token wiring', () => {
  test('env var token (${VAR} expansion → Bearer)', async () => {
    const env = { TOK: 'x' };
    const { servers, errors } = parseMcpConfig(
      {
        mcpServers: {
          srv: { type: 'http', url: 'https://h/mcp', auth: { type: 'bearer', token: '${TOK}' } },
        },
      },
      { env },
    );
    expect(errors).toEqual([]);
    // ${TOK} 在 auth.token 里 → applyCommonFields 用注入的 env 展开成 'x'。
    const auth = (servers[0]!.config as { auth?: { token?: string } }).auth;
    expect(auth?.token).toBe('x');

    const seen: (string | undefined)[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(authOf(init));
      const body = JSON.parse(String(init?.body)) as { id: number };
      return ok(body.id, { tools: [] });
    }) as unknown as typeof fetch;

    const client = await resolveMcpClient(servers[0]!.name, servers[0]!.config, { fetch: fakeFetch });
    await (client as { listTools: () => Promise<unknown> }).listTools();
    expect(seen[0]).toBe('Bearer x');
  });

  test('tokenEnv resolves to token + Bearer; explicit token wins', async () => {
    const env = { MY_TOK: 'abc' };
    // (1) tokenEnv 解析。
    const { servers } = parseMcpConfig(
      {
        mcpServers: {
          srv: { type: 'http', url: 'https://h/mcp', auth: { type: 'bearer', tokenEnv: 'MY_TOK' } },
        },
      },
      { env },
    );
    const auth = (servers[0]!.config as { auth?: { token?: string } }).auth;
    expect(auth?.token).toBe('abc');

    // Bearer abc 实际发出。
    const seen: (string | undefined)[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(authOf(init));
      const body = JSON.parse(String(init?.body)) as { id: number };
      return ok(body.id, { tools: [] });
    }) as unknown as typeof fetch;
    const client = await resolveMcpClient(servers[0]!.name, servers[0]!.config, { fetch: fakeFetch });
    await (client as { listTools: () => Promise<unknown> }).listTools();
    expect(seen[0]).toBe('Bearer abc');

    // (2) 显式 token 胜过 tokenEnv。
    const { servers: s2 } = parseMcpConfig(
      {
        mcpServers: {
          srv: {
            type: 'http',
            url: 'https://h/mcp',
            auth: { type: 'bearer', token: 'explicit', tokenEnv: 'MY_TOK' },
          },
        },
      },
      { env },
    );
    const auth2 = (s2[0]!.config as { auth?: { token?: string } }).auth;
    expect(auth2?.token).toBe('explicit');
  });

  test('env token provider refresh re-reads process.env', () => {
    const KEY = 'FORGEAX_MCP_TOKEN_REFRESHSRV';
    delete process.env[KEY];
    const provider = makeEnvTokenProvider();
    process.env[KEY] = 'first';
    expect(provider('refreshsrv')).toBe('first');
    // 变更 env → refresh 重读拿到新值(lazy 读 process.env)。
    process.env[KEY] = 'second';
    const refreshed = provider('refreshsrv', { refresh: true });
    expect(refreshed).toBe('second');
    delete process.env[KEY];
  });

  test('env token provider: map > wildcard > convention > global', () => {
    const provider = makeEnvTokenProvider({ srvA: 'A_ENV', '*': 'WILD_ENV' });
    process.env.A_ENV = 'aval';
    process.env.WILD_ENV = 'wval';
    process.env.FORGEAX_MCP_TOKEN = 'gval';
    process.env.FORGEAX_MCP_TOKEN_SRVB = 'bval';
    try {
      expect(provider('srvA')).toBe('aval'); // 显式 map
      expect(provider('srvB')).toBe('wval'); // 无 map → wildcard 优先于约定名/global
      const provider2 = makeEnvTokenProvider();
      expect(provider2('srvB')).toBe('bval'); // 约定名
      expect(provider2('srvC')).toBe('gval'); // 全局兜底
    } finally {
      delete process.env.A_ENV;
      delete process.env.WILD_ENV;
      delete process.env.FORGEAX_MCP_TOKEN;
      delete process.env.FORGEAX_MCP_TOKEN_SRVB;
    }
  });
});
