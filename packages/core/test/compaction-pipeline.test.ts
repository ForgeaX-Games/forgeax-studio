/**
 * Stream E(管线层)验收:#5/#12 三层管线 + sufficiency 短路。Cases E-I1..I3。
 * loop 集成层(E-I4..I13)待 loop 重构稳定后由集成者补(见 plan §Stream E)。
 * 见 docs/features/compaction-overhaul-verification.md §5。
 */
import { describe, test, expect, mock } from 'bun:test';
import { runCompaction, renderDeterministicSummary } from '../src/context/compaction-pipeline';
import { computeWatermarksFromModel } from '../src/context/watermarks';
import { PROMPT_TOO_LONG_MESSAGE, type ProviderMessage } from '../src/provider/types';
import type { CompactPipelineInput } from '../src/context/compaction-types';

const marks = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });
// effective=180_000 → sufficiency 0.15 阈 = 27_000 tok

function input(over: Partial<CompactPipelineInput>): CompactPipelineInput {
  return {
    messages: [],
    scenario: 'full',
    marks,
    summarize: async () => '<summary>llm summary</summary>',
    sufficiencyRatio: 0.15,
    messagesToKeep: 0,
    now: 1,
    ...over,
  };
}

describe('Stream E — pipeline (#5/#12)', () => {
  test('E-I1 L1 短路:小上下文 → usedLLM=false, summarize 未被调用', async () => {
    const summarize = mock(async () => '<summary>should NOT be called</summary>');
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'short question' },
      { role: 'assistant', content: 'short answer' },
    ];
    const r = await runCompaction(input({ messages: msgs, summarize }));
    expect(r.usedLLM).toBe(false);
    expect(summarize).toHaveBeenCalledTimes(0);
    expect(r.replacement.content).toContain('deterministic compaction');
    expect(r.coveredFrom).toBe(0);
    expect(r.coveredTo).toBe(1);
  });

  test('E-I2 L1 不足 → L2 summarize 调用一次,replacement 为摘要', async () => {
    const summarize = mock(async () => '<summary>the real summary</summary>');
    // 造一个 L1 剥不掉、仍很大的上下文(纯 user 文本,无图无 tool result)
    const huge = 'word '.repeat(40_000); // ~50k tok,> 27k 阈
    const msgs: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ];
    const r = await runCompaction(input({ messages: msgs, summarize }));
    expect(r.usedLLM).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(r.replacement.content).toContain('the real summary');
    expect(r.replacement.content).toContain('This session is being continued');
  });

  test('E-I3 L2 非 PTL 失败 → 上抛(供 E 回滚 + 熔断)', async () => {
    const huge = 'word '.repeat(40_000);
    const msgs: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ];
    await expect(
      runCompaction(
        input({
          messages: msgs,
          summarize: async () => {
            throw new Error('model exploded');
          },
        }),
      ),
    ).rejects.toThrow('model exploded');
  });

  test('E-I2b PTL 重试收敛(前2次 PTL 第3次成功)', async () => {
    const huge = 'word '.repeat(40_000);
    const msgs: ProviderMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: huge,
    }));
    let calls = 0;
    const r = await runCompaction(
      input({
        messages: msgs,
        summarize: async () => {
          calls++;
          if (calls <= 2) throw new Error(`${PROMPT_TOO_LONG_MESSAGE} overflow`);
          return '<summary>converged</summary>';
        },
      }),
    );
    expect(calls).toBe(3);
    expect(r.replacement.content).toContain('converged');
  });

  test('messagesToKeep:保留尾部不进压缩范围', async () => {
    const huge = 'word '.repeat(40_000);
    const msgs: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: 'recent tail' },
    ];
    const r = await runCompaction(input({ messages: msgs, messagesToKeep: 1, summarize: async () => '<summary>s</summary>' }));
    expect(r.coveredTo).toBe(1); // 只覆盖前 2 条,尾 1 条保留
  });

  test('renderDeterministicSummary:结构化骨架', () => {
    const out = renderDeterministicSummary([
      { role: 'user', content: 'do X' } as ProviderMessage,
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.ts' } }] } as unknown as ProviderMessage,
    ]);
    expect(out).toContain('<previous_user_message>');
    expect(out).toContain('do X');
    expect(out).toContain('tool_call Read');
  });
});
