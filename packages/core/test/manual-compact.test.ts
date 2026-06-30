/**
 * 014 A 层验收:手动 `/compact` 入口 `triggerCompact`。
 * 验证它复用 runCompaction 同一管线、钉手动 CompactType.USER_COMMAND、scenario=full,
 * 且不就地改 history。对齐 compaction-pipeline.test.ts 风格。
 */
import { describe, test, expect, mock } from 'bun:test';
import { triggerCompact } from '../src/context/manual-compact';
import { computeWatermarksFromModel } from '../src/context/watermarks';
import { CompactType, type SummaryScenario } from '../src/context/compaction-types';
import type { ProviderMessage } from '../src/provider/types';

const marks = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });
// effective=180_000 → sufficiency 0.15 阈 = 27_000 tok

describe('014 A — manual triggerCompact', () => {
  test('小上下文 → L1 短路:usedLLM=false,summarize 未调,type 标手动', async () => {
    const summarize = mock(async () => '<summary>should NOT be called</summary>');
    const history: ProviderMessage[] = [
      { role: 'user', content: 'short question' },
      { role: 'assistant', content: 'short answer' },
    ];
    const r = await triggerCompact({ history, marks, summarize });
    expect(r.usedLLM).toBe(false);
    expect(summarize).toHaveBeenCalledTimes(0);
    expect(r.type).toBe(CompactType.USER_COMMAND);
    expect(r.coveredFrom).toBe(0);
    expect(r.coveredTo).toBe(1);
    expect(r.replacement.content).toContain('deterministic compaction');
  });

  test('大上下文 → 走 LLM,scenario 固定 full,summarize 调一次', async () => {
    const seen: SummaryScenario[] = [];
    const summarize = mock(async (_msgs: readonly ProviderMessage[], scenario: SummaryScenario) => {
      seen.push(scenario);
      return '<summary>real manual summary</summary>';
    });
    const huge = 'word '.repeat(40_000); // ~50k tok,> 27k 阈
    const history: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ];
    const r = await triggerCompact({ history, marks, summarize });
    expect(r.usedLLM).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['full']); // 手动恒为 full
    expect(r.type).toBe(CompactType.USER_COMMAND);
    expect(r.replacement.content).toContain('real manual summary');
  });

  test('不就地修改入参 history(history 只读语义)', async () => {
    const summarize = mock(async () => '<summary>x</summary>');
    const history: ProviderMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const before = history.length;
    await triggerCompact({ history, marks, summarize });
    expect(history.length).toBe(before);
    expect(history[0]).toEqual({ role: 'user', content: 'a' });
  });

  test('空历史 → 上抛 Not enough messages to compact', async () => {
    const summarize = mock(async () => '<summary>x</summary>');
    await expect(triggerCompact({ history: [], marks, summarize })).rejects.toThrow(
      'Not enough messages to compact.',
    );
  });

  test('summarize 非 PTL 失败 → 原样上抛(供集成方报错给用户)', async () => {
    const huge = 'word '.repeat(40_000);
    const history: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ];
    await expect(
      triggerCompact({
        history,
        marks,
        summarize: async () => {
          throw new Error('model exploded');
        },
      }),
    ).rejects.toThrow('model exploded');
  });

  test('messagesToKeep 透传:保留尾部不进压缩范围', async () => {
    const huge = 'word '.repeat(40_000);
    const history: ProviderMessage[] = [
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: 'recent tail' },
    ];
    const r = await triggerCompact({
      history,
      marks,
      summarize: async () => '<summary>s</summary>',
      messagesToKeep: 1,
    });
    expect(r.coveredTo).toBe(1); // 只覆盖前 2 条,尾 1 条保留
  });
});
