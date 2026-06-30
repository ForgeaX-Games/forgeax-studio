/**
 * Resume/replay 回放链路测试(设计稿 §3.8.7 / §6.1)。
 *
 * 覆盖:
 *  - foldFromStore:store 事件流 → provider messages(user/assistant/tool_result)。
 *  - 含 compaction.applied 的回放(坐标系从「会话消息下标」对齐到 byEventId)。
 *  - createAgentResumed:append 一串事件 → 新 createAgentResumed({resume,store}) →
 *    回放的历史经 provider.stream 的 req.messages 验证被正确重建。
 *  - 空 store / 不 resume → seed 为空(行为与不回放一致)。
 */
import { test, expect, describe } from 'bun:test';
import { createAgent, createAgentResumed } from '../src/runtime/run';
import { InMemoryEventStore } from '../src/history/event-store';
import { foldFromStore } from '../src/history/llm-fold-adapter';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent } from '../src/events/types';
import type { AgentContext } from '../src/agent/types';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderMessage,
  Usage,
} from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── 事件构造助手(payload 形状对齐 events.ts / loop 真实落盘)──────────────
function userSubmit(prompt: string, turn = 0): CoreEvent {
  return { type: CoreEventType.UserPromptSubmit, payload: { prompt, turn }, ts: 0 };
}
function asst(content: unknown): CoreEvent {
  return { type: 'assistant.message', payload: { role: 'assistant', content }, ts: 0 };
}
function toolResult(toolUseId: string, result: unknown, isError = false): CoreEvent {
  return {
    type: CoreEventType.ToolCallResult,
    payload: { toolUseId, toolName: 'echo', result, isError },
    ts: 0,
  };
}
function compactionApplied(coveredFrom: number, coveredTo: number, replacement: ProviderMessage): CoreEvent {
  return { type: CoreEventType.CompactionApplied, payload: { coveredFrom, coveredTo, replacement }, ts: 0 };
}
/** 噪声事件(turn 生命周期等)——必须被 fold 跳过。 */
function noise(type: string): CoreEvent {
  return { type, payload: { turn: 0 }, ts: 0 };
}

// ─── 一个记录 req.messages 的 stub provider(用于端到端验证 seed 真进了上下文)─
function recordingProvider(): { provider: LLMProvider; lastMessages: () => ProviderMessage[] } {
  let captured: ProviderMessage[] = [];
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
      captured = req.messages;
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
  return { provider, lastMessages: () => captured };
}

function ctx(provider: LLMProvider): AgentContext {
  return {
    agentId: 'replay-1',
    provider,
    config: { systemPromptSlots: [], model: 'm', tools: [], maxTurns: 4 },
    toolContext: {},
  };
}

describe('foldFromStore — 事件流 → provider messages', () => {
  test('user / assistant / tool_result 按序重建', () => {
    const events = [
      noise('turn.start'),
      userSubmit('hello'),
      asst([{ type: 'text', text: 'hi there' }]),
      asst([{ type: 'tool_use', id: 't1', name: 'echo', input: { x: 1 } }]),
      toolResult('t1', { stdout: 'echoed' }),
      noise('turn.end'),
    ];
    const msgs = foldFromStore(events);
    expect(msgs).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { x: 1 } }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'echoed', is_error: false }],
      },
    ]);
  });

  test('tool_result 对象 payload 规整成字符串(避免回灌 400)', () => {
    const msgs = foldFromStore([toolResult('t9', { data: { nested: true } }, true)]);
    expect(msgs).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't9', content: JSON.stringify({ data: { nested: true } }), is_error: true },
        ],
      },
    ]);
  });

  test('空流 → 空数组', () => {
    expect(foldFromStore([])).toEqual([]);
    expect(foldFromStore([noise('turn.start'), noise('session.start')])).toEqual([]);
  });

  test('compaction.applied 折叠会话消息下标区间(坐标系对齐)', () => {
    // 派生 messages 序:0=user('a') 1=asst 2=tool_result 3=user('b')
    // 压缩覆盖 [0,2] → 折成一条 summary,后续 user('b') 保留。
    const summary: ProviderMessage = { role: 'user', content: '[compacted 3 messages]' };
    const events = [
      userSubmit('a'),
      asst([{ type: 'tool_use', id: 't1', name: 'echo', input: {} }]),
      toolResult('t1', 'r1'),
      userSubmit('b', 1),
      compactionApplied(0, 2, summary),
    ];
    const msgs = foldFromStore(events);
    expect(msgs).toEqual([summary, { role: 'user', content: 'b' }]);
  });
});

describe('实时 WAL 捕获 assistant 轮(loop publish assistant.message)', () => {
  test('真 loop 跑一轮 → assistant.message 经 bus 落 store → resume 重建 user+assistant', async () => {
    // 缺环回归:此前 loop 只 yield assistant 不 publish,connectStore 的 WAL 只记 user/tool,
    // resume 丢 assistant 轮。本例验「loop publish assistant.message」修复后实时 WAL 闭环。
    const store = new InMemoryEventStore();
    const rec1 = recordingProvider();
    const a1 = createAgent({ context: ctx(rec1.provider), store }); // autoConnectStore 默认接 WAL
    for await (const _ of a1.agent.run({ input: { type: 'user', payload: 'hello-live', ts: 0 } })) void _;

    const captured = store.snapshot();
    // 关键断言:store 里既有 user 轮也有 assistant 轮(后者是本次修复点)。
    expect(captured.some((e) => e.type === CoreEventType.UserPromptSubmit)).toBe(true);
    expect(captured.some((e) => e.type === 'assistant.message')).toBe(true);

    // resume:新 agent 从同 store 回放 → req.messages 含上一轮 user + assistant。
    const rec2 = recordingProvider();
    const a2 = await createAgentResumed({ context: ctx(rec2.provider), store, resume: true });
    for await (const _ of a2.agent.run({ input: { type: 'user', payload: 'next', ts: 0 } })) void _;
    const seeded = JSON.stringify(rec2.lastMessages());
    expect(seeded).toContain('hello-live'); // 上一轮 user
    expect(seeded).toContain('ok'); // 上一轮 assistant 文本(recordingProvider 回 'ok')
  });
});

describe('createAgentResumed — 开机回放', () => {
  test('append 事件 → resume 重建历史 → 进 provider req.messages', async () => {
    const store = new InMemoryEventStore();
    await store.append([
      userSubmit('past question'),
      asst([{ type: 'text', text: 'past answer' }]),
    ]);

    const { provider, lastMessages } = recordingProvider();
    const { agent } = await createAgentResumed({ context: ctx(provider), store, resume: true });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'new question', ts: 0 } })) {
      // drain 一轮
    }

    const sent = lastMessages();
    // 回放历史在前,本轮 user 输入在后。
    expect(sent).toEqual([
      { role: 'user', content: 'past question' },
      { role: 'assistant', content: [{ type: 'text', text: 'past answer' }] },
      { role: 'user', content: 'new question' },
    ]);
  });

  test('含 compaction 的回放 seed 正确进上下文', async () => {
    const store = new InMemoryEventStore();
    const summary: ProviderMessage = { role: 'user', content: '[earlier turns summarized]' };
    await store.append([
      userSubmit('q1'),
      asst([{ type: 'text', text: 'a1' }]),
      compactionApplied(0, 1, summary), // 折叠前两条
      userSubmit('q2', 1),
    ]);

    const { provider, lastMessages } = recordingProvider();
    const { agent } = await createAgentResumed({ context: ctx(provider), store, resume: true });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'q3', ts: 0 } })) {
      // drain
    }

    expect(lastMessages()).toEqual([
      summary,
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
    ]);
  });

  test('空 store + resume → seed 空(仅本轮 user)', async () => {
    const store = new InMemoryEventStore();
    const { provider, lastMessages } = recordingProvider();
    const { agent } = await createAgentResumed({ context: ctx(provider), store, resume: true });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'only', ts: 0 } })) {
      // drain
    }
    expect(lastMessages()).toEqual([{ role: 'user', content: 'only' }]);
  });

  test('resume:false → 不读 store(历史不回灌)', async () => {
    const store = new InMemoryEventStore();
    await store.append([userSubmit('should not appear'), asst([{ type: 'text', text: 'nope' }])]);
    const { provider, lastMessages } = recordingProvider();
    const { agent } = await createAgentResumed({ context: ctx(provider), store, resume: false });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'fresh', ts: 0 } })) {
      // drain
    }
    expect(lastMessages()).toEqual([{ role: 'user', content: 'fresh' }]);
  });

  test('同步 createAgent 行为不变(不回放,纯函数式 §6.5)', async () => {
    const store = new InMemoryEventStore();
    await store.append([userSubmit('history'), asst([{ type: 'text', text: 'old' }])]);
    const { provider, lastMessages } = recordingProvider();
    const { agent } = createAgent({ context: ctx(provider), store });
    for await (const _ of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      // drain
    }
    expect(lastMessages()).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
