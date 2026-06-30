/**
 * T23 — streamWithRetry: retry-before-first-event, model fallback, no mid-stream retry.
 */
import { test, expect, describe } from 'bun:test';
import { streamWithRetry } from '../src/provider/stream-retry';
import { FallbackTriggeredError } from '../src/provider/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent } from '../src/provider/types';

const noSleep = async () => {};
const req: ProviderRequest = { model: 'm1', system: [], tools: [], messages: [] };

function evt(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, stopReason: 'end_turn' };
}

async function drain(it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('streamWithRetry', () => {
  test('retries a pre-event 503 then succeeds', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        if (n === 1) throw Object.assign(new Error('boom'), { status: 503 });
        yield evt('ok');
      },
    };
    const out = await drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep }));
    expect(n).toBe(2);
    expect(out.length).toBe(1);
  });

  test('does NOT retry once events have started (mid-stream error propagates)', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        yield evt('partial');
        throw Object.assign(new Error('mid'), { status: 503 });
      },
    };
    await expect(drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep }))).rejects.toThrow('mid');
    expect(n).toBe(1); // no retry after first event
  });

  test('FallbackTriggeredError switches to fallbackModel', async () => {
    const seen: string[] = [];
    const provider: LLMProvider = {
      api: 'x',
      async *stream(r) {
        seen.push(r.model);
        if (r.model === 'm1') throw new FallbackTriggeredError('m1', 'm2');
        yield evt('fallback-ok');
      },
    };
    let fellBack = false;
    const out = await drain(
      streamWithRetry(provider, req, { signal: new AbortController().signal, fallbackModel: 'm2', onStreamingFallback: () => (fellBack = true) }, { sleep: noSleep }),
    );
    expect(seen).toEqual(['m1', 'm2']);
    expect(fellBack).toBe(true);
    expect(out.length).toBe(1);
  });

  test('non-retryable 400 propagates immediately', async () => {
    let n = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        throw Object.assign(new Error('bad'), { status: 400 });
      },
    };
    await expect(drain(streamWithRetry(provider, req, { signal: new AbortController().signal }, { sleep: noSleep, maxRetries: 5 }))).rejects.toThrow('bad');
    expect(n).toBe(1);
  });
});
