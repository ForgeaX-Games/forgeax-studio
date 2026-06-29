/**
 * observability wire schema 单测(Schema-as-Contract)。
 * 覆盖 SpanData / LogRecord / TelemetryRecord(discriminated union)/ TelemetryEnvelope 的
 * parse 通过 + reject 路径,确保线缆契约可机验。
 */
import { describe, it, expect } from 'bun:test';
import { SpanData, LogRecord, TelemetryRecord, TelemetryEnvelope } from '../src/observability';

describe('SpanData', () => {
  it('accepts a minimal final span', () => {
    const r = SpanData.safeParse({ kind: 'span', traceId: 't', spanId: 's', name: 'agent.run', startTs: 1 });
    expect(r.success).toBe(true);
  });

  it('accepts a full span (parent/endTs/provisional/attrs/events/status/sid/agentId)', () => {
    const r = SpanData.safeParse({
      kind: 'span', traceId: 't', spanId: 's', parentSpanId: 'p', name: 'tool',
      startTs: 1, endTs: 2, provisional: false,
      attrs: { tool: 'echo' },
      events: [{ name: 'e', ts: 1, attrs: { x: 1 } }, { name: 'e2', ts: 2 }],
      status: { code: 'ok', message: 'm' },
      sid: 'S', agentId: 'A',
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing required fields and wrong kind/status enum', () => {
    expect(SpanData.safeParse({ kind: 'span', traceId: 't' }).success).toBe(false); // 缺 spanId/name/startTs
    expect(SpanData.safeParse({ kind: 'log', traceId: 't', spanId: 's', name: 'n', startTs: 1 }).success).toBe(false);
    expect(
      SpanData.safeParse({ kind: 'span', traceId: 't', spanId: 's', name: 'n', startTs: 1, status: { code: 'weird' } }).success,
    ).toBe(false);
  });
});

describe('LogRecord', () => {
  it('accepts minimal + full', () => {
    expect(LogRecord.safeParse({ kind: 'log', ts: 1, level: 'info', msg: 'm' }).success).toBe(true);
    expect(
      LogRecord.safeParse({ kind: 'log', ts: 1, level: 'error', msg: 'm', fields: { k: 1 }, traceId: 't', spanId: 's', sid: 'S', agentId: 'A' }).success,
    ).toBe(true);
  });
  it('rejects bad level + missing msg', () => {
    expect(LogRecord.safeParse({ kind: 'log', ts: 1, level: 'trace', msg: 'm' }).success).toBe(false);
    expect(LogRecord.safeParse({ kind: 'log', ts: 1, level: 'info' }).success).toBe(false);
  });
});

describe('TelemetryRecord (discriminated union)', () => {
  it('routes by kind and rejects unknown kind', () => {
    expect(TelemetryRecord.safeParse({ kind: 'span', traceId: 't', spanId: 's', name: 'n', startTs: 1 }).success).toBe(true);
    expect(TelemetryRecord.safeParse({ kind: 'log', ts: 1, level: 'info', msg: 'm' }).success).toBe(true);
    expect(TelemetryRecord.safeParse({ kind: 'weird' }).success).toBe(false);
  });
});

describe('TelemetryEnvelope', () => {
  it('accepts both信道 type + mixed records', () => {
    expect(
      TelemetryEnvelope.safeParse({
        type: 'telemetry',
        records: [
          { kind: 'span', traceId: 't', spanId: 's', name: 'n', startTs: 1 },
          { kind: 'log', ts: 2, level: 'info', msg: 'm' },
        ],
      }).success,
    ).toBe(true);
    expect(TelemetryEnvelope.safeParse({ type: 'VAG_TELEMETRY', records: [] }).success).toBe(true);
  });
  it('rejects bad envelope type + non-array records + invalid record inside', () => {
    expect(TelemetryEnvelope.safeParse({ type: 'nope', records: [] }).success).toBe(false);
    expect(TelemetryEnvelope.safeParse({ type: 'telemetry', records: {} }).success).toBe(false);
    expect(TelemetryEnvelope.safeParse({ type: 'telemetry', records: [{ kind: 'span' }] }).success).toBe(false);
  });
});
