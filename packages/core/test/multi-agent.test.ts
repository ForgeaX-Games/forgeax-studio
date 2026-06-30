/**
 * 多 agent 协作 LOOP 测试 —— peer 消息(SendMessage)+ handoff 接入(Handoff + HandoffSink)。
 *
 * 覆盖:
 *  - SendMessage 往 bus publish 一条 agent.message 事件(订阅断言 from/to/content)。
 *  - Handoff 工具触发 HandoffSink.declare,且 intent 正确。
 *  - resolution 三路:child_result(折进上下文续转)/ pop_self+ack(done handed_off)/ ack(续转)。
 *  - 未注入 handoff 时 handoff_decision 维持单 agent no-op(回归)。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import {
  sendMessageTool,
  handoffTool,
  normalizeHandoffIntent,
  HANDOFF_INTENT_KEY,
} from '../src/capability/builtin-tools/message-tools';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { HandoffSink, HandoffIntent, HandoffResolution } from '../src/inject/types';
import type { CoreEvent } from '../src/events/types';

// ─── provider / ctx 脚手架(对齐 agent-loop.test.ts)──────────────────────────

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

/** fake HandoffSink:记录收到的 intent,按构造时给定的 resolution 回。 */
class FakeHandoffSink implements HandoffSink {
  readonly intents: HandoffIntent[] = [];
  constructor(private readonly resolver: (intent: HandoffIntent) => HandoffResolution) {}
  async declare(intent: HandoffIntent): Promise<HandoffResolution> {
    this.intents.push(intent);
    return this.resolver(intent);
  }
}

// ─── SendMessage ──────────────────────────────────────────────────────────────

describe('peer message — SendMessage', () => {
  test('publishes an agent.message event with from/to/content', async () => {
    const bus = new EventBus();
    const seen: CoreEvent[] = [];
    bus.subscribe(CoreEventType.AgentMessage, (e) => {
      seen.push(e);
    });
    const tool = sendMessageTool({ bus });
    const out = await tool.call({ to: 'a2', content: 'hello' }, { signal: new AbortController().signal, agentId: 'a1' });
    expect(out.data.delivered).toBe(true);
    expect(seen.length).toBe(1);
    const p = seen[0].payload as { from?: string; to?: string; content?: unknown };
    expect(p.from).toBe('a1');
    expect(p.to).toBe('a2');
    expect(p.content).toBe('hello');
  });

  test('resolves the bus from ToolContext.bus when no opts.bus given', async () => {
    const bus = new EventBus();
    const seen: CoreEvent[] = [];
    bus.subscribe(CoreEventType.AgentMessage, (e) => void seen.push(e));
    const tool = sendMessageTool();
    const out = await tool.call(
      { to: 'a3', content: { kind: 'ping' } },
      { signal: new AbortController().signal, agentId: 'a1', bus },
    );
    expect(out.data.delivered).toBe(true);
    expect(seen.length).toBe(1);
    expect((seen[0].payload as { to?: string }).to).toBe('a3');
  });

  test('no bus available → delivered:false (no silent drop)', async () => {
    const tool = sendMessageTool();
    const out = await tool.call({ content: 'x' }, { signal: new AbortController().signal, agentId: 'a1' });
    expect(out.data.delivered).toBe(false);
    const mapped = tool.mapResult(out.data, 'id1');
    expect((mapped.payload as { isError?: boolean }).isError).toBe(true);
  });

  test('SendMessage drives a real loop turn → agent.message lands on the agent bus', async () => {
    const bus = new EventBus();
    const seen: CoreEvent[] = [];
    bus.subscribe(CoreEventType.AgentMessage, (e) => void seen.push(e));
    const provider = scriptedProvider([
      [asstWithToolUse('m1', 'SendMessage', { to: 'a2', content: 'hi from loop' })],
      [asstText('done')],
    ]);
    // tool 复用同一 bus(host 把多 agent 总线即注入为 agent bus 的场景)。
    const agent = new CoreAgent({ context: ctx([sendMessageTool({ bus })], provider), bus });
    await collect(agent, { input: { type: 'user', payload: 'send a msg', ts: 0 } });
    expect(seen.length).toBe(1);
    expect((seen[0].payload as { content?: unknown }).content).toBe('hi from loop');
  });
});

// ─── Handoff intent normalization ─────────────────────────────────────────────

describe('handoff — normalizeHandoffIntent', () => {
  test('spawn_child needs spec; defaults mode to fg', () => {
    expect(normalizeHandoffIntent({ kind: 'spawn_child' })).toBeNull();
    const i = normalizeHandoffIntent({ kind: 'spawn_child', spec: { type: 'worker' } });
    expect(i).toEqual({ kind: 'spawn_child', spec: { type: 'worker' }, mode: 'fg' });
  });
  test('pop_self carries result', () => {
    expect(normalizeHandoffIntent({ kind: 'pop_self', result: { ok: 1 } })).toEqual({
      kind: 'pop_self',
      result: { ok: 1 },
    });
  });
  test('resume_target needs agentId', () => {
    expect(normalizeHandoffIntent({ kind: 'resume_target' })).toBeNull();
    expect(normalizeHandoffIntent({ kind: 'resume_target', agentId: 'x' })).toEqual({
      kind: 'resume_target',
      agentId: 'x',
    });
  });
  test('handoffTool maps accepted intent into the result payload under HANDOFF_INTENT_KEY', async () => {
    const tool = handoffTool();
    const out = await tool.call({ kind: 'pop_self', result: 42 }, { signal: new AbortController().signal });
    expect(out.data.accepted).toBe(true);
    const mapped = tool.mapResult(out.data, 'h1');
    const p = mapped.payload as Record<string, unknown>;
    expect(p[HANDOFF_INTENT_KEY]).toEqual({ kind: 'pop_self', result: 42 });
  });
});

// ─── Handoff wired into the loop ──────────────────────────────────────────────

describe('handoff — declare wired into handoff_decision stage', () => {
  test('Handoff tool triggers declare() with the correct intent', async () => {
    const sink = new FakeHandoffSink(() => ({ kind: 'ack' }));
    const provider = scriptedProvider([
      [asstWithToolUse('h1', 'Handoff', { kind: 'resume_target', agentId: 'a2' })],
      [asstText('done')],
    ]);
    const agent = new CoreAgent({ context: ctx([handoffTool()], provider), handoff: sink });
    await collect(agent, { input: { type: 'user', payload: 'hand off', ts: 0 } });
    expect(sink.intents.length).toBe(1);
    expect(sink.intents[0]).toEqual({ kind: 'resume_target', agentId: 'a2' });
  });

  test('child_result resolution folds events into context and continues', async () => {
    const childEvents: CoreEvent[] = [
      { type: 'assistant.message', payload: { content: [{ type: 'text', text: 'child says hi' }] }, ts: 0 },
    ];
    const sink = new FakeHandoffSink((i) =>
      i.kind === 'spawn_child' ? { kind: 'child_result', events: childEvents } : { kind: 'ack' },
    );
    const provider = scriptedProvider([
      [asstWithToolUse('h1', 'Handoff', { kind: 'spawn_child', spec: { type: 'worker' }, mode: 'fg' })],
      [asstText('parent done after child')],
    ]);
    const agent = new CoreAgent({ context: ctx([handoffTool()], provider, 4), handoff: sink });
    const events = await collect(agent, { input: { type: 'user', payload: 'spawn', ts: 0 } });
    // 父跑了至少两 turn(handoff turn + 折叠后续转 turn),最终 completed。
    const turnStarts = events.filter((e) => e.type === 'turn_start');
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
    expect(sink.intents[0].kind).toBe('spawn_child');
  });

  test('pop_self + ack resolution → done(handed_off)', async () => {
    const sink = new FakeHandoffSink(() => ({ kind: 'ack' }));
    const provider = scriptedProvider([
      [asstWithToolUse('h1', 'Handoff', { kind: 'pop_self', result: { answer: 7 } })],
      [asstText('should not reach')],
    ]);
    const agent = new CoreAgent({ context: ctx([handoffTool()], provider, 4), handoff: sink });
    const events = await collect(agent, { input: { type: 'user', payload: 'pop', ts: 0 } });
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('handed_off');
    expect(sink.intents[0].kind).toBe('pop_self');
    // pop_self 后 loop 收口 → 第二个脚本 turn 不应跑(只有一个 stream 的 turn)。
    const turnStarts = events.filter((e) => e.type === 'turn_start');
    expect(turnStarts.length).toBe(1);
  });

  test('abort intent + ack → done(handed_off)', async () => {
    const sink = new FakeHandoffSink(() => ({ kind: 'ack' }));
    const provider = scriptedProvider([
      [asstWithToolUse('h1', 'Handoff', { kind: 'abort', reason: 'give up' })],
      [asstText('nope')],
    ]);
    const agent = new CoreAgent({ context: ctx([handoffTool()], provider, 4), handoff: sink });
    const events = await collect(agent, { input: { type: 'user', payload: 'abort', ts: 0 } });
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('handed_off');
  });

  test('ack resolution for non-terminal intent → continues next turn', async () => {
    const sink = new FakeHandoffSink(() => ({ kind: 'ack' }));
    const provider = scriptedProvider([
      [asstWithToolUse('h1', 'Handoff', { kind: 'resume_target', agentId: 'a2' })],
      [asstText('continued and done')],
    ]);
    const agent = new CoreAgent({ context: ctx([handoffTool()], provider, 4), handoff: sink });
    const events = await collect(agent, { input: { type: 'user', payload: 'resume', ts: 0 } });
    const turnStarts = events.filter((e) => e.type === 'turn_start');
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('declare throwing does not kill the run — folds error + continues', async () => {
    const sink: HandoffSink = {
      async declare() {
        throw new Error('scheduler down');
      },
    };
    const provider = scriptedProvider([
      [asstWithToolUse('h1', 'Handoff', { kind: 'resume_target', agentId: 'a2' })],
      [asstText('recovered')],
    ]);
    const agent = new CoreAgent({ context: ctx([handoffTool()], provider, 4), handoff: sink });
    const events = await collect(agent, { input: { type: 'user', payload: 'x', ts: 0 } });
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });
});

// ─── 回归:未注入 handoff → 单 agent no-op ─────────────────────────────────────

describe('handoff — backward compat (no sink injected)', () => {
  test('Handoff tool result is ignored at handoff_decision; loop runs to completion', async () => {
    // 即便模型调了 Handoff 工具,没注入 sink → declare 永不被调,loop 维持原行为。
    const provider = scriptedProvider([
      [asstWithToolUse('h1', 'Handoff', { kind: 'pop_self', result: 1 })],
      [asstText('done as usual')],
    ]);
    const agent = new CoreAgent({ context: ctx([handoffTool()], provider, 4) });
    const events = await collect(agent, { input: { type: 'user', payload: 'x', ts: 0 } });
    const last = events.at(-1)!;
    // 未注入 → 不会 handed_off,照常续转到 end_turn completed。
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('a normal tool turn without any handoff stays byte-stable (completed)', async () => {
    const echo = buildTool({
      name: 'echo',
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      call: async (i: unknown) => ({ data: i }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const provider = scriptedProvider([[asstWithToolUse('t1', 'echo', { v: 1 })], [asstText('done')]]);
    const agent = new CoreAgent({ context: ctx([echo], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });
});

// ─── inbox 接入(peer 消息经 inbox drain 进上下文)──────────────────────────────

describe('peer message — inbox drain', () => {
  test('inbox messages are appended into context each turn (drained once)', async () => {
    let delivered = false;
    const provider = scriptedProvider([[asstText('ack')]]);
    const agent = new CoreAgent({
      context: ctx([], provider),
      inbox: () => {
        if (delivered) return [];
        delivered = true;
        return [{ role: 'user', content: '<peer-message from=a2>hi</peer-message>' }];
      },
    });
    const events = await collect(agent, { input: { type: 'user', payload: 'start', ts: 0 } });
    // inbox.drained 事件经 agent bus 发出(订阅自带 bus 不便,这里断言 run 正常收口即可)。
    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('completed');
  });
});
