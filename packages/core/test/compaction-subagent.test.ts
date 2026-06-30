/**
 * 子 agent 压缩:与主 agent 一致 + 主子互不影响(gateState 隔离)。
 * 要求:子压缩走同一套(比例水位/闸/管线/de-nest);主子各自独立实例 → 冷却/熔断不串。
 * 见 docs/features/compaction-overhaul-verification.md §子agent。
 */
import { describe, test, expect, mock } from 'bun:test';
import { runSubagent } from '../src/agent/subagent';
import { CoreAgent, type CompactionV2Options } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import type { LLMProvider, ProviderStreamEvent, Usage, ProviderMessage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';

function asstText(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}
const oneTurn: LLMProvider = { api: 'stub', async *stream() { yield asstText('done'); } };

const SMALL = { contextWindow: 21_000, maxOutputTokens: 1_000 }; // effective 20000; emergency 18400
const bigText = (tok: number) => 'x'.repeat(tok * 4);

function v2(summarize: CompactionV2Options['summarize'], over: Partial<CompactionV2Options> = {}): CompactionV2Options {
  return { summarize, modelInfo: SMALL, nowFn: () => 1_000_000, preMessage: false, ...over };
}

describe('子 agent 压缩一致性', () => {
  test('子上下文越线 → 子自压缩(走同一管线,summarize 被调)', async () => {
    const summarize = mock(async () => '<summary>child</summary>');
    const r = await runSubagent(
      { input: bigText(19_000), model: 'm', tools: [], compactionV2: v2(summarize) },
      { provider: oneTurn },
    );
    expect(r.terminalReason).toBe('completed');
    expect(summarize).toHaveBeenCalledTimes(1); // 子确实压了
  });

  test('子上下文小 → sufficiency 短路(与主一致,不调 LLM)', async () => {
    const summarize = mock(async () => '<summary>x</summary>');
    // 大但全是"可剥"的 tool 输出?子 input 是纯文本无法剥 → 用小文本直接不越线
    await runSubagent(
      { input: 'tiny', model: 'm', tools: [], compactionV2: v2(summarize) },
      { provider: oneTurn },
    );
    expect(summarize).toHaveBeenCalledTimes(0); // 没越线,压根不压
  });
});

describe('主子隔离:gateState 不互相影响', () => {
  test('同一 now 跑两个子,各自压缩(若共享 gate,第二个会被 cooldown 拦)', async () => {
    const summarize = mock(async () => '<summary>s</summary>');
    const cfg = v2(summarize); // 同一 config 对象(含同 nowFn 常量)
    await runSubagent({ input: bigText(19_000), model: 'm', tools: [], compactionV2: cfg }, { provider: oneTurn });
    expect(summarize).toHaveBeenCalledTimes(1);
    await runSubagent({ input: bigText(19_000), model: 'm', tools: [], compactionV2: cfg }, { provider: oneTurn });
    // 第二个子是**独立 CoreAgent 实例** → gate 全新 → 同 now 仍压(共享则会被 cooldown 拦成 1)
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  test('父压缩后,子用同 now 仍能压(父冷却不影响子)', async () => {
    const summarize = mock(async () => '<summary>s</summary>');
    const cfg = v2(summarize);
    // 父:一个 CoreAgent,跑到越线压一次(同 now)
    const ctx: AgentContext = { agentId: 'parent', provider: oneTurn, config: { systemPromptSlots: [], model: 'm', tools: [], maxTurns: 2 }, toolContext: {} };
    const parent = new CoreAgent({ context: ctx, compactionV2: cfg });
    const pe: AgentEvent[] = [];
    for await (const e of parent.run({ input: { type: 'user', payload: 'q', ts: 0 }, history: [{ role: 'user', content: bigText(19_000) }] })) pe.push(e);
    expect(summarize).toHaveBeenCalledTimes(1); // 父压了一次,父 gate 进入 cooldown(now 固定)

    // 子:同 now、同 config → 父冷却不应波及子(独立实例)
    await runSubagent({ input: bigText(19_000), model: 'm', tools: [], compactionV2: cfg }, { provider: oneTurn });
    expect(summarize).toHaveBeenCalledTimes(2); // 子照常压 → 隔离成立
  });

  test('子压缩事件不外溢父 bus(子用独立 bus)', async () => {
    const parentBus = new EventBus();
    let parentSawCompaction = 0;
    parentBus.subscribe(CoreEventType.CompactionApplied, () => { parentSawCompaction++; });
    const summarize = mock(async () => '<summary>s</summary>');
    // deps.bus = parentBus(仅收 subagent.stop);子压缩走 childBus,不应进 parentBus
    await runSubagent(
      { input: bigText(19_000), model: 'm', tools: [], compactionV2: v2(summarize) },
      { provider: oneTurn, bus: parentBus },
    );
    expect(summarize).toHaveBeenCalledTimes(1); // 子确实压了
    expect(parentSawCompaction).toBe(0); // 但父 bus 看不到子的 CompactionApplied(上下文隔离)
  });
});
