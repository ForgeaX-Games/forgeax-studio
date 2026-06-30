/**
 * Loop-level e2e:验证 CoreAgent.run 把 hook 生命周期事件
 * (SessionStart/SessionEnd · UserPromptSubmit · PostToolUse · Stop · PreCompact)
 * 真实接进 EventBus,且 hook 决议(ctl.modify 改写结果 / additionalContext 注入 /
 * continue:false 优雅停)对 loop 产生预期作用。复用 loop-recovery-e2e 的 fake-provider 范式。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import { buildTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { CompactionStrategy } from '../src/context/types';
import type { LLMProvider, ProviderStreamEvent, ProviderMessage, Usage, StopReason } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

type Block = { type: string; [k: string]: unknown };
function asst(content: Block[], stopReason: StopReason, inputTokens = 0, outputTokens = 0): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    usage: { ...EMPTY_USAGE, inputTokens, outputTokens } as Usage,
    stopReason,
  };
}
const txt = (t: string): Block[] => [{ type: 'text', text: t }];
const tu = (id: string, name: string, input: unknown): Block[] => [{ type: 'tool_use', id, name, input }];

type Handler = () => ProviderStreamEvent[] | { throw: unknown };
function mkProvider(handlers: Handler[]): {
  provider: LLMProvider;
  reqMessages: ProviderMessage[][];
  reqSystems: unknown[];
  calls: () => number;
} {
  const reqMessages: ProviderMessage[][] = [];
  const reqSystems: unknown[] = [];
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req) {
      reqMessages.push(req.messages);
      reqSystems.push(req.system);
      const h = handlers[Math.min(call, handlers.length - 1)];
      call++;
      const r = h();
      if (r && !Array.isArray(r) && 'throw' in r) throw (r as { throw: unknown }).throw;
      for (const ev of r as ProviderStreamEvent[]) yield ev;
    },
  };
  return { provider, reqMessages, reqSystems, calls: () => call };
}

function ctx(tools: Parameters<typeof buildTool>[0][], prov: LLMProvider, extra: Record<string, unknown> = {}): AgentContext {
  return {
    agentId: 'a',
    provider: prov,
    config: { systemPromptSlots: [], model: 'm', tools: tools as never, maxTurns: 12, ...extra },
    toolContext: {},
  };
}
async function run(agent: CoreAgent, payload: unknown = 'hi'): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload, ts: 0 } })) out.push(e);
  return out;
}
function lastDone(evs: AgentEvent[]): string | undefined {
  const d = evs.at(-1);
  return d && d.type === 'done' ? d.terminal.reason : undefined;
}

const echoTool = () =>
  buildTool({
    name: 'echo',
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    inputJSONSchema: { type: 'object', properties: { x: { type: 'string' } } },
    call: async (i: { x: string }) => ({ data: { result: i.x } }),
    mapResult: (o, id) => ({ type: 'tool.result', payload: { toolUseId: id, result: o }, ts: 0 }),
    maxResultSizeChars: 10_000,
  });

describe('hook lifecycle e2e', () => {
  // (a) PostToolUse:订阅者能看到 toolName + result,并用 ctl.modify 改写/标记结果 ───
  test('PostToolUse 订阅者见 toolName+result,ctl.modify 改写结果回灌模型', async () => {
    const bus = new EventBus();
    const seen: Array<{ toolName?: string; result?: unknown; isError?: boolean }> = [];
    bus.subscribe(CoreEventType.ToolCallResult, (e, ctl) => {
      const p = e.payload as { toolName?: string; result?: unknown; isError?: boolean };
      seen.push({ toolName: p.toolName, result: p.result, isError: p.isError });
      // 改写结果 + 置 isError(模拟 PostToolUse hook 校验失败标记)。
      return ctl.modify({ payload: { ...p, result: { flagged: true }, isError: true } } as never);
    });
    const { provider, reqMessages } = mkProvider([
      () => [asst(tu('t1', 'echo', { x: 'hello' }), 'tool_use')],
      () => [asst(txt('ok'), 'end_turn')],
    ]);
    const agent = new CoreAgent({ context: ctx([echoTool()], provider), bus });
    const evs = await run(agent);
    expect(lastDone(evs)).toBe('completed');
    // 订阅者确实看到了 toolName + 原始 result。
    expect(seen.length).toBe(1);
    expect(seen[0].toolName).toBe('echo');
    expect(seen[0].result).toBeDefined();
    // 改写后的结果回灌进了下一轮 provider 请求(tool_result content)。
    expect(JSON.stringify(reqMessages[1])).toContain('flagged');
    // yield 出去的 tool_result 也被改写(loop 回写 r.result)。
    const tr = evs.find((e) => e.type === 'tool_result');
    expect(JSON.stringify(tr)).toContain('flagged');
  });

  // (b) UserPromptSubmit hook 的 additionalContext 出现在下一轮 provider 请求消息里 ───
  test('UserPromptSubmit additionalContext 注入下一轮请求', async () => {
    const bus = new EventBus();
    bus.subscribe(CoreEventType.UserPromptSubmit, (_e, ctl) =>
      ctl.modify({ additionalContext: 'REMEMBER-THIS-FACT' } as never),
    );
    const { provider, reqSystems } = mkProvider([() => [asst(txt('done'), 'end_turn')]]);
    const agent = new CoreAgent({ context: ctx([], provider), bus });
    const evs = await run(agent);
    expect(lastDone(evs)).toBe('completed');
    // additionalContext 作 system-reminder slot 进了 turn0 的 system prompt(req.system)。
    expect(JSON.stringify(reqSystems[0])).toContain('REMEMBER-THIS-FACT');
  });

  // (c) SessionStart 与 SessionEnd 各触发恰好一次 ──────────────────────────────
  test('SessionStart / SessionEnd 各恰好一次', async () => {
    const bus = new EventBus();
    let starts = 0;
    let ends = 0;
    let endReason: string | undefined;
    bus.subscribe(CoreEventType.SessionStart, () => {
      starts++;
    });
    bus.subscribe(CoreEventType.SessionEnd, (e) => {
      ends++;
      endReason = (e.payload as { reason?: string }).reason;
    });
    const { provider } = mkProvider([
      () => [asst(tu('t1', 'echo', { x: 'a' }), 'tool_use')],
      () => [asst(txt('finished'), 'end_turn')],
    ]);
    const agent = new CoreAgent({ context: ctx([echoTool()], provider), bus });
    const evs = await run(agent);
    expect(lastDone(evs)).toBe('completed');
    expect(starts).toBe(1);
    expect(ends).toBe(1);
    expect(endReason).toBe('completed');
  });

  test('SessionEnd reason 反映非 completed 终态(maxContinuations 触底 → stop_hook_prevented)', async () => {
    const bus = new EventBus();
    let endReason: string | undefined;
    bus.subscribe(CoreEventType.SessionEnd, (e) => {
      endReason = (e.payload as { reason?: string }).reason;
    });
    bus.subscribe(CoreEventType.Stop, (_e, ctl) => ctl.modify({ preventStop: true, reason: 'go on' } as never));
    const { provider } = mkProvider([() => [asst(txt('x'), 'end_turn')]]);
    const agent = new CoreAgent({ context: ctx([], provider), bus, maxContinuations: 2 });
    const evs = await run(agent);
    expect(lastDone(evs)).toBe('stop_hook_prevented');
    expect(endReason).toBe('stop_hook_prevented');
  });

  // (d) Stop hook:preventStop 驱动续轮;触 maxContinuations → stop_hook_prevented ──
  test('Stop preventStop → 续轮;放行后完成', async () => {
    const bus = new EventBus();
    let fired = 0;
    bus.subscribe(CoreEventType.Stop, (_e, ctl) => {
      fired++;
      if (fired === 1) return ctl.modify({ preventStop: true, reason: 'keep going' } as never);
      return undefined;
    });
    const { provider, reqMessages } = mkProvider([
      () => [asst(txt('first'), 'end_turn')],
      () => [asst(txt('second'), 'end_turn')],
    ]);
    const agent = new CoreAgent({ context: ctx([], provider), bus });
    const evs = await run(agent);
    expect(fired).toBeGreaterThanOrEqual(2);
    expect(lastDone(evs)).toBe('completed');
    expect(JSON.stringify(reqMessages[1])).toContain('keep going');
  });

  test('Stop 反复 preventStop 触 maxContinuations → stop_hook_prevented', async () => {
    const bus = new EventBus();
    bus.subscribe(CoreEventType.Stop, (_e, ctl) => ctl.modify({ preventStop: true, reason: 'never' } as never));
    const { provider } = mkProvider([() => [asst(txt('x'), 'end_turn')]]);
    const agent = new CoreAgent({ context: ctx([], provider), bus, maxContinuations: 2 });
    const evs = await run(agent);
    expect(lastDone(evs)).toBe('stop_hook_prevented');
  });

  // (d') Stop hook continue:false(continueLoop===false) → 优雅停(不被 preventStop 续) ──
  test('Stop continue:false → 优雅停(完成)', async () => {
    const bus = new EventBus();
    // 同时设 preventStop:true 与 continueLoop:false:continue:false 优先,直接停。
    bus.subscribe(CoreEventType.Stop, (_e, ctl) =>
      ctl.modify({ preventStop: true, continueLoop: false } as never),
    );
    const { provider, calls } = mkProvider([() => [asst(txt('only'), 'end_turn')]]);
    const agent = new CoreAgent({ context: ctx([], provider), bus });
    const evs = await run(agent);
    expect(calls()).toBe(1); // 未续轮
    expect(lastDone(evs)).toBe('completed');
  });

  // (e) PreCompact 在压缩前触发(always-compact 策略) + PostCompact 紧随 ──────────
  test('PreCompact 在 compaction 前触发,PostCompact 紧随其后', async () => {
    const order: string[] = [];
    const bus = new EventBus();
    bus.subscribe(CoreEventType.PreCompact, (e) => {
      const p = e.payload as { trigger?: string; tokenCount?: number };
      order.push(`pre(${p.trigger})`);
    });
    bus.subscribe(CoreEventType.CompactionApplied, () => {
      order.push('applied');
    });
    bus.subscribe(CoreEventType.PostCompact, () => {
      order.push('post');
    });
    let compacted = 0;
    const compaction: CompactionStrategy = {
      name: 'always',
      shouldCompact: () => true, // always-compact
      async compact() {
        compacted++;
        return { replacement: { role: 'user', content: 'summary' }, coveredFrom: 0, coveredTo: 0 };
      },
    };
    const { provider } = mkProvider([() => [asst(txt('done'), 'end_turn')]]);
    const agent = new CoreAgent({ context: ctx([], provider), bus, compaction });
    const evs = await run(agent);
    expect(lastDone(evs)).toBe('completed');
    expect(compacted).toBeGreaterThanOrEqual(1);
    // PreCompact 必须在 CompactionApplied 之前,PostCompact 在其后。
    expect(order[0]).toBe('pre(auto)');
    expect(order.indexOf('pre(auto)')).toBeLessThan(order.indexOf('applied'));
    expect(order.indexOf('applied')).toBeLessThan(order.indexOf('post'));
  });
});
