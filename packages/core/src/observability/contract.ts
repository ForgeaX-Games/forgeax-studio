/**
 * forgeax-core — observability mechanism contract (注入缝的 core 侧契约).
 *
 * 机制层(agent/ kernel-facade/ inject/ capability/)**只认这份契约**;实现(OTel SDK +
 * consola + exporter/redactor)全在 HOST 层(src/cli/observability/),经三层注入缝下发。
 * 边界铁律:本文件是 core src/ 里**唯一**允许 import `@opentelemetry/api` 的入口,且仅取
 * 其 `Tracer`/`Span` 类型 + noop `trace`(zero-dep、noop-default)。SDK/consola 绝不进机制层。
 *
 * v3 / B 档:span 走 explicit parent、log 走 span-bound child logger、sid/agentId 显式盖戳;
 * 永不读 context.active()/getActiveSpan()/baggage(故 ContextManager 不注册)。
 * 见 .claude/docs/架构设计/forgeax-os/可观测性-trace-log-v3-B档-并行执行计划-2026-06-24.md §B 契约②③。
 */
import { trace, ROOT_CONTEXT, type Tracer, type Span, type SpanContext, type Context } from '@opentelemetry/api';

/** 薄 logger 接口(实现可由 consola 适配)。`child(bindings)` 产的 logger 把 bindings 并进每条
 *  record 的 fields —— traceId/spanId/sid/agentId 经此随 record 出墙,不靠 active-context(W1)。 */
export interface CoreLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): CoreLogger;
}

/** 注入给 loop / kernel / tool 的可观测性能力束。tracer 来自 @opentelemetry/api(noop 或 host 经
 *  注入缝下发的真 tracer);logger 为 CoreLogger 实现。 */
export interface Observability {
  tracer: Tracer;
  logger: CoreLogger;
}

/** 本轮显式 ctx 载体(producer 入口 runTurn/run 顶部构造,显式参数下传)。
 *  - span:子 span 用 `startSpan(name, {}, trace.setSpan(ROOT_CONTEXT, ctx.span))` 显式认 parent。
 *  - logger:`ctx.logger.info()` 的 record 天生带 traceId/spanId/sid/agentId(child bindings)。 */
export interface TurnCtx {
  span: Span;
  logger: CoreLogger;
  sid: string;
  agentId: string;
}

/** 无操作 logger:缺省注入时用,零行为变化。 */
export const NOOP_LOGGER: CoreLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER;
  },
};

/** 无操作可观测性束:`trace.getTracer` 在无注册 provider 时返 noop tracer(不出 span)。
 *  loop 兜底 `this.o.observability ?? NOOP_OBS`,保证机制层无分支即可降级(§9 Graceful Degradation)。 */
export const NOOP_OBS: Observability = {
  tracer: trace.getTracer('forgeax-core'),
  logger: NOOP_LOGGER,
};

// ─── 跨进程 trace 传播(W3C traceparent)──────────────────────────────────────
// 全链路 trace:浏览器/host 把自己 span 的 context 序列化成 W3C `traceparent` 往下传,
// 下游(本进程 kernel.turn / 子 sidecar)解析后把自己的 root span 挂成它的 child,
// 于是 browser→host→kernel→agent→tool 串成同一棵 trace。仍是显式传播(不读 active-context)。

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX2 = /^[0-9a-f]{2}$/;

/** 解析 W3C traceparent `00-<traceId:32hex>-<spanId:16hex>-<flags:2hex>` → SpanContext。
 *  非法/缺失/全零 → undefined(调用方回落自建 root)。 */
export function parseTraceparent(tp: string | undefined): SpanContext | undefined {
  if (!tp) return undefined;
  const parts = tp.trim().split('-');
  if (parts.length !== 4) return undefined;
  const [version, traceId, spanId, flags] = parts;
  if (version !== '00') return undefined;
  if (!HEX32.test(traceId) || traceId === '0'.repeat(32)) return undefined;
  if (!HEX16.test(spanId) || spanId === '0'.repeat(16)) return undefined;
  if (!HEX2.test(flags)) return undefined;
  return { traceId, spanId, traceFlags: parseInt(flags, 16), isRemote: true };
}

/** traceparent → 可直接传给 `tracer.startSpan(name, opts, ctx)` 第 3 参的 parent context。
 *  非法/缺失 → undefined(startSpan 收到 undefined = 自建 root,零行为变化)。 */
export function parentContextFromTraceparent(tp: string | undefined): Context | undefined {
  const sc = parseTraceparent(tp);
  if (!sc) return undefined;
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(sc));
}

/** 把一个 span 的 context 序列化成 W3C traceparent,供下行传播(host→sidecar)。 */
export function toTraceparent(span: Span): string {
  const c = span.spanContext();
  const flags = (c.traceFlags & 0xff).toString(16).padStart(2, '0');
  return `00-${c.traceId}-${c.spanId}-${flags}`;
}
