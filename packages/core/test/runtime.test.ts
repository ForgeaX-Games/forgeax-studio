/**
 * Wave4 RUN tests — createAgent assembles a working native agent + WAL.
 */
import { test, expect, describe } from 'bun:test';
import { createAgent } from '../src/runtime/run';
import { InMemoryEventStore } from '../src/history/event-store';
import { buildTool } from '../src/capability/types';
import type { AgentContext } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}
const provider: LLMProvider = {
  api: 'stub',
  async *stream() {
    yield asstText('hello');
  },
};

const tool = buildTool({
  name: 'echo',
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
  maxResultSizeChars: 100,
});

function ctx(): AgentContext {
  return {
    agentId: 'r1',
    provider,
    config: { systemPromptSlots: [], model: 'm', tools: [tool], maxTurns: 4 },
    toolContext: {},
  };
}

describe('createAgent — assembly + WAL', () => {
  test('returns a runnable agent that completes a turn', async () => {
    const { agent } = createAgent({ context: ctx() });
    let done = false;
    for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      if (e.type === 'done') done = e.terminal.reason === 'completed';
    }
    expect(done).toBe(true);
  });

  test('WAL store captures published events (turn lifecycle)', async () => {
    const store = new InMemoryEventStore();
    const { agent } = createAgent({ context: ctx(), store });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      // drain
    }
    // allow fire-and-forget appends to flush
    await new Promise((r) => setTimeout(r, 5));
    const snapshot = store.snapshot();
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot.some((e) => e.type === 'turn.start')).toBe(true);
    expect(snapshot.some((e) => e.type === 'turn.end')).toBe(true);
  });

  test('autoConnectStore:false leaves store empty', async () => {
    const store = new InMemoryEventStore();
    const { agent } = createAgent({ context: ctx(), store, autoConnectStore: false });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 5));
    expect(store.snapshot().length).toBe(0);
  });
});
