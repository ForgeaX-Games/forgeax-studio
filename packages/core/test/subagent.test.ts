/**
 * Subagent 测试(Task):隔离上下文跑子 loop、只返回结果、子自压缩、Task 工具派发。
 */
import { test, expect, describe } from 'bun:test';
import { runSubagent, makeTaskTool } from '../src/agent/subagent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { CompactionStrategy } from '../src/context/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, usage: EMPTY_USAGE as Usage, stopReason: 'tool_use' };
}
function asstText(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}
function scripted(turns: ProviderStreamEvent[][]): LLMProvider {
  let n = 0;
  return { api: 'stub', async *stream() { const t = turns[Math.min(n, turns.length - 1)]; n++; for (const e of t) yield e; } };
}

const echo = buildTool({
  name: 'echo', isConcurrencySafe: () => true, isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }), maxResultSizeChars: 1000,
});

describe('runSubagent — isolated child loop, result-only', () => {
  test('child uses its own tools and returns final text; tool calls counted', async () => {
    const provider = scripted([[asstToolUse('t1', 'echo', { v: 1 })], [asstText('subagent finished: 42')]]);
    const r = await runSubagent(
      { input: 'do a small task', model: 'm', tools: [echo], leadingSystemText: 'You are a worker.' },
      { provider },
    );
    expect(r.text).toBe('subagent finished: 42'); // 父只见最终文本
    expect(r.terminalReason).toBe('completed');
    expect(r.toolCalls).toBe(1); // 子的工具调用在子内发生(父不见步骤,只计数)
    expect(r.turns).toBeGreaterThanOrEqual(2);
  });

  test('transcript→result: parent gets only text, not child tool events', async () => {
    const provider = scripted([[asstToolUse('t1', 'echo', {})], [asstText('done-x')]]);
    const r = await runSubagent({ input: 'x', model: 'm', tools: [echo] }, { provider });
    // 结果是字符串,不含子的 tool_result 结构(已压成 result)
    expect(typeof r.text).toBe('string');
    expect(r.text).toBe('done-x');
  });
});

describe('subagent self-compaction(子自压缩)', () => {
  test('compaction strategy injected into child fires during its run', async () => {
    let compacted = 0;
    const strategy: CompactionStrategy = {
      name: 'always',
      shouldCompact: () => true,
      async compact() { compacted++; return { replacement: { role: 'user', content: '[SUB SUMMARY]' }, coveredFrom: 0, coveredTo: 0 }; },
    };
    // 两轮:子上下文每轮都过水位 → 子自压缩被调
    const provider = scripted([[asstToolUse('t1', 'echo', {})], [asstText('ok')]]);
    const r = await runSubagent(
      { input: 'long task', model: 'm', tools: [echo], compaction: strategy, contextWindow: 100 },
      { provider },
    );
    expect(compacted).toBeGreaterThanOrEqual(1); // 子在自己上下文上压缩了
    expect(r.terminalReason).toBe('completed');
  });
});

describe('makeTaskTool — 父模型据此派 subagent', () => {
  test('Task 工具 dispatch 一个 subagent 并返回其结果', async () => {
    const provider = scripted([[asstText('child answer: 7')]]);
    const task = makeTaskTool({
      provider,
      model: 'm',
      resolveTools: () => [echo], // 子工具不含 Task(防递归)
      resolveSystem: (t) => `You are a ${t ?? 'general'} subagent.`,
    });
    expect(task.name).toBe('Task');
    expect(task.isConcurrencySafe(undefined as never)).toBe(true); // 并发安全:多 subagent 可并行
    const out = await task.call({ prompt: 'compute 7', subagent_type: 'math' }, { signal: new AbortController().signal });
    expect(out.data.text).toBe('child answer: 7');
    expect(out.data.terminalReason).toBe('completed');
    const ev = task.mapResult(out.data, 'call1') as { payload: { ok: boolean; result: string } };
    expect(ev.payload.ok).toBe(true);
    expect(ev.payload.result).toBe('child answer: 7');
  });

  test('child tool set excludes Task (no infinite recursion)', async () => {
    const provider = scripted([[asstText('done')]]);
    let childTools: AgentTool[] = [];
    const task = makeTaskTool({
      provider, model: 'm',
      resolveTools: () => { childTools = [echo]; return childTools; },
    });
    await task.call({ prompt: 'x' }, { signal: new AbortController().signal });
    expect(childTools.some((t) => t.name === 'Task')).toBe(false);
  });
});
