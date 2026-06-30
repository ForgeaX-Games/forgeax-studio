/**
 * M1 硬闸(Phase 2 集成):用**真实** Track-H `makeNodeObservability` 串**真实** Track-C
 * CoreAgent —— 验证两条平行 track 真能组合(并行期各自只对 fake/stub 测过)。
 *
 * 断言对位计划 §C Phase 2 I2:
 *   1. 真 span/log 经 exporter `send` 流出;tool span explicit-parent 挂在 run span 下,同 traceId。
 *   2. 深处 `log.info` 的 record 带正确 traceId(span-bound child logger,非 getActiveSpan)。
 *   3. 并发两轮(各带自己的 parentSpan)父子树不串台(B 档 explicit-parent 的核心收益)。
 *   4. FORGEAX_OTEL=off:不出 span,但 logger 仍出 LogRecord(N1 降级:log 不依赖 span)。
 *
 * 见 .claude/docs/架构设计/forgeax-os/可观测性-trace-log-v3-B档-并行执行计划-2026-06-24.md §C/§E。
 */
import { test, expect, describe } from 'bun:test';
import { trace, ROOT_CONTEXT } from '@opentelemetry/api';
import type { SpanData, LogRecord, TelemetryRecord } from '@forgeax/types';
import { CoreAgent } from '../src/agent/agent';
import { makeNodeObservability } from '../src/cli/observability';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FLUSH_MS = 160; // coalescer 窗口 80ms → 留足排空

const echoTool = buildTool({
  name: 'echo',
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
  maxResultSizeChars: 1000,
});

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
function ctx(tools: AgentTool[], provider: LLMProvider, agentId = 'a1'): AgentContext {
  return { agentId, provider, config: { systemPromptSlots: [], model: 'm', tools, maxTurns: 16 }, toolContext: {} };
}
async function drain(agent: CoreAgent): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) out.push(e);
  return out;
}
function capture() {
  const records: TelemetryRecord[] = [];
  const obs = makeNodeObservability({ send: (recs) => records.push(...recs), mirrorConsole: false });
  return { records, obs };
}
const spansOf = (r: TelemetryRecord[]) => r.filter((x): x is SpanData => x.kind === 'span');
const logsOf = (r: TelemetryRecord[]) => r.filter((x): x is LogRecord => x.kind === 'log');

describe('M1 gate — real host obs ⨯ real CoreAgent', () => {
  test('I2.1+I2.2 spans+logs flow; tool span explicit-parent under run span; log carries run traceId', async () => {
    const { records, obs } = capture();
    const provider = scriptedProvider([[asstWithToolUse('t1', 'echo', { v: 1 })], [asstText('done')]]);
    await drain(new CoreAgent({ context: ctx([echoTool], provider), observability: obs }));
    await sleep(FLUSH_MS);

    const spans = spansOf(records);
    const logs = logsOf(records);
    expect(spans.length).toBeGreaterThan(0);

    const runFinal = spans.find((s) => s.name === 'agent.run' && s.endTs != null);
    const runProvisional = spans.find((s) => s.name === 'agent.run' && s.provisional);
    const toolFinal = spans.find((s) => s.name === 'tool' && s.endTs != null);
    expect(runFinal).toBeDefined();
    expect(runProvisional).toBeDefined(); // onStart 实时性(S1)
    expect(toolFinal).toBeDefined();
    expect(toolFinal!.attrs?.tool).toBe('echo');

    // explicit-parent:tool span 挂在 run span 下,同 traceId(不靠 active-context)
    expect(toolFinal!.parentSpanId).toBe(runFinal!.spanId);
    expect(toolFinal!.traceId).toBe(runFinal!.traceId);
    // root run span 无 parent
    expect(runFinal!.parentSpanId).toBeUndefined();

    // 深处 log 带正确 traceId(span-bound child logger,W1)
    expect(logs.some((l) => l.traceId === runFinal!.traceId)).toBe(true);
    expect(logs.some((l) => l.msg === 'tool call' && l.fields?.tool === 'echo')).toBe(true);
  });

  test('I2.3 concurrent turns with distinct parentSpan never cross-parent', async () => {
    const { records, obs } = capture();
    // 模拟两轮:各自的 kernel.turn root(同 tracer,不同 span)。
    const turnA = obs.tracer.startSpan('kernel.turn', { attributes: { sid: 'A', agentId: 'A' } });
    const turnB = obs.tracer.startSpan('kernel.turn', { attributes: { sid: 'B', agentId: 'B' } });

    const mk = (id: string, parent: typeof turnA) =>
      new CoreAgent({
        context: ctx([echoTool], scriptedProvider([[asstWithToolUse(`${id}1`, 'echo', { id })], [asstText('done')]]), id),
        observability: obs,
        parentSpan: parent,
      });

    await Promise.all([drain(mk('A', turnA)), drain(mk('B', turnB))]);
    turnA.end();
    turnB.end();
    await sleep(FLUSH_MS);

    const spans = spansOf(records);
    const traceA = turnA.spanContext().traceId;
    const traceB = turnB.spanContext().traceId;
    expect(traceA).not.toBe(traceB);

    const runA = spans.find((s) => s.name === 'agent.run' && s.traceId === traceA && s.endTs != null);
    const runB = spans.find((s) => s.name === 'agent.run' && s.traceId === traceB && s.endTs != null);
    expect(runA).toBeDefined();
    expect(runB).toBeDefined();
    // 每轮 run span 挂在自己的 turn 下,绝不挂对方
    expect(runA!.parentSpanId).toBe(turnA.spanContext().spanId);
    expect(runB!.parentSpanId).toBe(turnB.spanContext().spanId);

    // 每轮 tool span 同 trace 内挂自己的 run span;两 trace 的 id 集合不相交
    const toolA = spans.find((s) => s.name === 'tool' && s.traceId === traceA && s.endTs != null);
    const toolB = spans.find((s) => s.name === 'tool' && s.traceId === traceB && s.endTs != null);
    expect(toolA!.parentSpanId).toBe(runA!.spanId);
    expect(toolB!.parentSpanId).toBe(runB!.spanId);
    expect(spans.filter((s) => s.traceId === traceA).every((s) => s.spanId !== runB!.spanId)).toBe(true);
  });

  test('I2.4 FORGEAX_OTEL=off: no span records, but logger still emits LogRecords', async () => {
    const prev = process.env.FORGEAX_OTEL;
    process.env.FORGEAX_OTEL = 'off';
    try {
      const { records, obs } = capture(); // 必须在 env 置 off 后构造
      const provider = scriptedProvider([[asstWithToolUse('t1', 'echo', { v: 1 })], [asstText('done')]]);
      await drain(new CoreAgent({ context: ctx([echoTool], provider), observability: obs }));
      await sleep(FLUSH_MS);

      expect(spansOf(records).length).toBe(0); // 不出 span
      expect(logsOf(records).length).toBeGreaterThan(0); // log 仍出(N1 降级)
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_OTEL;
      else process.env.FORGEAX_OTEL = prev;
    }
  });
});
