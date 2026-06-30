/**
 * forgeax-core — observability HOST 的 SpanProcessor(H2 · ReadableSpan→SpanData).
 *
 * ForgeaxProcessor 挂在 BasicTracerProvider 上(与可选的 BatchSpanProcessor(OTLP) 并列):
 *  - `onStart` → 发一条 provisional `SpanData`(`provisional:true`、`endTs` 缺),让长 turn 实时可见(S1)。
 *  - `onEnd`   → 发一条 final `SpanData`(带 `endTs`/status/events)覆盖之。
 *
 * B 档铁律:**全程显式传播**。这里**不读** context.active()/getActiveSpan()/baggage。
 *  - parentSpanId 取自 ReadableSpan 的 `parentSpanContext?.spanId`(SDK v2 字段名,已对着安装的
 *    @opentelemetry/sdk-trace-base@2.8 d.ts 核证:`ReadableSpan.parentSpanContext?: SpanContext`;
 *    v1 的旧字段 `parentSpanId` 在 v2 已**移除**)。
 *  - sid/agentId 取自 `span.attributes.sid / .agentId`(producer 建 span 时盖戳),不走 baggage(A.2 删 N3)。
 *
 * 出口:把映射好的 SpanData 交给注入的 `emit(records)`(下游再过 redactor→coalesce→send)。
 * onStart 收到的是可变 `Span`(同时实现 ReadableSpan 只读面),映射只读其只读字段,故按 ReadableSpan 处理。
 */
import type { Context } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanData } from '@forgeax/types';

/** OTel HrTime = [seconds, nanos] → 毫秒(number)。 */
export function hrTimeToMs(hr: [number, number] | undefined): number | undefined {
  if (!hr) return undefined;
  const [s, ns] = hr;
  return s * 1000 + ns / 1e6;
}

/** OTel StatusCode → wire 'ok'/'error'(UNSET 视为无 status,不出 status 字段)。 */
function mapStatus(s: ReadableSpan['status']): SpanData['status'] | undefined {
  if (!s) return undefined;
  if (s.code === SpanStatusCode.ERROR) {
    return { code: 'error', message: s.message };
  }
  if (s.code === SpanStatusCode.OK) {
    return { code: 'ok', message: s.message };
  }
  // UNSET:不发 status(viewer 视作进行中/未判定)。
  return undefined;
}

/** attributes(OTel Attributes,值受限标量/数组)→ wire attrs;同时抽出 sid/agentId 维度。 */
function extractAttrs(span: ReadableSpan): {
  attrs: Record<string, unknown> | undefined;
  sid: string | undefined;
  agentId: string | undefined;
} {
  const raw = span.attributes ?? {};
  const attrs: Record<string, unknown> = {};
  let sid: string | undefined;
  let agentId: string | undefined;
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'sid') {
      sid = v == null ? undefined : String(v);
      continue;
    }
    if (k === 'agentId') {
      agentId = v == null ? undefined : String(v);
      continue;
    }
    attrs[k] = v;
  }
  return {
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    sid,
    agentId,
  };
}

/** TimedEvent[] → wire events。 */
function mapEvents(span: ReadableSpan): SpanData['events'] {
  if (!span.events || span.events.length === 0) return undefined;
  return span.events.map((e) => ({
    name: e.name,
    ts: hrTimeToMs(e.time as [number, number]) ?? 0,
    attrs: e.attributes ? { ...(e.attributes as Record<string, unknown>) } : undefined,
  }));
}

/**
 * 把 ReadableSpan 映射成线缆 SpanData。
 * @param provisional onStart 阶段为 true(endTs 缺),onEnd 为 false(带 endTs/events/status)。
 */
export function readableSpanToSpanData(span: ReadableSpan, provisional: boolean): SpanData {
  const ctx = span.spanContext();
  const { attrs, sid, agentId } = extractAttrs(span);
  // SDK v2:ReadableSpan.parentSpanContext?: SpanContext(v1 的 parentSpanId 已移除)。
  const parentSpanId = span.parentSpanContext?.spanId;
  const startTs = hrTimeToMs(span.startTime as [number, number]) ?? 0;

  const data: SpanData = {
    kind: 'span',
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    name: span.name,
    startTs,
  };
  if (parentSpanId) data.parentSpanId = parentSpanId;
  if (attrs) data.attrs = attrs;
  if (sid != null) data.sid = sid;
  if (agentId != null) data.agentId = agentId;

  if (provisional) {
    data.provisional = true;
    // provisional 时 endTs 缺、events/status 一般尚无 —— S1 实时性,onEnd 再补全覆盖。
    return data;
  }

  const endTs = hrTimeToMs(span.endTime as [number, number]);
  if (endTs != null) data.endTs = endTs;
  const events = mapEvents(span);
  if (events) data.events = events;
  const status = mapStatus(span.status);
  if (status) data.status = status;
  return data;
}

/**
 * 我们的 SpanProcessor。`emit` 是上游注入的出口(makeNodeObservability 接到 redactor→coalesce→send)。
 * forceFlush/shutdown 透传给 onFlush/onShutdown(让组装层排空 coalescer / 关 exporter)。
 */
export class ForgeaxProcessor implements SpanProcessor {
  constructor(
    private readonly emit: (span: SpanData) => void,
    private readonly hooks: {
      onForceFlush?: () => Promise<void> | void;
      onShutdown?: () => Promise<void> | void;
    } = {},
  ) {}

  onStart(span: Span, _parentContext: Context): void {
    // B 档:不读 _parentContext(显式传播,parent 在 span 上)。发 provisional 让长 turn 可见(S1)。
    try {
      this.emit(readableSpanToSpanData(span as unknown as ReadableSpan, true));
    } catch {
      // 出口故障不拖垮被观察者。
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      this.emit(readableSpanToSpanData(span, false));
    } catch {
      // 同上。
    }
  }

  async forceFlush(): Promise<void> {
    await this.hooks.onForceFlush?.();
  }

  async shutdown(): Promise<void> {
    await this.hooks.onShutdown?.();
  }
}
