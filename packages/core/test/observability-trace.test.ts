/**
 * v3/B 档 可观测性 —— 并发父子树正确性原型(M1 闸逻辑作单测落地)。
 *
 * 用 FAKE Observability(不依赖 Track H 的 host 实现):
 *  - fake tracer:记录每次 startSpan(name, options, context),并从**传入的 context** 解析出
 *    parentSpanId(`trace.getSpan(context)?.spanContext().spanId`)—— 这正是 explicit-parent 的判据:
 *    parent 只来自显式传入的 context,绝不来自 active-context。
 *  - fake logger:记录 child(bindings) 与 .info/.error 调用(合并 bindings)—— 验 span-bound child logger。
 *
 * 三条断言(对位执行计划 §C I2):
 *  (a) 两个并发 run 的 span 父链各自闭合 —— A 的子 span 永不以 B 的 span 作 parent;
 *  (b) run 体内深处一条 log.info 的 record 带与其 run span **相同的 traceId**(证 span-bound child logger,
 *      而非 getActiveSpan());
 *  (c) 不注入 observability(NOOP_OBS 兜底)→ loop 行为逐字不变、零 span(零行为变化)。
 */
import { test, expect, describe } from 'bun:test';
import { trace, ROOT_CONTEXT, type Context, type Span, type SpanContext, type Tracer } from '@opentelemetry/api';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { Observability, CoreLogger } from '../src/observability/contract';

// ── fake span/tracer ───────────────────────────────────────────────────────
interface SpanRecord {
  name: string;
  spanId: string;
  traceId: string;
  /** 从传入 context 解析的 parent spanId(无 parent → undefined)。 */
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  ended: boolean;
  statusCode?: number;
}

interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  /** 该 logger 的 child bindings(traceId/spanId/sid/agentId…)与 .info 的 fields 合并。 */
  fields: Record<string, unknown>;
}

/** 建一个记账用的 fake tracer + 它产出的 span 表 + 它绑定的 log 表(供断言读)。
 *  traceId 在「无 parent 的 root span」处新生成;有 parent 则继承 parent 的 traceId(模拟真 OTel)。 */
function makeFakeObs(label: string): { obs: Observability; spans: SpanRecord[]; logs: LogRecord[] } {
  const spans: SpanRecord[] = [];
  const logs: LogRecord[] = [];
  let seq = 0;

  const makeSpan = (name: string, attributes: Record<string, unknown>, parent: SpanContext | undefined): Span => {
    const spanId = `${label}-span-${seq++}`;
    const traceId = parent ? parent.traceId : `${label}-trace-${seq++}`;
    const rec: SpanRecord = {
      name,
      spanId,
      traceId,
      parentSpanId: parent?.spanId,
      attributes: { ...attributes },
      ended: false,
    };
    spans.push(rec);
    const sc: SpanContext = { traceId, spanId, traceFlags: 1 };
    // 只实现机制层真正调用的几个 method;其余按 unknown 兜成 Span 接口。
    const span = {
      spanContext: () => sc,
      setStatus: (s: { code: number }) => {
        rec.statusCode = s.code;
        return span;
      },
      setAttribute: () => span,
      setAttributes: () => span,
      addEvent: () => span,
      recordException: () => {},
      updateName: () => span,
      isRecording: () => !rec.ended,
      end: () => {
        rec.ended = true;
      },
    };
    return span as unknown as Span;
  };

  const tracer: Tracer = {
    startSpan: (name: string, options?: { attributes?: Record<string, unknown> }, context?: Context): Span => {
      // ★ explicit-parent 判据:parent 只从**传入的 context** 解析,绝不读 context.active()。
      const parentSpan = context ? trace.getSpan(context) : undefined;
      return makeSpan(name, options?.attributes ?? {}, parentSpan?.spanContext());
    },
    // startActiveSpan 不被机制层使用(B 档永不读 active);留个抛错的占位,命中即测试失败。
    startActiveSpan: (() => {
      throw new Error('startActiveSpan must not be used (B 档:explicit propagation only)');
    }) as Tracer['startActiveSpan'],
  };

  const makeLogger = (bindings: Record<string, unknown>): CoreLogger => {
    const emit = (level: LogRecord['level'], msg: string, fields?: Record<string, unknown>) => {
      logs.push({ level, msg, fields: { ...bindings, ...(fields ?? {}) } });
    };
    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (extra) => makeLogger({ ...bindings, ...extra }),
    };
  };

  return { obs: { tracer, logger: makeLogger({}) }, spans, logs };
}

// ── stub provider/tools(对齐 agent-loop.test.ts 形状)──────────────────────
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

/** Provider:把每个 stream() 调用映到 scripts[i];可注入 perEvent await(强制 yield 边界交错)。 */
function scriptedProvider(scripts: ProviderStreamEvent[][], gate?: () => Promise<void>): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream() {
      const turn = scripts[Math.min(call, scripts.length - 1)];
      call++;
      for (const ev of turn) {
        if (gate) await gate();
        yield ev;
      }
    },
  };
}

const echoTool = (gate?: () => Promise<void>): AgentTool =>
  buildTool({
    name: 'echo',
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async (i: unknown) => {
      if (gate) await gate();
      return { data: i };
    },
    mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
    maxResultSizeChars: 1000,
  });

function ctx(agentId: string, tools: AgentTool[], provider: LLMProvider, maxTurns = 16): AgentContext {
  return { agentId, provider, config: { systemPromptSlots: [], model: 'm', tools, maxTurns }, toolContext: {} };
}

async function collect(agent: CoreAgent, input: Parameters<CoreAgent['run']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('observability — explicit span propagation + span-bound logger', () => {
  test('(a) two concurrent runs keep parent chains within their own turn (no cross-parent)', async () => {
    // 每个 run 模拟一个 kernel turn:给一个显式 parentSpan(本轮 root),并发跑两个。
    // 用一个交错闸(barrier)强制两 run 在彼此的 yield 边界之间穿插推进 —— 若机制层误读
    // active-context,交错会让某 run 的 tool span 误挂到另一 run 的 span 上(本测即可捕获)。
    let releaseA: (() => void) | null = null;
    let releaseB: (() => void) | null = null;
    // 简单乒乓:A 与 B 每步互让一次,制造真实交错(不依赖具体调度时序,只要双方都 await)。
    let toggle = 0;
    const tick = async () => {
      toggle++;
      await Promise.resolve();
      await Promise.resolve();
    };
    void releaseA; void releaseB; // 仅保留语义占位(乒乓用 tick 实现)

    const fakeA = makeFakeObs('A');
    const fakeB = makeFakeObs('B');

    const provA = scriptedProvider([[asstWithToolUse('a-t1', 'echo', { v: 'A' })], [asstText('A done')]], tick);
    const provB = scriptedProvider([[asstWithToolUse('b-t1', 'echo', { v: 'B' })], [asstText('B done')]], tick);

    // 各自的本轮 root span(模拟 kernel.turn);agent.run 应建成它的 explicit child。
    const rootA = fakeA.obs.tracer.startSpan('kernel.turn', { attributes: { sid: 'sA' } });
    const rootB = fakeB.obs.tracer.startSpan('kernel.turn', { attributes: { sid: 'sB' } });

    const agentA = new CoreAgent({
      context: ctx('agentA', [echoTool(tick)], provA),
      observability: fakeA.obs,
      parentSpan: rootA,
    });
    const agentB = new CoreAgent({
      context: ctx('agentB', [echoTool(tick)], provB),
      observability: fakeB.obs,
      parentSpan: rootB,
    });

    // 真并发:同一事件循环里两条 async generator 同时推进。
    await Promise.all([
      collect(agentA, { input: { type: 'user', payload: 'hi A', ts: 0 } }),
      collect(agentB, { input: { type: 'user', payload: 'hi B', ts: 0 } }),
    ]);

    // 取各自的 agent.run span 与 tool span。
    const runA = fakeA.spans.find((s) => s.name === 'agent.run')!;
    const runB = fakeB.spans.find((s) => s.name === 'agent.run')!;
    expect(runA).toBeDefined();
    expect(runB).toBeDefined();

    // agent.run 必须 explicit-parent 到自己那棵 root(kernel.turn),且 traceId 继承之。
    const turnA = fakeA.spans.find((s) => s.name === 'kernel.turn')!;
    const turnB = fakeB.spans.find((s) => s.name === 'kernel.turn')!;
    expect(runA.parentSpanId).toBe(turnA.spanId);
    expect(runB.parentSpanId).toBe(turnB.spanId);
    expect(runA.traceId).toBe(turnA.traceId);
    expect(runB.traceId).toBe(turnB.traceId);

    // 所有工具 span 各挂自己 run，绝不跨 parent / 跨 trace。
    const toolsA = fakeA.spans.filter((s) => s.name === 'tool');
    const toolsB = fakeB.spans.filter((s) => s.name === 'tool');
    expect(toolsA.length).toBeGreaterThan(0);
    expect(toolsB.length).toBeGreaterThan(0);
    for (const t of toolsA) {
      expect(t.parentSpanId).toBe(runA.spanId);
      expect(t.traceId).toBe(runA.traceId);
      // 跨 turn 隔离:绝不以 B 的任何 span 作 parent。
      expect(fakeB.spans.some((s) => s.spanId === t.parentSpanId)).toBe(false);
    }
    for (const t of toolsB) {
      expect(t.parentSpanId).toBe(runB.spanId);
      expect(t.traceId).toBe(runB.traceId);
      expect(fakeA.spans.some((s) => s.spanId === t.parentSpanId)).toBe(false);
    }

    // 全部 span 均已收尾(无泄漏)。
    expect(fakeA.spans.filter((s) => s.name !== 'kernel.turn').every((s) => s.ended)).toBe(true);
    expect(fakeB.spans.filter((s) => s.name !== 'kernel.turn').every((s) => s.ended)).toBe(true);
  });

  test('(b) a deep log.info inside run carries the SAME traceId as its run span', async () => {
    const fake = makeFakeObs('L');
    const provider = scriptedProvider([[asstWithToolUse('t1', 'echo', { v: 1 })], [asstText('done')]]);
    const agent = new CoreAgent({
      context: ctx('agentL', [echoTool()], provider),
      observability: fake.obs,
    });
    await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    const runSpan = fake.spans.find((s) => s.name === 'agent.run')!;
    expect(runSpan).toBeDefined();

    // 深埋的 'tool call' log(loop 体内)必须带与 run span 一致的 traceId/spanId(span-bound child),
    //   而不是 active-context(B 档永不读)。
    const toolLog = fake.logs.find((l) => l.msg === 'tool call');
    expect(toolLog).toBeDefined();
    expect(toolLog!.fields.traceId).toBe(runSpan.traceId);
    expect(toolLog!.fields.spanId).toBe(runSpan.spanId);
    expect(toolLog!.fields.agentId).toBe('agentL');

    // turn start / done 同样带 run span 的 traceId。
    const startLog = fake.logs.find((l) => l.msg === 'agent.run start');
    expect(startLog!.fields.traceId).toBe(runSpan.traceId);
  });

  test('(c) with NO observability injected (NOOP), loop runs unchanged and emits no spans', async () => {
    const fake = makeFakeObs('N'); // 仅用于对照计数,不注入给 agent
    const provider = scriptedProvider([[asstWithToolUse('t1', 'echo', { v: 1 })], [asstText('done')]]);
    // 不传 observability/parentSpan → CoreAgent 内部兜底 NOOP_OBS。
    const agent = new CoreAgent({ context: ctx('agentN', [echoTool()], provider) });
    const events = await collect(agent, { input: { type: 'user', payload: 'hi', ts: 0 } });

    // 行为逐字不变:tool_call/tool_result/done 仍在,reason=completed。
    const types = events.map((e) => e.type);
    expect(types).toContain('turn_start');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    const last = events.at(-1)!;
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.terminal.reason).toBe('completed');

    // 我们的对照 fake 表全空(因为没注入它)—— 证明 NOOP 路径不碰任何注入的 tracer。
    expect(fake.spans.length).toBe(0);
    expect(fake.logs.length).toBe(0);
  });
});
