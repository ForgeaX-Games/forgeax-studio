/**
 * loop-cases — coverage-completion suite for `src/agent/agent.ts`.
 *
 * Targets the previously-uncovered CoreAgent.run branches:
 *  - abort-during-tools after stage5 → done(aborted_tools)            (agent.ts:303-306)
 *  - model_error: provider throws a non-abort error                   (agent.ts:251)
 *  - handoff_decision 续轮: multi-turn tool loop continues            (agent.ts:308-309)
 *  - turn_aborted (turn>0): abort latched at end of turn 0            (agent.ts:185-189)
 *  - abort raised mid-streaming → aborted_streaming via catch         (agent.ts:246-249)
 *  - signal pre-aborted on entry → interrupt fast-path                (agent.ts:142-147)
 *
 * Drives CoreAgent with a stub provider (scripted assistant tool_use/text/throw)
 * and buildTool-made tools. queryLoop stages.
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── stub provider helpers ──────────────────────────────────────────────────

function asstWithToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}
function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

/** Provider that replays one script (array of stream events) per call. */
function scriptedProvider(scripts: ProviderStreamEvent[][]): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream() {
      const turn = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of turn) yield ev;
    },
  };
}

/** Provider whose stream() throws the given error before yielding (model_error path). */
function throwingProvider(err: unknown): LLMProvider {
  return {
    api: 'stub',
    // eslint-disable-next-line require-yield
    async *stream() {
      throw err;
    },
  };
}

/** Provider that yields one event then throws — to exercise the mid-stream abort catch. */
function abortMidStreamProvider(onFirst: () => void): LLMProvider {
  return {
    api: 'stub',
    async *stream() {
      onFirst();
      // After the consumer aborts, throw to enter the catch; signal.aborted is true.
      throw new Error('stream interrupted');
    },
  };
}

function ctx(tools: AgentTool[], provider: LLMProvider, maxTurns = 16): AgentContext {
  return {
    agentId: 'a1',
    provider,
    config: { systemPromptSlots: [], model: 'm', tools, maxTurns },
    toolContext: {},
  };
}

async function collect(agent: CoreAgent, input: Parameters<CoreAgent['run']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

const echoTool = buildTool({
  name: 'echo',
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
  maxResultSizeChars: 1000,
});

// ─── model_error ─────────────────────────────────────────────────────────────

describe('LOOP model_error', () => {
  test('provider throws non-retryable (400) error → done(model_error) carries error', async () => {
    // status 400 is terminal (shouldRetry=false) so it propagates immediately even
    // with default retries; we also force maxRetries:0 to keep it tight.
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const agent = new CoreAgent({
      context: ctx([echoTool], throwingProvider(err)),
      retry: { maxRetries: 0, sleep: async () => {} },
    });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const last = events.at(-1)!;
    expect(last.type).toBe('done');
    expect(last.type === 'done' && last.terminal.reason).toBe('model_error');
    expect(last.type === 'done' && (last.terminal.error as Error)?.message).toBe('bad request');
    // no done(completed); model_error short-circuits before assistant emit
    expect(events.some((e) => e.type === 'assistant')).toBe(false);
  });

  test('model_error returns after provider_call stage, before tool dispatch', async () => {
    const agent = new CoreAgent({
      context: ctx([echoTool], throwingProvider(Object.assign(new Error('x'), { status: 401 }))),
      retry: { maxRetries: 0, sleep: async () => {} },
    });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const stages = events.filter((e) => e.type === 'stage').map((e) => (e as { stage: string }).stage);
    expect(stages).toContain('provider_call');
    expect(stages).not.toContain('dispatch_tools');
  });
});

// ─── abort during tools → aborted_tools ──────────────────────────────────────

describe('LOOP abort during tools (stage5 → aborted_tools)', () => {
  test('signal aborts while a tool runs → done(aborted_tools) after tool_result', async () => {
    // Provider always returns a tool_use so the loop reaches stage5 every turn.
    const provider = scriptedProvider([[asstWithToolUse('t1', 'slow', {})]]);
    let agentRef: CoreAgent | null = null;
    const slowTool = buildTool({
      name: 'slow',
      // not concurrency-safe → runs serially as its own batch
      call: async (i: unknown) => {
        agentRef!.abort('user-interrupt'); // latch abort during tool execution
        return { data: i };
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const agent = new CoreAgent({ context: ctx([slowTool], provider) });
    agentRef = agent;
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    // tool_result still emitted (dispatch completed the in-flight batch)
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    // turn_aborted then done(aborted_tools)
    expect(events.some((e) => e.type === 'turn_aborted')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_tools');
  });
});

// ─── handoff_decision 续轮 (multi-turn) ──────────────────────────────────────

describe('LOOP handoff_decision — continues to next turn', () => {
  test('turn 0 dispatches tools, turn 1 ends → handoff_decision emitted on turn 0', async () => {
    const provider = scriptedProvider([
      [asstWithToolUse('t1', 'echo', { v: 1 })], // turn 0 → tools → continue
      [asstText('done')], // turn 1 → end_turn → complete
    ]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    const handoff = events.filter(
      (e) => e.type === 'stage' && (e as { stage: string }).stage === 'handoff_decision',
    );
    expect(handoff.length).toBe(1);
    expect(handoff[0]).toMatchObject({ turn: 0 });

    // two distinct turns ran
    const turnStarts = events.filter((e) => e.type === 'turn_start');
    expect(turnStarts.length).toBe(2);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });
});

// ─── turn_aborted with turn > 0 (top-of-loop guard) ──────────────────────────

describe('LOOP turn_aborted (turn>0)', () => {
  test('abort at turn-0 handoff boundary → top-of-loop guard fires turn_aborted{turn:1} + aborted_streaming', async () => {
    // Turn 0 dispatches a tool then reaches stage7 (handoff_decision). Aborting from
    // the consumer exactly when the handoff_decision event arrives lands the abort on
    // the boundary between turn 0's handoff and turn 1's top-of-loop guard (line 185),
    // which is the only place a turn_aborted with turn>0 + aborted_streaming is emitted.
    const provider = scriptedProvider([
      [asstWithToolUse('t1', 'echo', {})], // turn 0 → tools → continue
      [asstText('unreached')], // turn 1 would run but is pre-empted by the guard
    ]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });

    const events: AgentEvent[] = [];
    for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      events.push(e);
      if (e.type === 'stage' && e.stage === 'handoff_decision') agent.abort('at-handoff');
    }

    const aborted = events.filter((e) => e.type === 'turn_aborted') as Array<{ turn: number }>;
    expect(aborted.length).toBe(1);
    expect(aborted[0].turn).toBe(1); // top-of-loop guard, turn>0
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_streaming');
  });
});

// ─── mid-stream abort → catch → aborted_streaming ────────────────────────────

describe('LOOP abort during streaming (catch → aborted_streaming)', () => {
  test('signal aborted then stream throws → done(aborted_streaming), not model_error', async () => {
    let agentRef: CoreAgent | null = null;
    const provider = abortMidStreamProvider(() => {
      agentRef!.abort('mid-stream'); // latch abort before the throw
    });
    const agent = new CoreAgent({
      context: ctx([echoTool], provider),
      retry: { maxRetries: 0, sleep: async () => {} },
    });
    agentRef = agent;
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    expect(events.some((e) => e.type === 'turn_aborted')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_streaming');
  });
});

// ─── leadingSystemText (function form) + mergeSignals onAbort ────────────────

describe('LOOP leadingSystemText + merged external signal', () => {
  test('leadingSystemText as a function is resolved each turn (render closure)', async () => {
    let calls = 0;
    const provider = scriptedProvider([[asstText('hi')]]);
    const context: AgentContext = {
      agentId: 'lead',
      provider,
      config: {
        systemPromptSlots: [],
        model: 'm',
        tools: [echoTool],
        maxTurns: 4,
        leadingSystemText: () => {
          calls++;
          return 'SOUL-PREAMBLE';
        },
      },
      toolContext: {},
    };
    const agent = new CoreAgent({ context });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    expect(calls).toBeGreaterThan(0); // resolveLeading invoked the function form
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('external signal abort during a tool turn → merged onAbort fires → aborted', async () => {
    const external = new AbortController();
    const provider = scriptedProvider([[asstWithToolUse('t1', 'abortme', {})]]);
    const tool = buildTool({
      name: 'abortme',
      call: async (i: unknown) => {
        external.abort('external'); // abort the EXTERNAL signal → mergeSignals onAbort
        return { data: i };
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const agent = new CoreAgent({ context: ctx([tool], provider) });
    const events = await collect(agent, {
      input: { type: 'user', payload: 'hi', ts: 0 },
      signal: external.signal,
    });
    expect(events.some((e) => e.type === 'turn_aborted')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_tools');
  });
});

// ─── pre-aborted signal on entry → interrupt fast-path ───────────────────────

describe('LOOP pre-aborted signal on entry', () => {
  test('signal already aborted → immediate turn_aborted{0} + done(aborted_streaming)', async () => {
    const external = new AbortController();
    external.abort('already');
    const provider = scriptedProvider([[asstText('never')]]);
    const agent = new CoreAgent({ context: ctx([echoTool], provider) });
    const events = await collect(agent, {
      input: { type: 'user', payload: 'hi', ts: 0 },
      signal: external.signal,
    });
    expect(events[0]).toMatchObject({ type: 'turn_aborted', turn: 0 });
    expect(events.some((e) => e.type === 'stream')).toBe(false); // never hit LLM
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('aborted_streaming');
  });
});
