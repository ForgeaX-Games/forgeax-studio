/**
 * Tool-result budget gate (移植 agentic_os 03.B.1/B.2) 单测。
 */
import { test, expect, describe } from 'bun:test';
import {
  applyResultBudget,
  renderHeadTailPreview,
  DEFAULT_MCP_RESULT_BUDGET,
  HEAD_TAIL_HEAD_RATIO,
} from '../src/context/tool-result-budget';
import { getMcpTools } from '../src/capability/mcp/bridge';
import type { MCPClient, MCPTool, MCPToolResult } from '../src/capability/mcp/client';

describe('applyResultBudget — 阈值内/无界恒等', () => {
  test('content <= maxChars → 原样返回, truncated=false', () => {
    const r = applyResultBudget('hello', 100);
    expect(r.output).toBe('hello');
    expect(r.truncated).toBe(false);
    expect(r.originalChars).toBe(5);
  });

  test('maxChars=Infinity → 永不裁(read_file 等)', () => {
    const big = 'x'.repeat(1_000_000);
    const r = applyResultBudget(big, Infinity);
    expect(r.output).toBe(big);
    expect(r.truncated).toBe(false);
  });

  test('content 恰好 = maxChars → 不裁', () => {
    const s = 'x'.repeat(50);
    expect(applyResultBudget(s, 50).truncated).toBe(false);
  });
});

describe('applyResultBudget — 超阈值 head-tail', () => {
  test('maxChars+1 → 裁剪, 总长 ≤ maxChars, 含真实省略数, 保头保尾', () => {
    const head = 'H'.repeat(8000);
    const tail = 'T'.repeat(2000);
    const raw = head + 'M'.repeat(40_001) + tail; // > 50000
    const max = 50_000;
    const r = applyResultBudget(raw, max);
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(raw.length);
    expect(r.output.length).toBeLessThanOrEqual(max);
    expect(r.output).toContain('truncated');
    // 头部权重 80% → 应保留开头的 H;尾部权重 20% → 应保留结尾的 T。
    expect(r.output.startsWith('H')).toBe(true);
    expect(r.output.endsWith('T')).toBe(true);
    // marker 里的 N 是真实省略数(正整数)。
    const m = r.output.match(/truncated (\d+) chars/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  test('renderHeadTailPreview 头尾比例约 80:20', () => {
    const raw = 'A'.repeat(100_000);
    const max = 10_000;
    const out = renderHeadTailPreview(raw, max);
    expect(out.length).toBeLessThanOrEqual(max);
    expect(HEAD_TAIL_HEAD_RATIO).toBe(0.8);
  });

  test('maxChars 极小(< marker)不抛错', () => {
    expect(() => applyResultBudget('x'.repeat(100), 10)).not.toThrow();
    const r = applyResultBudget('x'.repeat(100), 10);
    expect(r.truncated).toBe(true);
  });
});

describe('MCP 工具有界默认', () => {
  function fakeClient(tools: MCPTool[]): MCPClient {
    return {
      serverName: 'srv',
      async listTools() {
        return tools;
      },
      async callTool(): Promise<MCPToolResult> {
        return { content: 'ok' };
      },
    };
  }

  test('getMcpTools 产出工具 maxResultSizeChars === DEFAULT_MCP_RESULT_BUDGET(非 Infinity)', async () => {
    const tools = await getMcpTools(fakeClient([{ name: 'do', inputSchema: { type: 'object' } }]), 'srv');
    expect(tools.length).toBe(1);
    expect(tools[0].maxResultSizeChars).toBe(DEFAULT_MCP_RESULT_BUDGET);
    expect(Number.isFinite(tools[0].maxResultSizeChars)).toBe(true);
  });
});
