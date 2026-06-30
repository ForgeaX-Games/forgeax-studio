/**
 * @forgeax/types — observability wire schema (Schema-as-Contract).
 *
 * SSOT for the trace+log telemetry envelope crossing every boundary:
 *   core-sidecar →RPC `telemetry`→ server →WS `{type:'telemetry'}`→ interface viewer,
 *   and iframe →postMessage `{type:'VAG_TELEMETRY'}`→ shell.
 *
 * v3 / B 档:span 由 producer 侧 explicit-parent 建,sid/agentId 在建 span 时盖戳;
 * 这里只定义**线缆形状**,不含任何传播/context 语义(那是 host 实现层的事)。
 * 见 .claude/docs/架构设计/forgeax-os/可观测性-trace-log-v3-B档-并行执行计划-2026-06-24.md §B。
 */
import { z } from 'zod';

/** 一条 span(trace 节点)。provisional=true 时表示 onStart 发的临时态,endTs 缺;
 *  onEnd 再发一条 final 覆盖(S1 实时性)。父子关系靠 parentSpanId 显式串(B 档:不靠 active-context)。 */
export const SpanData = z.object({
  kind: z.literal('span'),
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTs: z.number(),
  endTs: z.number().optional(), // provisional 时缺
  provisional: z.boolean().optional(),
  attrs: z.record(z.unknown()).optional(),
  events: z
    .array(
      z.object({
        name: z.string(),
        ts: z.number(),
        attrs: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
  status: z
    .object({
      code: z.enum(['ok', 'error']),
      message: z.string().optional(),
    })
    .optional(),
  // 关联维度(查询时筛,非写入隔离)。sid/agentId 在建 span 时由 producer 盖戳。
  sid: z.string().optional(),
  agentId: z.string().optional(),
});
export type SpanData = z.infer<typeof SpanData>;

/** 一条结构化日志。traceId/spanId 来自 span-bound child logger 的 bindings(W1:不靠 getActiveSpan)。 */
export const LogRecord = z.object({
  kind: z.literal('log'),
  ts: z.number(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  msg: z.string(),
  fields: z.record(z.unknown()).optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  sid: z.string().optional(),
  agentId: z.string().optional(),
});
export type LogRecord = z.infer<typeof LogRecord>;

/** 一条 telemetry record:span 或 log。 */
export const TelemetryRecord = z.discriminatedUnion('kind', [SpanData, LogRecord]);
export type TelemetryRecord = z.infer<typeof TelemetryRecord>;

/** 跨进程/跨 frame 统一信封。`type` 区分信道:
 *  - 'telemetry'      —— node→server→WS 主通道
 *  - 'VAG_TELEMETRY'  —— iframe→shell postMessage(同 VAG_CONSOLE 家族) */
export const TelemetryEnvelope = z.object({
  type: z.enum(['telemetry', 'VAG_TELEMETRY']),
  records: z.array(TelemetryRecord),
});
export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelope>;
