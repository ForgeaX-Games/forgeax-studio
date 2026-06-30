/**
 * 024 A 层:getStatus 聚合 + runDoctor 探测。
 *
 *   getStatus —— 纯聚合:各来源齐全 → 折成快照;缺省优雅;MCP 连接数正确计数;
 *                Usage 套 015 summarizeUsage(已知模型 → 估费 >0)。
 *   runDoctor —— 探测:假 provider 产事件 → ✅;抛 401 → ❌ 且提示查 key;
 *                MCP 经假 fetch 巡检 → connected/failed 各折一项;LSP probe 缺命令 → ⚠️;
 *                各组未注入 → 跳过(不产 check);有 fail → healthy=false。
 *
 * Boundary: test 层,假 provider / 假 fetch / 假 probe,只 import core-local。
 */
import { test, expect, describe } from 'bun:test';
import { getStatus } from '../src/cli/status-aggregate';
import { runDoctor } from '../src/cli/doctor';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import { DEFAULT_SERVERS } from '../src/capability/lsp/servers';

// ─── getStatus ─────────────────────────────────────────────────────────────────

describe('getStatus 聚合', () => {
  test('来源齐全 → 折成快照 + MCP 计数 + Usage 估费', () => {
    const usage: Usage = { ...EMPTY_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const snap = getStatus({
      model: 'claude-opus-4-8',
      cwd: '/work',
      sessionId: 'sess-1',
      permissionMode: 'acceptEdits',
      mcpServers: [
        { name: 'a', status: 'connected', toolCount: 3 },
        { name: 'b', status: 'failed' },
        { name: 'c', status: 'auth-pending' },
      ],
      usage,
      turns: 7,
    });
    expect(snap.model).toBe('claude-opus-4-8');
    expect(snap.cwd).toBe('/work');
    expect(snap.sessionId).toBe('sess-1');
    expect(snap.persistent).toBe(true);
    expect(snap.permissionMode).toBe('acceptEdits');
    expect(snap.mcp).toEqual({ total: 3, connected: 1, failed: 1, authPending: 1 });
    expect(snap.turns).toBe(7);
    // claude-opus 单价已知 → input 15 + output 75 /1M × 1M each = 90 USD。
    expect(snap.usage.pricingKnown).toBe(true);
    expect(snap.usage.cost.totalUsd).toBeCloseTo(90, 5);
  });

  test('空入参 → 缺省优雅(default 模式 / 临时会话 / 零 MCP / 零 usage)', () => {
    const snap = getStatus();
    expect(snap.model).toBeUndefined();
    expect(snap.persistent).toBe(false);
    expect(snap.permissionMode).toBe('default');
    expect(snap.mcp).toEqual({ total: 0, connected: 0, failed: 0, authPending: 0 });
    expect(snap.usage.totalTokens).toBe(0);
    expect(snap.turns).toBe(0);
  });
});

// ─── runDoctor ─────────────────────────────────────────────────────────────────

/** 假 provider:产一个 assistant 事件即连通。 */
function okProvider(): LLMProvider {
  return {
    api: 'fake',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'message_start', usage: {} };
    },
  };
}

/** 假 provider:stream 抛 401。 */
function authFailProvider(): LLMProvider {
  return {
    api: 'fake',
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      throw new Error('request failed HTTP 401 Unauthorized');
    },
  };
}

/** 假 fetch:对 jsonrpc tools/list 返回给定工具数;url 命中 'bad' 则抛网络错。 */
function mcpFetch(toolCount: number): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).includes('bad')) throw new Error('fetch failed ENOTFOUND');
    const body = JSON.parse(String(init?.body)) as { id: number };
    const tools = Array.from({ length: toolCount }, (_, i) => ({ name: `t${i}` }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('runDoctor 探测', () => {
  test('provider 连通 → ✅', async () => {
    const r = await runDoctor({ provider: { provider: okProvider(), model: 'claude-opus-4-8' } });
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]!.status).toBe('ok');
    expect(r.checks[0]!.category).toBe('provider');
    expect(r.healthy).toBe(true);
  });

  test('provider 401 → ❌ + 提示查 key + healthy=false', async () => {
    const r = await runDoctor({ provider: { provider: authFailProvider(), model: 'claude-opus-4-8' } });
    expect(r.checks[0]!.status).toBe('fail');
    expect(r.checks[0]!.detail).toContain('ANTHROPIC_API_KEY');
    expect(r.healthy).toBe(false);
  });

  test('MCP 巡检 → connected ✅ / failed ❌ 各折一项', async () => {
    const r = await runDoctor({
      mcp: {
        config: {
          mcpServers: {
            good: { type: 'http', url: 'https://good/mcp' },
            broken: { type: 'http', url: 'https://bad/mcp' },
          },
        },
        deps: { fetch: mcpFetch(2) },
      },
    });
    const good = r.checks.find((c) => c.id === 'mcp:good');
    const broken = r.checks.find((c) => c.id === 'mcp:broken');
    expect(good?.status).toBe('ok');
    expect(good?.detail).toContain('2 个工具');
    expect(broken?.status).toBe('fail');
    expect(r.healthy).toBe(false);
  });

  test('LSP probe 缺命令 → ⚠️(warn,不算 fail)', async () => {
    const r = await runDoctor({
      lsp: { servers: Object.values(DEFAULT_SERVERS), probeCommand: () => false },
    });
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.every((c) => c.category === 'lsp')).toBe(true);
    expect(r.checks.every((c) => c.status === 'warn')).toBe(true);
    // command 去重:DEFAULT_SERVERS 全是 typescript-language-server → 只 1 项。
    expect(r.checks).toHaveLength(1);
    expect(r.healthy).toBe(true);
  });

  test('各组未注入 → 跳过(无 check),healthy=true', async () => {
    const r = await runDoctor();
    expect(r.checks).toEqual([]);
    expect(r.healthy).toBe(true);
  });
});
