/**
 * Track H — observability HOST 单测(offline,OTLP off,无网络).
 *
 * 用 capturing send(records.push)断言:
 *  (a) startSpan→end → 先一条 provisional SpanData,后一条带 endTs 的 final;
 *  (b) 用 explicit parent(trace.setSpan(ROOT_CONTEXT, parentSpan))建 child span → parentSpanId === parent.spanId;
 *  (c) logger.child({traceId,spanId,sid,agentId}).info('m',{k:1}) → LogRecord 带这些字段;
 *  (d) redactor 打码 secret-looking attr;
 *  (e) coalesce 把多条 record 攒进更少的 send 调用。
 *
 * B 档:全程显式传播 —— 测试**自己**用 trace.setSpan(ROOT_CONTEXT, parent) 显式认 parent,
 * 不依赖任何 active-context(我们也从不注册 ContextManager)。
 */
import { test, expect, describe } from 'bun:test';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { TelemetryRecord, SpanData, LogRecord } from '@forgeax/types';
import { makeNodeObservability } from '../src/cli/observability/index';
import { redactBagWith, redactStrictValueAtSource } from '../src/cli/observability/redactor';
import { readableSpanToSpanData } from '../src/cli/observability/processor';
import { Coalescer } from '../src/cli/observability/coalesce';

/** 攒批窗口很小、关 console 镜像、关限流,便于断言。 */
function makeObs(records: TelemetryRecord[], coalesceWindowMs = 5) {
  return makeNodeObservability({
    send: (batch) => records.push(...batch),
    coalesceWindowMs,
    mirrorConsole: false,
    rateLimit: { enabled: false },
  });
}

const spans = (records: TelemetryRecord[]): SpanData[] =>
  records.filter((r): r is SpanData => r.kind === 'span');
const logs = (records: TelemetryRecord[]): LogRecord[] =>
  records.filter((r): r is LogRecord => r.kind === 'log');

/** 等 coalesce 窗口 flush。 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Track H — observability host', () => {
  test('(a) startSpan→end emits provisional then final SpanData', async () => {
    const records: TelemetryRecord[] = [];
    const obs = makeObs(records);

    const span = obs.tracer.startSpan('agent.run', { attributes: { sid: 's1', agentId: 'a1' } });
    await wait(20); // 让 provisional 先 flush
    span.end();
    await wait(20);

    const ss = spans(records).filter((s) => s.name === 'agent.run');
    // 至少一条 provisional + 一条 final
    const provisional = ss.find((s) => s.provisional === true);
    const final = ss.find((s) => s.provisional !== true);
    expect(provisional).toBeDefined();
    expect(provisional!.endTs).toBeUndefined();
    expect(provisional!.sid).toBe('s1');
    expect(provisional!.agentId).toBe('a1');
    expect(final).toBeDefined();
    expect(typeof final!.endTs).toBe('number');
    expect(final!.traceId).toBe(provisional!.traceId);
    expect(final!.spanId).toBe(provisional!.spanId);
  });

  test('(b) explicit-parent child span → parentSpanId === parent.spanId', async () => {
    const records: TelemetryRecord[] = [];
    const obs = makeObs(records);

    const parent = obs.tracer.startSpan('parent');
    const parentSpanId = parent.spanContext().spanId;
    const parentTraceId = parent.spanContext().traceId;

    // B 档:显式认 parent —— trace.setSpan(ROOT_CONTEXT, parent)。不靠 active-context。
    const child = obs.tracer.startSpan('child', {}, trace.setSpan(ROOT_CONTEXT, parent));
    child.end();
    parent.end();
    await wait(30);

    const childFinal = spans(records).find((s) => s.name === 'child' && s.provisional !== true);
    expect(childFinal).toBeDefined();
    expect(childFinal!.parentSpanId).toBe(parentSpanId);
    // 同一 trace
    expect(childFinal!.traceId).toBe(parentTraceId);
  });

  test('(c) logger.child(bindings).info → LogRecord carries traceId/spanId/sid/agentId + fields', async () => {
    const records: TelemetryRecord[] = [];
    const obs = makeObs(records);

    obs.logger
      .child({ traceId: 't-abc', spanId: 's-def', sid: 'sid-1', agentId: 'agt-1' })
      .info('hello', { k: 1 });
    await wait(20);

    const ls = logs(records);
    expect(ls.length).toBe(1);
    const rec = ls[0];
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.traceId).toBe('t-abc');
    expect(rec.spanId).toBe('s-def');
    expect(rec.sid).toBe('sid-1');
    expect(rec.agentId).toBe('agt-1');
    expect(rec.fields).toEqual({ k: 1 });
  });

  test('(c2) child bindings accumulate across nested child()', async () => {
    const records: TelemetryRecord[] = [];
    const obs = makeObs(records);
    obs.logger
      .child({ sid: 'sid-1' })
      .child({ traceId: 't-1', tag: 'sub' })
      .warn('nested');
    await wait(20);
    const rec = logs(records)[0];
    expect(rec.sid).toBe('sid-1');
    expect(rec.traceId).toBe('t-1');
    expect(rec.fields).toEqual({ tag: 'sub' }); // 非关联维度的 binding 进 fields
  });

  test('(d) redactor masks secret-looking attrs (wire profile)', () => {
    const masked = redactBagWith(
      {
        ANTHROPIC_API_KEY: 'sk-ant-super-secret-value-1234567890',
        authorization: 'Bearer abcdef1234567890',
        note: 'this is fine',
        inline: 'FOO_TOKEN=deadbeefcafe',
      },
      'wire',
    )!;
    expect(masked.ANTHROPIC_API_KEY).toBe('[REDACTED]'); // deny-key
    expect(masked.authorization).toBe('[REDACTED]'); // deny-key
    expect(masked.note).toBe('this is fine'); // 干净值不动
    expect(String(masked.inline)).toContain('[REDACTED]'); // 值内联密钥被打码
  });

  test('(d2) wire profile drops whole env-bag; source-strict masks sk-keys', () => {
    const masked = redactBagWith({ env: { PATH: '/usr/bin', SECRET_X: 'y' } }, 'wire')!;
    expect(masked.env).toBe('[REDACTED]');
    // source-strict:值里的 sk-key 在写入时就打码(OTLP 出口够不着,只能源头)。
    const v = redactStrictValueAtSource('token sk-ant-abcdefghijklmnop tail');
    expect(String(v)).toContain('[REDACTED]');
  });

  test('(e) coalesce batches multiple records into fewer send calls', async () => {
    const calls: TelemetryRecord[][] = [];
    const c = new Coalescer({ windowMs: 30, send: (b) => calls.push(b) });
    const mk = (i: number): LogRecord => ({ kind: 'log', ts: i, level: 'info', msg: `m${i}` });
    for (let i = 0; i < 5; i++) c.push(mk(i));
    // 窗口未到 → 还没 send
    expect(calls.length).toBe(0);
    await wait(50);
    // 一次 flush 攒了 5 条
    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(5);
  });

  test('(f) FORGEAX_OTEL=off → no span records, but logs still emit', async () => {
    const prev = process.env.FORGEAX_OTEL;
    process.env.FORGEAX_OTEL = 'off';
    try {
      const records: TelemetryRecord[] = [];
      const obs = makeObs(records);
      const span = obs.tracer.startSpan('should-be-noop');
      span.end();
      obs.logger.child({ sid: 's' }).info('still-logs');
      await wait(20);
      expect(spans(records).length).toBe(0); // 无 processor 消费 → 不出 span
      expect(logs(records).length).toBe(1); // log 不受 gate
      expect(logs(records)[0].msg).toBe('still-logs');
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_OTEL;
      else process.env.FORGEAX_OTEL = prev;
    }
  });

  test('(g) readableSpanToSpanData maps status + events (final)', () => {
    // 直接喂一个最小 ReadableSpan-shaped 对象,验映射(不经 SDK)。
    const fake = {
      name: 'op',
      spanContext: () => ({ traceId: 'tid', spanId: 'sid', traceFlags: 1 }),
      parentSpanContext: { traceId: 'tid', spanId: 'parent-sid', traceFlags: 1 },
      startTime: [1, 500_000_000] as [number, number], // 1.5s → 1500ms
      endTime: [2, 0] as [number, number], // 2000ms
      status: { code: 2 }, // ERROR
      attributes: { sid: 'S', agentId: 'A', foo: 'bar' },
      events: [{ name: 'evt', time: [1, 0] as [number, number], attributes: { x: 1 } }],
    };
    // readableSpanToSpanData 只读上述只读字段,类型上以 ReadableSpan 兜。
    const data = readableSpanToSpanData(fake as never, false);
    expect(data.traceId).toBe('tid');
    expect(data.spanId).toBe('sid');
    expect(data.parentSpanId).toBe('parent-sid');
    expect(data.startTs).toBe(1500);
    expect(data.endTs).toBe(2000);
    expect(data.status).toEqual({ code: 'error', message: undefined });
    expect(data.sid).toBe('S');
    expect(data.agentId).toBe('A');
    expect(data.attrs).toEqual({ foo: 'bar' });
    expect(data.events).toEqual([{ name: 'evt', ts: 1000, attrs: { x: 1 } }]);
  });
});
