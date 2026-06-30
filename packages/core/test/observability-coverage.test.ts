/**
 * 可观测性 HOST 单元覆盖补全 —— 把 observability/* 的每条分支打满(funcs+lines 100%)。
 * 与 observability-host/-trace/-m1-gate 互补:那三个验「集成行为」,这个验「分支穷尽」。
 * 全部纯单元、确定性(fake ReadableSpan / 注入 timer / stub consola),离线。
 */
import { test, expect, describe } from 'bun:test';
import { SpanStatusCode, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import type { SpanData, LogRecord, TelemetryRecord } from '@forgeax/types';

import { NOOP_LOGGER, NOOP_OBS, parseTraceparent, parentContextFromTraceparent, toTraceparent } from '../src/observability/contract';
import { trace as otelTrace } from '@opentelemetry/api';
import { redactBagWith, redactStrictValueAtSource, REDACTED } from '../src/cli/observability/redactor';
import { Coalescer, LogRateLimiter } from '../src/cli/observability/coalesce';
import { ForgeaxProcessor, readableSpanToSpanData, hrTimeToMs } from '../src/cli/observability/processor';
import { ConsolaCoreLogger } from '../src/cli/observability/logger';
import { makeNodeObservability, noopObservability } from '../src/cli/observability';
import { promptTokens, cacheHitRate, briefError } from '../src/observability/usage';

// ─── contract.ts NOOP（funcs 100%）──────────────────────────────────────────
describe('contract NOOP', () => {
  test('NOOP_LOGGER all methods + child returns self; NOOP_OBS tracer noop', () => {
    NOOP_LOGGER.debug('d', { a: 1 });
    NOOP_LOGGER.info('i');
    NOOP_LOGGER.warn('w');
    NOOP_LOGGER.error('e');
    expect(NOOP_LOGGER.child({ traceId: 't' })).toBe(NOOP_LOGGER);
    const s = NOOP_OBS.tracer.startSpan('x');
    s.setAttribute('k', 'v');
    s.end();
    expect(typeof NOOP_OBS.tracer.startSpan).toBe('function');
  });
});

// ─── contract.ts traceparent 传播(W3C 解析/构造/序列化,全分支)──────────────
describe('contract traceparent', () => {
  const TP = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';

  test('parseTraceparent: valid → SpanContext(isRemote)', () => {
    const sc = parseTraceparent(TP)!;
    expect(sc.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(sc.spanId).toBe('0123456789abcdef');
    expect(sc.traceFlags).toBe(1);
    expect(sc.isRemote).toBe(true);
  });

  test('parseTraceparent: reject undefined / wrong parts / bad version / non-hex / all-zero', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('')).toBeUndefined();
    expect(parseTraceparent('00-abc-def')).toBeUndefined(); // 3 段
    expect(parseTraceparent('99-0123456789abcdef0123456789abcdef-0123456789abcdef-01')).toBeUndefined(); // 版本
    expect(parseTraceparent('00-ZZZ-0123456789abcdef-01')).toBeUndefined(); // traceId 非 32hex
    expect(parseTraceparent('00-0123456789abcdef0123456789abcdef-XYZ-01')).toBeUndefined(); // spanId 非 16hex
    expect(parseTraceparent('00-0123456789abcdef0123456789abcdef-0123456789abcdef-zz')).toBeUndefined(); // flags 非 2hex
    expect(parseTraceparent(`00-${'0'.repeat(32)}-0123456789abcdef-01`)).toBeUndefined(); // 全零 traceId
    expect(parseTraceparent(`00-0123456789abcdef0123456789abcdef-${'0'.repeat(16)}-01`)).toBeUndefined(); // 全零 spanId
  });

  test('parentContextFromTraceparent: valid → Context carrying remote span; invalid → undefined', () => {
    const ctx = parentContextFromTraceparent(TP)!;
    expect(ctx).toBeDefined();
    const parentSc = otelTrace.getSpan(ctx)!.spanContext();
    expect(parentSc.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(parentSc.spanId).toBe('0123456789abcdef');
    expect(parentContextFromTraceparent('garbage')).toBeUndefined();
    expect(parentContextFromTraceparent(undefined)).toBeUndefined();
  });

  test('toTraceparent: serialize a span context round-trips through parse', () => {
    const fakeSpan = { spanContext: () => ({ traceId: 'aabbccddeeff00112233445566778899', spanId: '1122334455667788', traceFlags: 1 }) } as unknown as import('@opentelemetry/api').Span;
    const tp = toTraceparent(fakeSpan);
    expect(tp).toBe('00-aabbccddeeff00112233445566778899-1122334455667788-01');
    const sc = parseTraceparent(tp)!;
    expect(sc.traceId).toBe('aabbccddeeff00112233445566778899');
    expect(sc.spanId).toBe('1122334455667788');
  });
});

// ─── redactor.ts（100,107,111-116,132,134-139 全覆盖）────────────────────────
describe('redactor', () => {
  test('undefined bag passthrough', () => {
    expect(redactBagWith(undefined, 'wire')).toBeUndefined();
  });

  test('deny-key substring → REDACTED (case-insensitive)', () => {
    const out = redactBagWith({ Authorization: 'Bearer abc', password: 'p', ok: 'keep' }, 'file')!;
    expect(out.Authorization).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.ok).toBe('keep');
  });

  test('deny-key 但数字/布尔值放行(token 用量计数不被误打码;密钥串仍打码)', () => {
    const out = redactBagWith(
      {
        inputTokens: 894, // 名字含 'token' 但是计数 → 保留
        outputTokens: 5,
        promptTokens: 899,
        'usage.cacheHitRate': 0.42,
        tokenBudgetExceeded: true, // 布尔 → 保留
        token: 'sk-ant-secretsecretsecret', // 字符串密钥 → 仍打码
      },
      'file',
    )!;
    expect(out.inputTokens).toBe(894);
    expect(out.outputTokens).toBe(5);
    expect(out.promptTokens).toBe(899);
    expect(out['usage.cacheHitRate']).toBe(0.42);
    expect(out.tokenBudgetExceeded).toBe(true);
    expect(out.token).toBe(REDACTED);
  });

  test('value-pattern masking on clean keys (sk-key / jwt / aws / inline-kv)', () => {
    const out = redactBagWith(
      {
        a: 'sk-ant-0123456789abcdef0123',
        b: 'header eyJabcdefgh.ijklmnopq.rstuvwxyz token',
        c: 'AKIAABCDEFGHIJKLMNOP',
        d: 'FOO_TOKEN=supersecretvalue',
      },
      'wire',
    )!;
    expect(out.a).toContain(REDACTED);
    expect(out.b).toContain(REDACTED);
    expect(out.c).toContain(REDACTED);
    expect(out.d).toContain(REDACTED);
  });

  test('string truncation past profile max (line 100)', () => {
    const big = 'x'.repeat(600);
    const wire = redactBagWith({ s: big }, 'wire')!.s as string;
    expect(wire.length).toBeLessThan(600);
    expect(wire).toContain('…(+');
    // file 档更宽:512<len(600)<4096 → 不截断
    expect((redactBagWith({ s: big }, 'file')!.s as string).length).toBe(600);
  });

  test('array + nested object recursion + scalars kept (lines 111-114)', () => {
    const out = redactBagWith(
      { arr: ['sk-ant-0123456789abcdef0123', 2, true], nested: { token: 'x', n: 5 } },
      'wire',
    )!;
    expect((out.arr as unknown[])[0]).toContain(REDACTED);
    expect((out.arr as unknown[])[1]).toBe(2);
    expect((out.arr as unknown[])[2]).toBe(true);
    expect((out.nested as Record<string, unknown>).token).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).n).toBe(5);
  });

  test('non-wire types (bigint/function/symbol) → REDACTED (line 116)', () => {
    const out = redactBagWith({ big: 10n, fn: () => 1, sym: Symbol('s') } as Record<string, unknown>, 'file')!;
    expect(out.big).toBe(REDACTED);
    expect(out.fn).toBe(REDACTED);
    expect(out.sym).toBe(REDACTED);
  });

  test('depth guard → REDACTED beyond 6 (line 107)', () => {
    let deep: Record<string, unknown> = { v: 'leaf' };
    for (let i = 0; i < 9; i++) deep = { child: deep };
    const out = redactBagWith(deep, 'file')!;
    // 一路下钻到 depth>6 必出现 REDACTED 截断
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  test('env-bag: wire drops whole; file recurses object; file non-object → REDACTED (132/134-139)', () => {
    const envObj = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef0123' };
    const wire = redactBagWith({ env: envObj }, 'wire')!;
    expect(wire.env).toBe(REDACTED); // 整 bag 不出墙

    const file = redactBagWith({ env: envObj }, 'file')!;
    const fenv = file.env as Record<string, unknown>;
    expect(fenv.PATH).toBe('/usr/bin'); // 非敏感保留
    expect(fenv.ANTHROPIC_API_KEY).toBe(REDACTED); // deny-key 命中

    const fileScalar = redactBagWith({ environment: 'a-string' }, 'file')!;
    expect(fileScalar.environment).toBe(REDACTED); // env-bag 名但值非对象 → REDACTED
  });

  test('redactStrictValueAtSource: string vs non-string', () => {
    expect(redactStrictValueAtSource('sk-ant-0123456789abcdef0123')).toContain(REDACTED);
    expect(redactStrictValueAtSource(42)).toBe(42);
    expect((redactStrictValueAtSource(['sk-ant-0123456789abcdef0123']) as unknown[])[0]).toContain(REDACTED);
  });
});

// ─── coalesce.ts（stop / maxBatch / send-throw / rate-limit 全分支）──────────
describe('coalesce', () => {
  function fakeTimers() {
    const q: Array<() => void> = [];
    return {
      setTimer: (cb: () => void) => {
        q.push(cb);
        return q.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      fire: () => {
        const cbs = q.splice(0);
        for (const cb of cbs) cb();
      },
      pending: () => q.length,
    };
  }

  test('window flush via timer', () => {
    const t = fakeTimers();
    const sent: TelemetryRecord[][] = [];
    const c = new Coalescer({ send: (b) => sent.push(b), setTimer: t.setTimer, clearTimer: t.clearTimer });
    c.push({ kind: 'log', ts: 1, level: 'info', msg: 'a' });
    c.push({ kind: 'log', ts: 2, level: 'info', msg: 'b' });
    expect(sent.length).toBe(0); // 还在窗口里
    t.fire();
    expect(sent).toEqual([[{ kind: 'log', ts: 1, level: 'info', msg: 'a' }, { kind: 'log', ts: 2, level: 'info', msg: 'b' }]]);
  });

  test('maxBatch immediate flush', () => {
    const t = fakeTimers();
    const sent: TelemetryRecord[][] = [];
    const c = new Coalescer({ send: (b) => sent.push(b), maxBatch: 2, setTimer: t.setTimer, clearTimer: t.clearTimer });
    c.push({ kind: 'log', ts: 1, level: 'info', msg: 'a' });
    c.push({ kind: 'log', ts: 2, level: 'info', msg: 'b' }); // 达 maxBatch → 立即 flush
    expect(sent.length).toBe(1);
  });

  test('flush empty = no-op; stop flushes; send-throw swallowed', () => {
    const t = fakeTimers();
    let calls = 0;
    const c = new Coalescer({
      send: () => {
        calls++;
        throw new Error('boom'); // 出口故障被吞
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    c.flush(); // 空 → no-op
    expect(calls).toBe(0);
    c.push({ kind: 'log', ts: 1, level: 'info', msg: 'a' });
    c.stop(); // = flush;send throw 不外泄
    expect(calls).toBe(1);
  });

  test('LogRateLimiter: within / over / window-reset / disabled', () => {
    let now = 1000;
    const rl = new LogRateLimiter({ perWindow: 2, windowMs: 100, now: () => now });
    expect(rl.allow('info')).toBe(true);
    expect(rl.allow('info')).toBe(true);
    expect(rl.allow('info')).toBe(false); // 超额
    now += 200; // 跨窗
    expect(rl.allow('info')).toBe(true);
    const off = new LogRateLimiter({ enabled: false });
    for (let i = 0; i < 1000; i++) expect(off.allow('error')).toBe(true);
  });

  test('default timers (no injection) flush asynchronously', async () => {
    const sent: TelemetryRecord[][] = [];
    const c = new Coalescer({ windowMs: 5, send: (b) => sent.push(b) });
    c.push({ kind: 'log', ts: 1, level: 'info', msg: 'a' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(1);
  });

  test('default clearTimer invoked when flushing with a pending timer', () => {
    const sent: TelemetryRecord[][] = [];
    const c = new Coalescer({ windowMs: 10_000, send: (b) => sent.push(b) }); // 默认 setTimeout/clearTimeout
    c.push({ kind: 'log', ts: 1, level: 'info', msg: 'a' }); // 起一个真 setTimeout
    c.flush(); // timer 仍挂 → 走默认 clearTimer(clearTimeout) 分支
    expect(sent.length).toBe(1);
  });
});

// ─── processor.ts（mapping 全分支 + onStart/onEnd catch + flush/shutdown）────
describe('processor', () => {
  function fakeSpan(o: Partial<{
    traceId: string; spanId: string; parentSpanId: string; name: string;
    start: [number, number]; end: [number, number];
    attributes: Record<string, unknown>;
    events: Array<{ name: string; time: [number, number]; attributes?: Record<string, unknown> }>;
    status: { code: number; message?: string };
  }>): ReadableSpan {
    return {
      name: o.name ?? 'sp',
      spanContext: () => ({ traceId: o.traceId ?? 't', spanId: o.spanId ?? 's', traceFlags: 1 }),
      parentSpanContext: o.parentSpanId ? { traceId: o.traceId ?? 't', spanId: o.parentSpanId, traceFlags: 1 } : undefined,
      startTime: o.start ?? [1, 0],
      endTime: o.end ?? [2, 0],
      attributes: o.attributes ?? {},
      events: o.events ?? [],
      status: o.status ?? { code: SpanStatusCode.UNSET },
    } as unknown as ReadableSpan;
  }

  test('hrTimeToMs undefined + value', () => {
    expect(hrTimeToMs(undefined)).toBeUndefined();
    expect(hrTimeToMs([2, 500_000_000])).toBe(2500);
  });

  test('provisional: no endTs/events/status; sid/agentId stamped; parent set', () => {
    const d = readableSpanToSpanData(
      fakeSpan({ parentSpanId: 'p', attributes: { sid: 'S', agentId: 'A', tool: 'echo' } }),
      true,
    );
    expect(d.provisional).toBe(true);
    expect(d.endTs).toBeUndefined();
    expect(d.parentSpanId).toBe('p');
    expect(d.sid).toBe('S');
    expect(d.agentId).toBe('A');
    expect(d.attrs).toEqual({ tool: 'echo' });
  });

  test('final: status OK/ERROR/UNSET, events, sid=null→undefined, empty attrs→undefined', () => {
    const ok = readableSpanToSpanData(fakeSpan({ status: { code: SpanStatusCode.OK, message: 'm' } }), false);
    expect(ok.status).toEqual({ code: 'ok', message: 'm' });
    expect(ok.endTs).toBe(2000);

    const err = readableSpanToSpanData(fakeSpan({ status: { code: SpanStatusCode.ERROR, message: 'bad' } }), false);
    expect(err.status).toEqual({ code: 'error', message: 'bad' });

    const unset = readableSpanToSpanData(fakeSpan({ status: { code: SpanStatusCode.UNSET } }), false);
    expect(unset.status).toBeUndefined();

    const withEvents = readableSpanToSpanData(
      fakeSpan({ events: [{ name: 'e1', time: [3, 0], attributes: { x: 1 } }, { name: 'e2', time: [4, 0] }] }),
      false,
    );
    expect(withEvents.events).toEqual([
      { name: 'e1', ts: 3000, attrs: { x: 1 } },
      { name: 'e2', ts: 4000, attrs: undefined },
    ]);

    const nullSid = readableSpanToSpanData(fakeSpan({ attributes: { sid: null, agentId: null } as Record<string, unknown> }), false);
    expect(nullSid.sid).toBeUndefined();
    expect(nullSid.agentId).toBeUndefined();
    expect(nullSid.attrs).toBeUndefined(); // 只有 sid/agentId 抽走后空
  });

  test('onStart emits provisional, onEnd emits final', () => {
    const got: SpanData[] = [];
    const p = new ForgeaxProcessor((s) => got.push(s));
    const span = fakeSpan({ name: 'agent.run' });
    p.onStart(span as unknown as Span, {} as Context);
    p.onEnd(span);
    expect(got[0].provisional).toBe(true);
    expect(got[1].provisional).toBeUndefined();
    expect(got[1].endTs).toBe(2000);
  });

  test('onStart/onEnd swallow emit throw; forceFlush/shutdown call hooks (and no-hook default)', async () => {
    const throwing = new ForgeaxProcessor(() => {
      throw new Error('emit boom');
    });
    // 不抛出到调用方
    throwing.onStart(fakeSpan({}) as unknown as Span, {} as Context);
    throwing.onEnd(fakeSpan({}));

    let flushed = false;
    let shut = false;
    const hooked = new ForgeaxProcessor(() => {}, {
      onForceFlush: () => {
        flushed = true;
      },
      onShutdown: () => {
        shut = true;
      },
    });
    await hooked.forceFlush();
    await hooked.shutdown();
    expect(flushed).toBe(true);
    expect(shut).toBe(true);

    // 无 hook 分支(?.()=undefined)也不报错
    const bare = new ForgeaxProcessor(() => {});
    await bare.forceFlush();
    await bare.shutdown();
  });
});

// ─── logger.ts（debug + mirror on/off + child extra + now 注入)─────────────
describe('logger', () => {
  const stubConsola = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('consola').ConsolaInstance;

  test('all levels emit LogRecord; mirror on uses consola; now injected', () => {
    const recs: LogRecord[] = [];
    let mirrored = 0;
    const spy = {
      debug() { mirrored++; },
      info() { mirrored++; },
      warn() { mirrored++; },
      error() { mirrored++; },
    } as unknown as import('consola').ConsolaInstance;
    const log = new ConsolaCoreLogger({ emitLog: (r) => recs.push(r), mirrorConsole: true, consola: spy, now: () => 42 });
    log.debug('d', { a: 1 });
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(recs.map((r) => r.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(recs[0]).toMatchObject({ ts: 42, msg: 'd', fields: { a: 1 } });
    expect(recs[1].fields).toBeUndefined(); // 无 fields & 无 extra → undefined
    expect(mirrored).toBe(4);
  });

  test('mirror off; child merges correlation + extra bindings', () => {
    const recs: LogRecord[] = [];
    const root = new ConsolaCoreLogger({ emitLog: (r) => recs.push(r), mirrorConsole: false, consola: stubConsola, now: () => 1 });
    const child = root.child({ traceId: 't1', spanId: 's1', sid: 'S', agentId: 'A', tag: 'x' });
    child.info('m', { k: 2 });
    const r = recs[0];
    expect(r).toMatchObject({ traceId: 't1', spanId: 's1', sid: 'S', agentId: 'A' });
    expect(r.fields).toEqual({ tag: 'x', k: 2 }); // 非关联 binding 进 fields
    // grandchild:叠加 spanId,且 null 关联键**不覆盖**父值(mergeBindings 37-40 的 v==null 分支)
    const grand = child.child({ spanId: 's2', traceId: null, sid: null, agentId: null, more: 9 } as Record<string, unknown>);
    grand.warn('g');
    const g = recs[1];
    expect(g.spanId).toBe('s2');
    expect(g.traceId).toBe('t1'); // null 不覆盖
    expect(g.sid).toBe('S'); // null 不覆盖
    expect(g.agentId).toBe('A'); // null 不覆盖
    expect(g.fields).toMatchObject({ tag: 'x', more: 9 });
  });

  test('default consola + mirror default (no opts) constructs without throwing', () => {
    const recs: LogRecord[] = [];
    const log = new ConsolaCoreLogger({ emitLog: (r) => recs.push(r), mirrorConsole: false });
    log.info('x');
    expect(recs.length).toBe(1);
  });
});

// ─── index.ts（OTLP push 138 + noopObservability + redactRecords 双形 + env fallback）─
describe('makeNodeObservability assembly', () => {
  test('otlpEndpoint set → constructs OTLP processor; internal send still flows', async () => {
    const got: TelemetryRecord[] = [];
    const obs = makeNodeObservability({
      send: (r) => got.push(...r),
      mirrorConsole: false,
      coalesceWindowMs: 5,
      otlpEndpoint: 'http://127.0.0.1:4318/v1/traces',
    });
    const s = obs.tracer.startSpan('agent.run', { attributes: { sid: 'x', agentId: 'a', secret: 'sk-ant-0123456789abcdef0123' } });
    s.end();
    obs.logger.child({ traceId: s.spanContext().traceId }).info('hi', { token: 'sk-ant-0123456789abcdef0123' });
    await new Promise((r) => setTimeout(r, 30));
    const spans = got.filter((x) => x.kind === 'span') as SpanData[];
    const logs = got.filter((x) => x.kind === 'log') as LogRecord[];
    expect(spans.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    // 出口 redactor(wire 默认)对 attrs/fields 生效
    expect((spans.find((x) => x.endTs != null)!.attrs as Record<string, unknown>).secret).toBe(REDACTED);
    expect((logs[0].fields as Record<string, unknown>).token).toBe(REDACTED);
  });

  test('rate-limit drop path (perWindow tiny) drops excess logs', async () => {
    const got: TelemetryRecord[] = [];
    const obs = makeNodeObservability({
      send: (r) => got.push(...r),
      mirrorConsole: false,
      coalesceWindowMs: 5,
      rateLimit: { enabled: true, perWindow: 1, windowMs: 10_000 },
    });
    const l = obs.logger.child({ traceId: 't' });
    l.info('one');
    l.info('two'); // 超额丢弃
    l.info('three');
    await new Promise((r) => setTimeout(r, 30));
    expect((got.filter((x) => x.kind === 'log')).length).toBe(1);
  });

  test('noopObservability + FORGEAX_OTLP_ENDPOINT env fallback path', async () => {
    const noop = noopObservability();
    noop.logger.info('x');
    noop.tracer.startSpan('y').end();
    await noop.shutdown(); // no-op shutdown
    expect(typeof noop.tracer.startSpan).toBe('function');

    const prev = process.env.FORGEAX_OTLP_ENDPOINT;
    process.env.FORGEAX_OTLP_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';
    try {
      const got: TelemetryRecord[] = [];
      const obs = makeNodeObservability({ send: (r) => got.push(...r), mirrorConsole: false, coalesceWindowMs: 5, redactProfile: 'file' });
      obs.tracer.startSpan('agent.run', { attributes: { agentId: 'a' } }).end();
      await new Promise((r) => setTimeout(r, 30));
      expect(got.filter((x) => x.kind === 'span').length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_OTLP_ENDPOINT;
      else process.env.FORGEAX_OTLP_ENDPOINT = prev;
    }
  });

  test('shutdown(): on-mode flushes + closes provider; off-mode stops coalescer', async () => {
    // on-mode:shutdown → provider.forceFlush(onForceFlush→coalescer.flush) + provider.shutdown(onShutdown→coalescer.stop)
    const got: TelemetryRecord[] = [];
    const on = makeNodeObservability({ send: (r) => got.push(...r), mirrorConsole: false, coalesceWindowMs: 10_000 });
    on.tracer.startSpan('agent.run', { attributes: { agentId: 'a' } }).end();
    await on.shutdown(); // 在窗口到期前强制刷出
    expect(got.filter((x) => x.kind === 'span').length).toBeGreaterThan(0);

    // off-mode:shutdown 仅排空 coalescer(log 仍出)
    const prev = process.env.FORGEAX_OTEL;
    process.env.FORGEAX_OTEL = 'off';
    try {
      const got2: TelemetryRecord[] = [];
      const off = makeNodeObservability({ send: (r) => got2.push(...r), mirrorConsole: false, coalesceWindowMs: 10_000 });
      off.logger.child({ traceId: 't' }).info('m');
      await off.shutdown();
      expect(got2.filter((x) => x.kind === 'log').length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_OTEL;
      else process.env.FORGEAX_OTEL = prev;
    }
  });
});

// ─── usage.ts:派生诊断指标(缓存命中率 / 提示词总量 / 错误摘要)纯单元穷尽 ──────────
describe('usage derived metrics', () => {
  test('promptTokens 求和(input+cacheRead+cacheCreation,不含 output)', () => {
    expect(promptTokens({ inputTokens: 10, outputTokens: 999, cacheRead: 30, cacheCreation: 60 })).toBe(100);
    expect(promptTokens({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 })).toBe(0);
  });

  test('cacheHitRate = cacheRead/提示词总量,4 位小数', () => {
    // 30/(10+30+60)=0.3
    expect(cacheHitRate({ inputTokens: 10, outputTokens: 5, cacheRead: 30, cacheCreation: 60 })).toBe(0.3);
    // 全命中
    expect(cacheHitRate({ inputTokens: 0, outputTokens: 5, cacheRead: 100, cacheCreation: 0 })).toBe(1);
    // 全未命中
    expect(cacheHitRate({ inputTokens: 100, outputTokens: 5, cacheRead: 0, cacheCreation: 0 })).toBe(0);
    // 四舍五入到 4 位:1/3 → 0.3333
    expect(cacheHitRate({ inputTokens: 2, outputTokens: 0, cacheRead: 1, cacheCreation: 0 })).toBe(0.3333);
  });

  test('cacheHitRate 提示词总量为 0 → 0(不抛除零)', () => {
    expect(cacheHitRate({ inputTokens: 0, outputTokens: 50, cacheRead: 0, cacheCreation: 0 })).toBe(0);
  });

  test('briefError:字符串 payload / 对象 payload / 裸结果 / 截断 / 容错', () => {
    // 工具结果常态形状 { payload: ... }
    expect(briefError({ payload: 'boom' })).toBe('boom');
    expect(briefError({ payload: { code: 'E', msg: 'x' } })).toBe('{"code":"E","msg":"x"}');
    // 无 payload → 退回裸结果
    expect(briefError('raw error')).toBe('raw error');
    // 截断 300 + 省略号
    const long = 'a'.repeat(500);
    const out = briefError({ payload: long });
    expect(out.length).toBe(301); // 300 + '…'
    expect(out.endsWith('…')).toBe(true);
    // 不可序列化(循环引用)→ 容错为 'tool error'
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(briefError({ payload: circ })).toBe('tool error');
  });
});
