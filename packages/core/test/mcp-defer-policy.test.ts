/**
 * M1 — MCP default-deferred policy 测试。
 *
 * 覆盖三块:
 *   (a) caps.decideMcpDeferMode 裁决规则 + env 读取（FORGEAX_MCP_SYNC_THRESHOLD /
 *       FORGEAX_MCP_DEFER_DEFAULT）。
 *   (b) bridge.mapMcpToolToAgentTool 按 deferMode 设/不设 shouldDefer（alwaysLoad 豁免）。
 *   (c) config.parseMcpConfig 对 defer_loading + auth 的 round-trip 与校验。
 */
import { test, expect, describe } from 'bun:test';
import {
  DEFAULT_MCP_SYNC_THRESHOLD,
  readMcpSyncThreshold,
  readMcpDeferDefault,
  decideMcpDeferMode,
} from '../src/capability/mcp/caps';
import { mapMcpToolToAgentTool } from '../src/capability/mcp/bridge';
import { parseMcpConfig } from '../src/capability/mcp/config';
import type { MCPClient, MCPTool } from '../src/capability/mcp/client';

// ─── 测试桩 ────────────────────────────────────────────────────────────────────

/** bridge 只用到 client 的类型，call/list 不在本测试触发 → 给最小桩。 */
const fakeClient = {} as unknown as MCPClient;

function mkTool(name: string, meta?: Record<string, unknown>): MCPTool {
  return { name, description: name, inputSchema: { type: 'object' }, _meta: meta };
}

// ─── (a) caps：env 读取 ─────────────────────────────────────────────────────────

describe('caps env 读取', () => {
  test('readMcpSyncThreshold：缺省/非法 → 20，有效数字 → 该值', () => {
    expect(readMcpSyncThreshold({})).toBe(DEFAULT_MCP_SYNC_THRESHOLD);
    expect(readMcpSyncThreshold()).toBe(20);
    expect(readMcpSyncThreshold({ FORGEAX_MCP_SYNC_THRESHOLD: 'abc' })).toBe(20);
    expect(readMcpSyncThreshold({ FORGEAX_MCP_SYNC_THRESHOLD: '0' })).toBe(20);
    expect(readMcpSyncThreshold({ FORGEAX_MCP_SYNC_THRESHOLD: '-3' })).toBe(20);
    expect(readMcpSyncThreshold({ FORGEAX_MCP_SYNC_THRESHOLD: '5' })).toBe(5);
  });

  test('readMcpDeferDefault：缺省/其它 → defer，显式 auto → auto', () => {
    expect(readMcpDeferDefault({})).toBe('defer');
    expect(readMcpDeferDefault()).toBe('defer');
    expect(readMcpDeferDefault({ FORGEAX_MCP_DEFER_DEFAULT: 'whatever' })).toBe('defer');
    expect(readMcpDeferDefault({ FORGEAX_MCP_DEFER_DEFAULT: 'auto' })).toBe('auto');
  });
});

// ─── (a) caps：decideMcpDeferMode 规则 ──────────────────────────────────────────

describe('decideMcpDeferMode', () => {
  test('defer_loading:false → sync；true → async', () => {
    const r = decideMcpDeferMode(
      { s1: { defer_loading: false }, s2: { defer_loading: true } },
      { s1: 100, s2: 1 },
    );
    expect(r.perServer.s1).toBe('sync');
    expect(r.perServer.s2).toBe('async');
    expect(r.anyAsync).toBe(true);
  });

  test('undefined 在默认 defer 下 → async（无视阈值）', () => {
    const r = decideMcpDeferMode(
      { s1: {}, s2: undefined },
      { s1: 1, s2: 1 },
      20,
      'defer',
    );
    expect(r.perServer.s1).toBe('async');
    expect(r.perServer.s2).toBe('async');
    expect(r.anyAsync).toBe(true);
  });

  test('undefined 在 auto 下：低于阈值 → sync', () => {
    const r = decideMcpDeferMode({ s1: {} }, { s1: 19 }, 20, 'auto');
    expect(r.perServer.s1).toBe('sync');
    expect(r.anyAsync).toBe(false);
  });

  test('undefined 在 auto 下:达到/超过阈值 → async', () => {
    expect(decideMcpDeferMode({ s1: {} }, { s1: 20 }, 20, 'auto').perServer.s1).toBe('async');
    expect(decideMcpDeferMode({ s1: {} }, { s1: 30 }, 20, 'auto').perServer.s1).toBe('async');
  });

  test('auto 阈值累加 auto + 强制 sync 的工具数（强制 async 不计入）', () => {
    // s1(auto,12) + s2(sync,8) = 20 >= 20 → 两者都 async；s3(async,100) 不参与累加但自身 async。
    const r = decideMcpDeferMode(
      { s1: {}, s2: { defer_loading: false }, s3: { defer_loading: true } },
      { s1: 12, s2: 8, s3: 100 },
      20,
      'auto',
    );
    // s2 显式 false → 永远 sync（不受累加影响）。
    expect(r.perServer.s2).toBe('sync');
    // s1 是 auto，累加 20 达阈值 → async。
    expect(r.perServer.s1).toBe('async');
    expect(r.perServer.s3).toBe('async');
  });

  test('env 通过 threshold/defaultMode 参数被尊重', () => {
    const env = { FORGEAX_MCP_SYNC_THRESHOLD: '5', FORGEAX_MCP_DEFER_DEFAULT: 'auto' };
    const threshold = readMcpSyncThreshold(env);
    const mode = readMcpDeferDefault(env);
    expect(threshold).toBe(5);
    expect(mode).toBe('auto');
    // 工具数 6 >= 5 → async。
    expect(decideMcpDeferMode({ s1: {} }, { s1: 6 }, threshold, mode).perServer.s1).toBe('async');
    // 工具数 4 < 5 → sync。
    expect(decideMcpDeferMode({ s1: {} }, { s1: 4 }, threshold, mode).perServer.s1).toBe('sync');
  });
});

// ─── (b) bridge：deferMode → shouldDefer ───────────────────────────────────────

describe('mapMcpToolToAgentTool deferMode', () => {
  test('deferMode async → shouldDefer()===true', () => {
    const tool = mapMcpToolToAgentTool(fakeClient, 'srv', mkTool('foo'), { deferMode: 'async' });
    expect(typeof tool.shouldDefer).toBe('function');
    expect(tool.shouldDefer?.()).toBe(true);
  });

  test('deferMode async 但 alwaysLoad → 不延迟（无 shouldDefer）', () => {
    const tool = mapMcpToolToAgentTool(
      fakeClient,
      'srv',
      mkTool('foo', { 'anthropic/alwaysLoad': true }),
      { deferMode: 'async' },
    );
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.shouldDefer).toBeUndefined();
  });

  test('deferMode sync / 缺省 → 不设 shouldDefer', () => {
    const sync = mapMcpToolToAgentTool(fakeClient, 'srv', mkTool('foo'), { deferMode: 'sync' });
    const none = mapMcpToolToAgentTool(fakeClient, 'srv', mkTool('foo'));
    expect(sync.shouldDefer).toBeUndefined();
    expect(none.shouldDefer).toBeUndefined();
  });
});

// ─── (c) config：defer_loading + auth round-trip ───────────────────────────────

describe('parseMcpConfig defer_loading + auth', () => {
  test('defer_loading:true + auth bearer round-trips', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: {
        s1: {
          type: 'http',
          url: 'https://example.com/mcp',
          defer_loading: true,
          auth: { type: 'bearer', tokenEnv: 'TOK' },
        },
      },
    });
    expect(errors).toEqual([]);
    expect(servers).toHaveLength(1);
    const cfg = servers[0].config as { defer_loading?: boolean; auth?: { type: string; tokenEnv?: string } };
    expect(cfg.defer_loading).toBe(true);
    expect(cfg.auth).toEqual({ type: 'bearer', tokenEnv: 'TOK' });
  });

  test('defer_loading 非 boolean → fail-soft 进 errors', () => {
    const { servers, errors } = parseMcpConfig({
      mcpServers: { s1: { command: 'x', args: [], defer_loading: 'yes' } },
    });
    expect(servers).toHaveLength(0);
    expect(errors.some((e) => /defer_loading.*boolean/.test(e))).toBe(true);
  });

  test('auth 非对象 / 缺 string type → fail-soft 进 errors', () => {
    const r1 = parseMcpConfig({ mcpServers: { s1: { command: 'x', args: [], auth: 'nope' } } });
    expect(r1.errors.some((e) => /auth.*type/.test(e))).toBe(true);
    const r2 = parseMcpConfig({ mcpServers: { s1: { command: 'x', args: [], auth: { token: 'z' } } } });
    expect(r2.errors.some((e) => /auth.*type/.test(e))).toBe(true);
  });

  test('缺省（无 defer_loading/auth）不挂多余字段', () => {
    const { servers } = parseMcpConfig({ mcpServers: { s1: { command: 'x', args: [] } } });
    const cfg = servers[0].config as { defer_loading?: boolean; auth?: unknown };
    expect(cfg.defer_loading).toBeUndefined();
    expect(cfg.auth).toBeUndefined();
  });
});
