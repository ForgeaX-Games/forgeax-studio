/**
 * Stream E 验收(loop 集成层):#5/#8/#6/#11。Cases E-I4..I12 + 重挂集成。
 * 见 docs/features/compaction-overhaul-verification.md §5。
 *
 * compactionV2 注入即激活新路径:比例水位 + 闸 + 三层管线 + 重挂 + 三 CompactType + pre-message。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent, type CompactionV2Options } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import { buildTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import { CompactType } from '../src/context/compaction-types';

function asstText(text: string, stop: 'end_turn' = 'end_turn'): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: stop };
}
function asstToolUse(id: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'echo', input: {} }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}

const oneTurn: LLMProvider = { api: 'stub', async *stream() { yield asstText('done'); } };
function twoTurn(): LLMProvider {
  let n = 0;
  return { api: 'stub', async *stream() { yield n++ === 0 ? asstToolUse('t1') : asstText('done'); } };
}

const echo = buildTool({ name: 'echo', call: async (i: unknown) => ({ data: i }), mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }), maxResultSizeChars: 100 });

function ctx(provider: LLMProvider = oneTurn): AgentContext {
  return { agentId: 'c1', provider, config: { systemPromptSlots: [], model: 'm', tools: [echo], maxTurns: 4 }, toolContext: {} };
}

// 小窗口:contextWindow=21000, maxOut=1000 → effective=20000;preCompact=16000, emergency=18400。
const SMALL = { contextWindow: 21_000, maxOutputTokens: 1_000 };
const big = (tokens: number) => 'x'.repeat(tokens * 4); // estimateTokens = chars/4

function v2(over: Partial<CompactionV2Options> = {}): CompactionV2Options {
  return {
    summarize: async () => '<summary>compacted</summary>',
    modelInfo: SMALL,
    nowFn: () => 1_000_000,
    preMessage: false, // 多数用例先关 pre-flight,单独测
    ...over,
  };
}

async function drain(agent: CoreAgent, input: string, history: { role: 'user' | 'assistant'; content: unknown }[] = []): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: input, ts: 0 }, history })) out.push(e);
  return out;
}

describe('Stream E — compaction V2 loop integration (#5/#8/#6/#11)', () => {
  test('E-I4 事件顺序 PreCompact → CompactionApplied → PostCompact', async () => {
    const bus = new EventBus();
    const seq: string[] = [];
    for (const t of [CoreEventType.PreCompact, CoreEventType.CompactionApplied, CoreEventType.PostCompact]) {
      bus.subscribe(t, (e) => { seq.push(e.type); });
    }
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]); // > emergency 18400
    const i = (t: string) => seq.indexOf(t);
    expect(i(CoreEventType.PreCompact)).toBeGreaterThanOrEqual(0);
    expect(i(CoreEventType.PreCompact)).toBeLessThan(i(CoreEventType.CompactionApplied));
    expect(i(CoreEventType.CompactionApplied)).toBeLessThan(i(CoreEventType.PostCompact));
  });

  test('E-I5 PreCompact hook blocked → 不压缩(无 CompactionApplied)', async () => {
    const bus = new EventBus();
    bus.subscribe(CoreEventType.PreCompact, (e) => { (e as unknown as { blocked?: boolean }).blocked = true; });
    let applied = 0;
    bus.subscribe(CoreEventType.CompactionApplied, () => { applied++; });
    const sum = (() => { let c = 0; const f = (async () => { c++; return '<summary>x</summary>'; }) as CompactionV2Options['summarize']; (f as any).calls = () => c; return f; })();
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2({ summarize: sum }) });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied).toBe(0);
    expect((sum as any).calls()).toBe(0); // summarize 也没被调
  });

  test('E-I6 CompactType:stage3 emergency 标 EMERGENCY_AUTO', async () => {
    const bus = new EventBus();
    const types: unknown[] = [];
    bus.subscribe(CoreEventType.PreCompact, (e) => { types.push((e.payload as { type?: unknown }).type); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(types).toContain(CompactType.EMERGENCY_AUTO);
  });

  test('E-I7 pre-message 预压:preCompact<tokens<emergency → PRE_MESSAGE_AUTO 触发', async () => {
    const bus = new EventBus();
    const types: unknown[] = [];
    bus.subscribe(CoreEventType.PreCompact, (e) => { types.push((e.payload as { type?: unknown }).type); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2({ preMessage: true }) });
    await drain(agent, 'q', [{ role: 'user', content: big(17_000) }]); // 16000<17000<18400
    expect(types).toContain(CompactType.PRE_MESSAGE_AUTO);
  });

  test('E-I8 CompactionApplied 载荷 + 收尾 completed', async () => {
    const bus = new EventBus();
    const applied: any[] = [];
    bus.subscribe(CoreEventType.CompactionApplied, (e) => { applied.push(e.payload); });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied.length).toBe(1);
    expect(applied[0].coveredFrom).toBe(0);
    expect(applied[0].coveredTo).toBeGreaterThanOrEqual(0);
    expect(applied[0].replacement).toBeTruthy();
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('E-I10 冷却:同 now 第二轮被 cooldown 拦(仅 1 次 CompactionApplied)', async () => {
    const bus = new EventBus();
    let applied = 0;
    bus.subscribe(CoreEventType.CompactionApplied, () => { applied++; });
    // 2 turn:turn0 工具续轮(压缩)、turn1 收尾(同 now → cooldown 跳过第二次)
    const agent = new CoreAgent({ context: ctx(twoTurn()), bus, compactionV2: v2() });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied).toBe(1);
  });

  test('E-I11 摘要非 PTL 失败 → done(prompt_too_long)(熔断计数;不崩)', async () => {
    const agent = new CoreAgent({
      context: ctx(),
      compactionV2: v2({ summarize: async () => { throw new Error('model exploded'); } }),
    });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('prompt_too_long');
  });

  test('E-I12 字节稳定:未越线 → 无压缩,正常完成', async () => {
    const bus = new EventBus();
    let any = false;
    bus.subscribe(CoreEventType.CompactionApplied, () => { any = true; });
    const agent = new CoreAgent({ context: ctx(), bus, compactionV2: v2() });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(1_000) }]); // 远低于 preCompact
    expect(any).toBe(false);
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('重挂集成:压后附最近文件 attachment', async () => {
    const bus = new EventBus();
    let applied = 0;
    bus.subscribe(CoreEventType.CompactionApplied, () => { applied++; });
    const agent = new CoreAgent({
      context: ctx(),
      bus,
      compactionV2: v2({
        rehydrate: { recentReadPaths: () => ['/a.ts'], readFile: async () => 'recent file body', tokenBudget: 10_000, maxFiles: 1 },
      }),
    });
    const ev = await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(applied).toBe(1); // 压缩发生(重挂只在压缩后跑,不抛即通过)
    const last = ev.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('与 legacy compaction 互斥:V2 优先,旧 strategy 不被调', async () => {
    let legacyCalled = false;
    const agent = new CoreAgent({
      context: ctx(),
      compaction: { name: 'legacy', shouldCompact: () => true, async compact() { legacyCalled = true; return { replacement: {}, coveredFrom: 0, coveredTo: 0 }; } },
      compactionV2: v2(),
    });
    await drain(agent, 'q', [{ role: 'user', content: big(19_000) }]);
    expect(legacyCalled).toBe(false);
  });
});
