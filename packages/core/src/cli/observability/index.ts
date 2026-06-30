/**
 * forgeax-core — observability HOST 实现入口(Track H · 真实装配).
 *
 * HOST 层(src/cli/)允许 import OTel SDK / consola / exporter(经 boundary 白名单);机制层不碰。
 *
 * 装配(B 档 · v3 · 全程显式传播,**不注册 ContextManager / 不调 provider.register()**):
 *   BasicTracerProvider({ resource, spanProcessors:[...] })   ← SDK v2.8:无 addSpanProcessor,只能构造器传
 *     + ForgeaxProcessor(onStart→provisional / onEnd→final → SpanData → redactor → coalesce → send)
 *     + [otlpEndpoint] BatchSpanProcessor(OTLPTraceExporter)  ← B 档:原生吃 ReadableSpan,零映射
 *   tracer = provider.getTracer('forgeax-core')               ← 经注入缝下发,mechanism 不读全局
 *   logger = ConsolaCoreLogger(child(bindings) 自建)→ LogRecord → redactor → coalesce → send
 *
 * 开关(H6):`FORGEAX_OTEL=off` → 不挂任何 exporting processor(tracer 实质 noop:span 仍由 SDK 建,
 *   但无 processor 消费 → 不出 record),**logger 仍出 LogRecord**(log 不依赖 span)。无 context 可 gate(本就不注册)。
 * 脱敏(H5 / A.5):出口前 attrs/fields 过 redactor;wire 档(去浏览器/WS)更严,file 档较全。
 *   strict 源头脱敏由 producer 用 `redactStrictValueAtSource`(本模块导出)在写 attribute 时做 —— 因为
 *   OTLP exporter 出口我们够不着,只能源头保 OTLP/落盘安全。
 *
 * 见 .claude/docs/架构设计/forgeax-os/可观测性-trace-log-v3-B档-并行执行计划-2026-06-24.md §C Track H。
 */
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { LogRecord, SpanData, TelemetryRecord } from '@forgeax/types';
import { NOOP_LOGGER, NOOP_OBS, type Observability } from '../../observability/contract';
import { ForgeaxProcessor } from './processor';
import { ConsolaCoreLogger } from './logger';
import { Coalescer, LogRateLimiter } from './coalesce';
import { redactBagWith, type RedactProfile } from './redactor';

export { redactBagWith, redactStrictValueAtSource, REDACTED } from './redactor';
export type { RedactProfile } from './redactor';
export { ForgeaxProcessor, readableSpanToSpanData, hrTimeToMs } from './processor';
export { ConsolaCoreLogger } from './logger';
export { Coalescer, LogRateLimiter } from './coalesce';

/** exporter 统一面:host 把 records 接到具体信道(rpc notify / ws broadcast / file / postMessage)。 */
export interface Exporter {
  export(records: TelemetryRecord[]): void;
}

export interface MakeNodeObservabilityOptions {
  /** record 出口回调(host 接到 rpc/ws/file 等具体信道)。 */
  send: (records: TelemetryRecord[]) => void;
  /** 设了才挂 OTLP exporter(B 档:近期就要外部 backend)。也读 FORGEAX_OTLP_ENDPOINT 兜底。 */
  otlpEndpoint?: string;
  /** 出口脱敏档(默认 'wire' —— send 多半通向浏览器/WS,从严)。 */
  redactProfile?: RedactProfile;
  /** coalesce 窗口(ms),默认 80(50–100 区间)。 */
  coalesceWindowMs?: number;
  /** 关 dev console 镜像(默认开)。 */
  mirrorConsole?: boolean;
  /** 关/调 log 限流(默认开,每 level 200 条/秒)。 */
  rateLimit?: { enabled?: boolean; perWindow?: number; windowMs?: number };
}

/** FORGEAX_OTEL=off → 关 trace exporting(span 不出 record);其余值/未设 → 开。 */
function otelEnabled(): boolean {
  const v = (process.env.FORGEAX_OTEL ?? '').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

/**
 * 给一批 record 逐条过出口脱敏(SpanData.attrs / LogRecord.fields)。返回新数组,不改原。
 */
function redactRecords(records: TelemetryRecord[], profile: RedactProfile): TelemetryRecord[] {
  return records.map((r) => {
    if (r.kind === 'span') {
      const next: SpanData = { ...r };
      const a = redactBagWith(r.attrs, profile);
      if (a) next.attrs = a;
      else delete next.attrs;
      return next;
    }
    const next: LogRecord = { ...r };
    const f = redactBagWith(r.fields, profile);
    if (f) next.fields = f;
    else delete next.fields;
    return next;
  });
}

/** makeNodeObservability 的返回:在 Observability 之上多一个 `shutdown` —— 排空 coalescer 窗口残留 +
 *  关 OTLP exporter/provider。host(serve.ts)应在连接关闭时 await 它,避免丢最后一批 + 泄漏 exporter。 */
export interface NodeObservability extends Observability {
  /** 刷尽未发批次并关停 OTLP exporter/provider(幂等;off 模式只排 coalescer)。 */
  shutdown(): Promise<void>;
}

/**
 * 构造 node 形态 Observability。
 * 返回 `{ tracer, logger, shutdown }`:tracer 来自 provider(producer 建的 span 经 ForgeaxProcessor→send);
 * logger 为 consola adapter root(producer 调 `.child(...)` 派生带 bindings 的 child logger);
 * shutdown 供 host 在连接关闭时刷批 + 关 exporter。
 */
export function makeNodeObservability(opts: MakeNodeObservabilityOptions): NodeObservability {
  const send = opts.send;
  const profile: RedactProfile = opts.redactProfile ?? 'wire';
  const endpoint = opts.otlpEndpoint ?? process.env.FORGEAX_OTLP_ENDPOINT ?? undefined;

  // ── 出口管线:[record] → redactor → send。Coalescer 在前面攒批(S2)。 ──
  const coalescer = new Coalescer({
    windowMs: opts.coalesceWindowMs,
    send: (batch) => send(redactRecords(batch, profile)),
  });
  const rateLimiter = new LogRateLimiter({
    enabled: opts.rateLimit?.enabled ?? true,
    perWindow: opts.rateLimit?.perWindow,
    windowMs: opts.rateLimit?.windowMs,
  });

  const emitSpan = (s: SpanData): void => coalescer.push(s);
  const emitLog = (rec: LogRecord): void => {
    if (!rateLimiter.allow(rec.level)) return; // 超额丢弃(只限 log)。
    coalescer.push(rec);
  };

  // ── logger:任何时候都出 LogRecord(不受 FORGEAX_OTEL gate;log 不依赖 span)。 ──
  const logger = new ConsolaCoreLogger({
    emitLog,
    mirrorConsole: opts.mirrorConsole ?? true,
  });

  // ── tracer:FORGEAX_OTEL=off 时不挂任何 exporting processor → 不出 span record。 ──
  if (!otelEnabled()) {
    // span 侧降级:用契约 NOOP tracer(无 provider → noop,不出 span);logger 仍真。
    // shutdown 仍排空 coalescer(off 模式 log 也经它攒批)。
    return { tracer: NOOP_OBS.tracer, logger, shutdown: async () => coalescer.stop() };
  }

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'forgeax-core' });

  const spanProcessors: SpanProcessor[] = [
    // 内部信道:ReadableSpan → SpanData → redactor → coalesce → send。
    new ForgeaxProcessor(emitSpan, {
      // forceFlush/shutdown 时排空 coalescer(否则窗口内残留丢失)。
      onForceFlush: () => coalescer.flush(),
      onShutdown: () => coalescer.stop(),
    }),
  ];

  // B 档:设了 endpoint 才挂 OTLP(原生吃 explicit-parent 建出来的真 OTel span,零映射)。
  if (endpoint) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })));
  }

  // SDK v2.8:无 provider.addSpanProcessor —— 必须构造器传 spanProcessors;不调 register()(不入全局)。
  const provider = new BasicTracerProvider({ resource, spanProcessors });
  const tracer = provider.getTracer('forgeax-core');

  // shutdown:先 forceFlush(排空内部 coalescer + OTLP 批),再 shutdown(关 exporter)。
  //   provider.forceFlush → ForgeaxProcessor.forceFlush → onForceFlush → coalescer.flush;
  //   provider.shutdown   → ForgeaxProcessor.shutdown   → onShutdown   → coalescer.stop + OTLP 关闭。
  const shutdown = async (): Promise<void> => {
    try {
      await provider.forceFlush();
    } catch {
      /* 诊断绝不影响主流程(§9) */
    }
    try {
      await provider.shutdown();
    } catch {
      /* 同上 */
    }
  };

  return { tracer, logger, shutdown };
}

/** 显式降级:返回 NOOP(供调用方在装配失败时兜底,§9 Graceful Degradation)。shutdown 为 no-op。 */
export function noopObservability(): NodeObservability {
  return { tracer: NOOP_OBS.tracer, logger: NOOP_LOGGER, shutdown: async () => {} };
}
