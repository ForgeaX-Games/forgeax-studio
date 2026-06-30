/**
 * Loop-level 治理集成:全局 budget 兜底、循环兜底(unrecoverable_tool_error)、
 * 真实 token 账驱动 compaction。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { CompactionStrategy, Watermarks } from '../src/context/types';
import type { LLMProvider, ProviderStreamEvent, ProviderMessage, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstToolUse(id: string, name: string, input: unknown, inputTokens = 0): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: { ...EMPTY_USAGE, inputTokens } as Usage,
    stopReason: 'tool_use',
  };
}
function asstText(text: string, inputTokens = 0): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { ...EMPTY_USAGE, inputTokens } as Usage,
    stopReason: 'end_turn',
  };
}

function scriptedProvider(scripts: ProviderStreamEvent[][]): { provider: LLMProvider; reqMessages: ProviderMessage[][] } {
  const reqMessages: ProviderMessage[][] = [];
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req) {
      reqMessages.push(req.messages);
      const turn = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of turn) yield ev;
    },
  };
  return { provider, reqMessages };
}

function ctx(tools: AgentTool[], provider: LLMProvider): AgentContext {
  return { agentId: 'a1', provider, config: { systemPromptSlots: [], model: 'm', tools, maxTurns: 12 }, toolContext: {} };
}

async function collect(agent: CoreAgent, input: Parameters<CoreAgent['run']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

function findToolResultBlocks(messages: ProviderMessage[]): Array<{ content: unknown }> {
  const out: Array<{ content: unknown }> = [];
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as Array<{ type?: string; content?: unknown }>) {
        if (b.type === 'tool_result') out.push({ content: b.content });
      }
    }
  }
  return out;
}

// ─── 全局 budget 兜底 ──────────────────────────────────────────────────────────

describe('全局 budget 兜底在 loop 中', () => {
  test('小 maxResultSizeChars 工具的大输出 → 回灌前被 head-tail 裁', async () => {
    const big = buildTool({
      name: 'big',
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      maxResultSizeChars: 200,
      call: async () => ({ data: 'Z'.repeat(5000) }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { toolUseId: id, result: o }, ts: 0 }),
    });
    const { provider, reqMessages } = scriptedProvider([
      [asstToolUse('t1', 'big', {})],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([big], provider) });
    await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    // 次轮请求里的 tool_result 内容应被裁到 ≤200 且含 truncated marker。
    const blocks = findToolResultBlocks(reqMessages[1]);
    expect(blocks.length).toBe(1);
    const content = blocks[0].content as string;
    expect(content.length).toBeLessThanOrEqual(200);
    expect(content).toContain('truncated');
  });

  test('Infinity 工具不裁(逐字回灌)', async () => {
    const raw = 'Y'.repeat(3000);
    const unbounded = buildTool({
      name: 'unbounded',
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      maxResultSizeChars: Infinity,
      call: async () => ({ data: raw }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { toolUseId: id, result: o }, ts: 0 }),
    });
    const { provider, reqMessages } = scriptedProvider([[asstToolUse('t1', 'unbounded', {})], [asstText('done')]]);
    const agent = new CoreAgent({ context: ctx([unbounded], provider) });
    await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const content = findToolResultBlocks(reqMessages[1])[0].content as string;
    expect(content).toBe(raw);
  });
});

// ─── 循环兜底 ─────────────────────────────────────────────────────────────────

describe('循环兜底 unrecoverable_tool_error', () => {
  test('同一工具(name+args)连续 2 次报错 → 终止', async () => {
    const flaky = buildTool({
      name: 'flaky',
      isConcurrencySafe: () => true,
      call: async () => {
        throw new Error('boom');
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const { provider } = scriptedProvider([[asstToolUse('e1', 'flaky', { x: 1 })]]); // 每轮都同 args 报错
    const agent = new CoreAgent({ context: ctx([flaky], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const last = events.at(-1)!;
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.terminal.reason).toBe('unrecoverable_tool_error');
  });

  test('成功穿插重置该 key — 不误杀', async () => {
    let n = 0;
    const recover = buildTool({
      name: 'recover',
      isConcurrencySafe: () => true,
      call: async () => {
        n++;
        if (n === 1) throw new Error('first fails');
        return { data: 'ok' };
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const { provider } = scriptedProvider([
      [asstToolUse('e1', 'recover', { x: 1 })], // 失败 → streak 1
      [asstToolUse('e2', 'recover', { x: 1 })], // 成功 → streak 重置 0
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([recover], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const last = events.at(-1)!;
    if (last.type === 'done') expect(last.terminal.reason).toBe('completed');
  });

  test('maxToolErrorStreak=0 关闭兜底', async () => {
    const flaky = buildTool({
      name: 'flaky',
      isConcurrencySafe: () => true,
      call: async () => {
        throw new Error('boom');
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const { provider } = scriptedProvider([[asstToolUse('e1', 'flaky', {})]]);
    const agent = new CoreAgent({ context: ctx([flaky], provider), maxToolErrorStreak: 0 });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const last = events.at(-1)!;
    // 不兜底 → 跑到 maxTurns。
    if (last.type === 'done') expect(last.terminal.reason).toBe('max_turns');
  });
});

// ─── 真实 token 账 ────────────────────────────────────────────────────────────

describe('compaction 用真实 token', () => {
  test('shouldCompact 第二轮收到上一轮 API 的真实 inputTokens', async () => {
    const seen: number[] = [];
    const noopCompaction: CompactionStrategy = {
      name: 'spy',
      shouldCompact(tokenCount: number, _m: Watermarks) {
        seen.push(tokenCount);
        return false; // 只记录,不真压
      },
      async compact() {
        return { replacement: { role: 'user', content: 'x' }, coveredFrom: 0, coveredTo: 0 };
      },
    };
    const echo = buildTool({
      name: 'echo',
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      call: async () => ({ data: 'ok' }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const { provider } = scriptedProvider([
      [asstToolUse('t1', 'echo', {}, 123_456)], // turn0 回大 inputTokens
      [asstText('done', 0)],
    ]);
    const agent = new CoreAgent({ context: ctx([echo], provider), compaction: noopCompaction });
    await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    // turn0 用估算(小);turn1 用真实 123456。
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBeLessThan(1000);
    expect(seen[1]).toBe(123_456);
  });
});
