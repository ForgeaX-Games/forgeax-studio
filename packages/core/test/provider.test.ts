/**
 * PROV — provider 层单测（Wave1）。
 *
 * 全部用假 fetch / 纯函数测，不打真网络。覆盖：
 *  - SSE 解析（字节 chunk 序列 → 帧）
 *  - normalizeAnthropicStream（帧 → 规范化 ProviderStreamEvent，含 assistant 聚合）
 *  - mergeUsage 累计（message_delta 0 不冲掉真值）
 *  - getRetryDelay 单调 / retry-after 优先
 *  - withRetry → FallbackTriggeredError / CannotRetryError 触发
 */
import { test, expect, describe } from 'bun:test';
import {
  parseSSE,
  normalizeAnthropicStream,
  buildRequestBody,
  systemBlocksToAnthropic,
  annotateMessageCache,
} from '../src/provider/anthropic';
import {
  getRetryDelay,
  withRetry,
  shouldRetry,
  is529Error,
  BASE_DELAY_MS,
} from '../src/provider/retry';
import { resolveProvider, listProviders, registerProvider } from '../src/provider/register';
import {
  mergeUsage,
  EMPTY_USAGE,
  FallbackTriggeredError,
  CannotRetryError,
  type ProviderStreamEvent,
  type ProviderRequest,
} from '../src/provider/types';

// ─── helpers ─────────────────────────────────────────────────────────────

/** 把一组字符串 chunk 包成 ReadableStream<Uint8Array>（模拟 fetch body）。 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const SAMPLE_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"do_thing"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

// ─── SSE parsing ───────────────────────────────────────────────────────────

describe('parseSSE', () => {
  test('splits multi-frame chunks into event/data pairs', async () => {
    const frames = await collect(parseSSE(streamFromChunks(SAMPLE_SSE)));
    expect(frames.length).toBe(11);
    expect(frames[0].event).toBe('message_start');
    expect(JSON.parse(frames[0].data).type).toBe('message_start');
    expect(frames[10].event).toBe('message_stop');
  });

  test('reassembles a frame split across byte chunks', async () => {
    // one logical frame delivered in 3 partial reads
    const split = [
      'event: content_block_delta\ndata: {"type":"content_block_delta",',
      '"index":0,"delta":{"type":"text_delta",',
      '"text":"X"}}\n\n',
    ];
    const frames = await collect(parseSSE(streamFromChunks(split)));
    expect(frames.length).toBe(1);
    expect(JSON.parse(frames[0].data).delta.text).toBe('X');
  });

  test('normalizes CRLF line endings', async () => {
    const frames = await collect(
      parseSSE(streamFromChunks(['event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'])),
    );
    expect(frames.length).toBe(1);
    expect(frames[0].event).toBe('message_stop');
  });
});

// ─── stream normalization ──────────────────────────────────────────────────

describe('normalizeAnthropicStream', () => {
  test('produces correct event sequence + aggregated assistant', async () => {
    const events = await collect(normalizeAnthropicStream(parseSSE(streamFromChunks(SAMPLE_SSE))));
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
      'assistant',
    ]);

    const assistant = events.find((e) => e.type === 'assistant') as Extract<
      ProviderStreamEvent,
      { type: 'assistant' }
    >;
    expect(assistant.stopReason).toBe('tool_use');
    // usage: input from message_start (100/50), output latest 42 from message_delta
    expect(assistant.usage.inputTokens).toBe(100);
    expect(assistant.usage.cacheReadInputTokens).toBe(50);
    expect(assistant.usage.outputTokens).toBe(42);

    const msg = assistant.message as { content: Array<Record<string, unknown>> };
    expect(msg.content.length).toBe(2);
    expect(msg.content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(msg.content[1]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'do_thing', input: { a: 1 } });
  });

  test('content_block_start carries blockType', async () => {
    const events = await collect(normalizeAnthropicStream(parseSSE(streamFromChunks(SAMPLE_SSE))));
    const starts = events.filter((e) => e.type === 'content_block_start') as Extract<
      ProviderStreamEvent,
      { type: 'content_block_start' }
    >[];
    expect(starts[0].blockType).toBe('text');
    expect(starts[1].blockType).toBe('tool_use');
  });

  test('malformed data lines are skipped, not thrown', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        parseSSE(
          streamFromChunks([
            'event: garbage\ndata: not-json\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ]),
        ),
      ),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('message_stop');
    expect(types).toContain('assistant');
  });
});

// ─── mergeUsage ─────────────────────────────────────────────────────────────

describe('mergeUsage accumulation', () => {
  test('input/cache only overwritten when > 0; output takes latest', () => {
    let u = EMPTY_USAGE;
    u = mergeUsage(u, { inputTokens: 100, cacheReadInputTokens: 50, outputTokens: 5 });
    expect(u.inputTokens).toBe(100);
    u = mergeUsage(u, { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 42 });
    expect(u.inputTokens).toBe(100);
    expect(u.cacheReadInputTokens).toBe(50);
    expect(u.outputTokens).toBe(42);
  });
});

// ─── request body construction ─────────────────────────────────────────────

describe('buildRequestBody', () => {
  const baseReq: ProviderRequest = {
    model: 'claude-opus-4-8',
    system: [{ type: 'text', text: 'You are X', cacheScope: 'global' }],
    tools: [{ name: 't', inputSchema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };

  test('sets stream + max_tokens + system + tools', () => {
    const body = buildRequestBody(baseReq);
    expect(body.stream).toBe(true);
    expect(typeof body.max_tokens).toBe('number');
    expect(Array.isArray(body.system)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
  });

  test('thinking enabled drops temperature + bumps max_tokens above budget', () => {
    const body = buildRequestBody({
      ...baseReq,
      temperature: 0.7,
      maxOutputTokens: 1000,
      thinking: { type: 'enabled', budgetTokens: 8192 },
    });
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.max_tokens as number).toBeGreaterThan(8192);
  });

  test('temperature passed through when thinking absent', () => {
    const body = buildRequestBody({ ...baseReq, temperature: 0.3 });
    expect(body.temperature).toBe(0.3);
  });

  test('systemBlocksToAnthropic puts cache_control on last scoped block', () => {
    const arr = systemBlocksToAnthropic([
      { type: 'text', text: 'a', cacheScope: 'global' },
      { type: 'text', text: 'b', cacheScope: null },
    ]) as Array<Record<string, unknown>>;
    expect(arr[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(arr[1].cache_control).toBeUndefined();
  });

  test('annotateMessageCache marks last user content block', () => {
    const msgs: Array<{ role: string; content: Array<Record<string, unknown>> }> = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    annotateMessageCache(msgs);
    expect(msgs[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ─── retry: getRetryDelay ──────────────────────────────────────────────────

describe('getRetryDelay', () => {
  test('retry-after header (seconds) takes priority', () => {
    expect(getRetryDelay(1, '5')).toBe(5000);
    expect(getRetryDelay(8, '2')).toBe(2000); // header beats backoff
  });

  test('exponential backoff is monotone in attempt (base, pre-jitter floor)', () => {
    // base = BASE_DELAY_MS * 2^(attempt-1); jitter ≤ 25% → attempt N+1 floor
    // (=2x base) always exceeds attempt N ceiling (=1.25x base).
    for (let a = 1; a <= 5; a++) {
      const lo = getRetryDelay(a);
      const hi = getRetryDelay(a);
      const base = BASE_DELAY_MS * Math.pow(2, a - 1);
      expect(lo).toBeGreaterThanOrEqual(base);
      expect(lo).toBeLessThanOrEqual(base * 1.25);
      expect(hi).toBeGreaterThanOrEqual(base);
    }
    // strict monotonic on the base (worst-case): a's ceiling < (a+1)'s floor
    for (let a = 1; a <= 5; a++) {
      const ceilA = BASE_DELAY_MS * Math.pow(2, a - 1) * 1.25;
      const floorNext = BASE_DELAY_MS * Math.pow(2, a);
      expect(ceilA).toBeLessThan(floorNext);
    }
  });

  test('respects maxDelayMs cap (before jitter)', () => {
    const d = getRetryDelay(20, undefined, 32000);
    expect(d).toBeLessThanOrEqual(32000 * 1.25);
    expect(d).toBeGreaterThanOrEqual(32000);
  });
});

// ─── retry: is529 / shouldRetry ────────────────────────────────────────────

describe('error classification', () => {
  test('is529Error detects status and overloaded message', () => {
    expect(is529Error({ status: 529 })).toBe(true);
    expect(is529Error({ message: 'stream: {"type":"overloaded_error"}' })).toBe(true);
    expect(is529Error({ status: 500 })).toBe(false);
  });

  test('shouldRetry: 429/5xx retry, 400/401 do not', () => {
    expect(shouldRetry({ status: 429 })).toBe(true);
    expect(shouldRetry({ status: 503 })).toBe(true);
    expect(shouldRetry({ status: 400 })).toBe(false);
    expect(shouldRetry({ status: 401 })).toBe(false);
    expect(shouldRetry({ code: 'ECONNRESET' })).toBe(true);
  });
});

// ─── retry: withRetry ──────────────────────────────────────────────────────

describe('withRetry', () => {
  const noSleep = async () => {};

  test('returns on first success', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { model: 'm', sleep: noSleep },
    );
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries transient then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(
      async (attempt) => {
        calls++;
        if (attempt < 3) throw { status: 503, message: 'overloaded' };
        return attempt;
      },
      { model: 'm', sleep: noSleep },
    );
    expect(r).toBe(3);
    expect(calls).toBe(3);
  });

  test('529 streak with fallbackModel throws FallbackTriggeredError', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 529 };
        },
        { model: 'opus', fallbackModel: 'sonnet', sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(FallbackTriggeredError);
    // 3rd consecutive 529 trips fallback
    expect(calls).toBe(3);
  });

  test('terminal 400 throws CannotRetryError without retrying', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 400, message: 'bad request' };
        },
        { model: 'm', sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(CannotRetryError);
    expect(calls).toBe(1);
  });

  test('exhausting maxRetries throws CannotRetryError', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 500 };
        },
        { model: 'm', maxRetries: 2, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(CannotRetryError);
    expect(calls).toBe(3); // initial + 2 retries
  });

  test('abort propagates as AbortError (not wrapped)', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      withRetry(async () => 'never', { model: 'm', signal: ac.signal, sleep: noSleep }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ─── register ──────────────────────────────────────────────────────────────

describe('provider registry', () => {
  test('anthropic-messages is registered by default', () => {
    expect(listProviders()).toContain('anthropic-messages');
  });

  test('resolveProvider returns a provider with matching api', () => {
    const p = resolveProvider('anthropic-messages', { apiKey: 'sk-test' });
    expect(p.api).toBe('anthropic-messages');
    expect(typeof p.stream).toBe('function');
  });

  test('unknown api throws', () => {
    expect(() => resolveProvider('nope', { apiKey: 'x' })).toThrow(/unknown provider api/);
  });

  test('registerProvider overrides + resolves', () => {
    registerProvider('test-backend', () => ({
      api: 'test-backend',
      async *stream() {},
    }));
    expect(resolveProvider('test-backend', { apiKey: 'x' }).api).toBe('test-backend');
  });
});
