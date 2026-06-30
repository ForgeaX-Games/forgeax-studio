/**
 * MCP auth (M3) — bearer header 注入 + OAuth 401 刷新接缝。
 *
 * 覆盖（全用假 fetch，no-op sleep，零真实等待）：
 *   (a) cfg.token → Authorization: Bearer <token> 注入到 POST headers；
 *   (b) cfg 无 token 但有 tokenProvider → 从回调拿 bearer；
 *   (c) 首发 401 → tokenProvider({refresh:true}) 刷新 → 同请求重试一次成功，
 *       且第二次请求带的是**新** token；
 *   (d) 持续 401 → 刷新一次后仍 401 → 抛（不无限刷）；
 *   (e) 无 auth 路径完全不变（无 Authorization header，行为同旧）。
 *   外加 resolveAuthHeaders / discoverOAuth 纯函数单测。
 *
 * Boundary: only core-local relative imports + node:. 假 fetch / no-op sleep。
 */
import { test, expect, describe } from 'bun:test';
import { FetchMCPClient } from '../src/capability/mcp/connect';
import {
  resolveAuthHeaders,
  discoverOAuth,
  type TokenProvider,
} from '../src/capability/mcp/auth';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** no-op sleep：测试零等待。 */
const noSleep = async (_ms: number): Promise<void> => {};

/** 取出某次请求所带的 Authorization header（大小写 / 来源对象都兜住）。 */
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

function unauthorized(): Response {
  return new Response('unauthorized', { status: 401, statusText: 'Unauthorized' });
}

// ─── (a) bearer from cfg.token ─────────────────────────────────────────────────

describe('FetchMCPClient bearer auth', () => {
  test('(a) injects Authorization: Bearer from cfg.token', async () => {
    const seen: (string | undefined)[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(authOf(init));
      const body = JSON.parse(String(init?.body)) as { id: number };
      return ok(body.id, { tools: [{ name: 'x' }] });
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient(
      'srv',
      'https://h/mcp',
      undefined,
      fakeFetch,
      { sleep: noSleep },
      { auth: { type: 'bearer', token: 'tok-cfg' } },
    );
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['x']);
    expect(seen).toEqual(['Bearer tok-cfg']);
  });

  test('(b) bearer from tokenProvider when cfg has no token', async () => {
    const seen: (string | undefined)[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(authOf(init));
      const body = JSON.parse(String(init?.body)) as { id: number };
      return ok(body.id, { tools: [] });
    }) as unknown as typeof fetch;

    const calls: { server: string; refresh?: boolean }[] = [];
    const tokenProvider: TokenProvider = (server, opts) => {
      calls.push({ server, refresh: opts?.refresh });
      return 'tok-provider';
    };

    const client = new FetchMCPClient(
      'remote',
      'https://h/mcp',
      undefined,
      fakeFetch,
      { sleep: noSleep },
      { tokenProvider },
    );
    await client.listTools();
    expect(seen).toEqual(['Bearer tok-provider']);
    // 回调拿到正确的 server 名，首发不带 refresh。
    expect(calls[0]).toEqual({ server: 'remote', refresh: undefined });
  });
});

// ─── (c)(d) 401 refresh seam ───────────────────────────────────────────────────

describe('FetchMCPClient 401 refresh', () => {
  test('(c) 401 → refresh token → retry once succeeds with the new token', async () => {
    const seenAuth: (string | undefined)[] = [];
    let n = 0;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seenAuth.push(authOf(init));
      n++;
      if (n === 1) return unauthorized(); // 旧 token 被拒
      const body = JSON.parse(String(init?.body)) as { id: number };
      return ok(body.id, { tools: [{ name: 'after-refresh' }] });
    }) as unknown as typeof fetch;

    const refreshCalls: boolean[] = [];
    let issued = 0;
    const tokenProvider: TokenProvider = (_server, opts) => {
      if (opts?.refresh) {
        refreshCalls.push(true);
        return 'tok-new';
      }
      issued++;
      return 'tok-old';
    };

    const client = new FetchMCPClient(
      'srv',
      'https://h/mcp',
      undefined,
      fakeFetch,
      { sleep: noSleep },
      { tokenProvider },
    );
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['after-refresh']);
    // 恰好两次请求：旧 token → 401 → 新 token → 成功。
    expect(n).toBe(2);
    expect(seenAuth).toEqual(['Bearer tok-old', 'Bearer tok-new']);
    expect(refreshCalls).toEqual([true]); // refresh 恰好一次
  });

  test('(d) persistent 401 → throws after exactly one refresh', async () => {
    const seenAuth: (string | undefined)[] = [];
    let refreshCount = 0;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seenAuth.push(authOf(init));
      return unauthorized(); // 一直 401
    }) as unknown as typeof fetch;

    const tokenProvider: TokenProvider = (_server, opts) => {
      if (opts?.refresh) {
        refreshCount++;
        return `tok-${refreshCount}`;
      }
      return 'tok-old';
    };

    const client = new FetchMCPClient(
      'srv',
      'https://h/mcp',
      undefined,
      fakeFetch,
      { sleep: noSleep },
      { tokenProvider },
    );
    await expect(client.listTools()).rejects.toThrow('HTTP 401');
    // 仅刷新一次,因此恰好两次请求（旧 + 刷新后）。
    expect(refreshCount).toBe(1);
    expect(seenAuth).toEqual(['Bearer tok-old', 'Bearer tok-1']);
  });

  test('401 without tokenProvider throws immediately (no refresh path)', async () => {
    let n = 0;
    const fakeFetch = (async () => {
      n++;
      return unauthorized();
    }) as unknown as typeof fetch;

    const client = new FetchMCPClient(
      'srv',
      'https://h/mcp',
      undefined,
      fakeFetch,
      { sleep: noSleep },
      { auth: { type: 'bearer', token: 'tok' } },
    );
    await expect(client.listTools()).rejects.toThrow('HTTP 401');
    expect(n).toBe(1); // 无 provider → 不重试
  });
});

// ─── (e) no-auth path unchanged ────────────────────────────────────────────────

describe('FetchMCPClient no-auth path unchanged', () => {
  test('(e) no auth options → no Authorization header, normal flow', async () => {
    const seen: (string | undefined)[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(authOf(init));
      const body = JSON.parse(String(init?.body)) as { id: number };
      return ok(body.id, { tools: [{ name: 'plain' }] });
    }) as unknown as typeof fetch;

    // 旧式 5-arg 构造（无 auth bag）仍然有效。
    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch, {
      sleep: noSleep,
    });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['plain']);
    expect(seen).toEqual([undefined]); // 无 Authorization header
  });

  test('4-arg constructor (no retry, no auth) still compiles & runs', async () => {
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      return ok(body.id, { tools: [] });
    }) as unknown as typeof fetch;
    const client = new FetchMCPClient('srv', 'https://h/mcp', undefined, fakeFetch);
    await expect(client.listTools()).resolves.toEqual([]);
  });
});

// ─── resolveAuthHeaders pure fn ────────────────────────────────────────────────

describe('resolveAuthHeaders', () => {
  test('cfg.token → Bearer header', async () => {
    expect(await resolveAuthHeaders({ type: 'bearer', token: 't1' })).toEqual({
      Authorization: 'Bearer t1',
    });
  });

  test('no token + no provider → {}', async () => {
    expect(await resolveAuthHeaders(undefined)).toEqual({});
  });

  test('cfg without token → provider used (with server name)', async () => {
    let seenServer: string | undefined;
    const provider: TokenProvider = (server) => {
      seenServer = server;
      return 'fromProvider';
    };
    expect(await resolveAuthHeaders({ type: 'bearer' }, provider, 'srvA')).toEqual({
      Authorization: 'Bearer fromProvider',
    });
    expect(seenServer).toBe('srvA');
  });

  test('cfg.token wins over provider', async () => {
    const provider: TokenProvider = () => 'provider-token';
    expect(
      await resolveAuthHeaders({ type: 'bearer', token: 'cfg-token' }, provider, 's'),
    ).toEqual({ Authorization: 'Bearer cfg-token' });
  });

  test('provider returns undefined → {} (fail-open)', async () => {
    const provider: TokenProvider = () => undefined;
    expect(await resolveAuthHeaders(undefined, provider, 's')).toEqual({});
  });
});

// ─── discoverOAuth seam ────────────────────────────────────────────────────────

describe('discoverOAuth', () => {
  test('returns normalized discovery from oauth-authorization-server', async () => {
    const fakeFetch = (async (url: string) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.example',
            token_endpoint: 'https://auth.example/token',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    const d = await discoverOAuth('https://h/mcp', fakeFetch);
    expect(d?.authorizationServer).toBe('https://auth.example');
    expect(d?.tokenEndpoint).toBe('https://auth.example/token');
  });

  test('falls back to oauth-protected-resource', async () => {
    const fakeFetch = (async (url: string) => {
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(
          JSON.stringify({ authorizationServer: 'https://pr.example' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('x', { status: 500 });
    }) as unknown as typeof fetch;

    const d = await discoverOAuth('https://h/mcp', fakeFetch);
    expect(d?.authorizationServer).toBe('https://pr.example');
  });

  test('returns null on all-404 (fail-open)', async () => {
    const fakeFetch = (async () =>
      new Response('nf', { status: 404 })) as unknown as typeof fetch;
    expect(await discoverOAuth('https://h/mcp', fakeFetch)).toBeNull();
  });

  test('returns null on network error / bad JSON', async () => {
    const throwing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await discoverOAuth('https://h/mcp', throwing)).toBeNull();

    const badJson = (async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    expect(await discoverOAuth('https://h/mcp', badJson)).toBeNull();
  });

  test('returns null on invalid base URL', async () => {
    const fakeFetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof fetch;
    expect(await discoverOAuth('not a url', fakeFetch)).toBeNull();
  });
});
