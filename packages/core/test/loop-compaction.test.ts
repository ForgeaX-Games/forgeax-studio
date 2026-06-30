/**
 * T25 — compaction wired into the loop: watermark → strategy.compact →
 * CompactionApplied event → skip-and-replace on messages (派生=fold 闭环)。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import { buildTool } from '../src/capability/types';
import type { CompactionStrategy } from '../src/context/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstText(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}
const provider: LLMProvider = { api: 'stub', async *stream() { yield asstText('done'); } };
const tool = buildTool({ name: 'echo', call: async (i: unknown) => ({ data: i }), mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }), maxResultSizeChars: 100 });

function ctx(history: { role: 'user' | 'assistant'; content: unknown }[] = []): { context: AgentContext; history: typeof history } {
  return {
    context: { agentId: 'c1', provider, config: { systemPromptSlots: [], model: 'm', tools: [tool], maxTurns: 4 }, toolContext: {} },
    history,
  };
}

describe('LOOP compaction integration', () => {
  test('strategy.shouldCompact true → CompactionApplied published + messages collapsed', async () => {
    let compacted = false;
    const strategy: CompactionStrategy = {
      name: 'always',
      shouldCompact: () => true,
      async compact() {
        compacted = true;
        return { replacement: { role: 'user', content: '[SUMMARY]' }, coveredFrom: 0, coveredTo: 1 };
      },
    };
    const bus = new EventBus();
    const applied: unknown[] = [];
    bus.subscribe(CoreEventType.CompactionApplied, (e) => { applied.push(e.payload); });

    const { context } = ctx();
    const agent = new CoreAgent({ context, bus, compaction: strategy, contextWindow: 1000 });
    const events: AgentEvent[] = [];
    for await (const e of agent.run({
      input: { type: 'user', payload: 'hi', ts: 0 },
      history: [
        { role: 'user', content: 'old-1' },
        { role: 'assistant', content: 'old-2' },
      ],
    })) events.push(e);

    expect(compacted).toBe(true);
    expect(applied.length).toBe(1);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('no strategy → no compaction event, still completes', async () => {
    const bus = new EventBus();
    let any = false;
    bus.subscribe(CoreEventType.CompactionApplied, () => { any = true; });
    const { context } = ctx();
    const agent = new CoreAgent({ context, bus });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) { /* drain */ }
    expect(any).toBe(false);
  });

  test('shouldCompact false → compact() not called', async () => {
    let called = false;
    const strategy: CompactionStrategy = {
      name: 'never',
      shouldCompact: () => false,
      async compact() { called = true; return { replacement: {}, coveredFrom: 0, coveredTo: 0 }; },
    };
    const { context } = ctx();
    const agent = new CoreAgent({ context, compaction: strategy });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) { /* drain */ }
    expect(called).toBe(false);
  });
});
