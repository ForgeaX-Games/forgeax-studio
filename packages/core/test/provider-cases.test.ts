/**
 * provider-cases — provider 层「错误/边缘路径」补验证用例(目标 ≥90% lines)。
 *
 * 与既有 provider.test.ts / provider-backends.test.ts / stream-retry.test.ts 互补:
 * 那两份覆盖正常路径与主聚合;本文件**只补未覆盖的错误/边缘分支**——
 *   - anthropic: 非-2xx 抛错带 status / retry-after、SSE 跨 chunk 重组、thinking &
 *     redacted_thinking & signature_delta、tool_use input 累计、adaptive thinking、
 *     cache_creation 细分、message_stop 带 requestId、工厂层 fetch 错误路径。
 *   - openai-compat / openai-response / gemini: image content 映射、tool_result→text、
 *     finishReason 各分支、stream 结束未见 finish 时的残留收口、throwHttpError 带 status、
 *     工厂层非-2xx + 缺 body 抛错。
 *   - retry: getStatus/is529/shouldRetry 各分支、getRetryDelay retry-after 优先、
 *     getRetryAfterHeader 从 retryAfterMs 反推、getDefaultMaxRetries env、defaultSleep
 *     正常 resolve / abort reject、withRetry 重试→成功/耗尽→CannotRetry/529→Fallback/abort。
 *   - stream-retry: signal 已 aborted 时直接 return、retryAfterMs 反推 header。
 *
 * 全部假 fetch(`globalThis.fetch = ... as unknown as typeof fetch`)+ ReadableStream
 * mock,不打真网络。
 */
import { test, expect, describe, afterEach } from 'bun:test';

import {
  parseSSE,
  normalizeAnthropicStream,
  buildRequestBody,
  systemBlocksToAnthropic,
  annotateMessageCache,
} from '../src/provider/anthropic';
import {
  normalizeOpenAIStream,
  buildOpenAIRequestBody,
  messagesToOpenAI,
} from '../src/provider/openai-compat';
import {
  normalizeResponsesStream,
  messagesToResponseInput,
  buildResponsesRequestBody,
} from '../src/provider/openai-response';
import {
  normalizeGeminiStream,
  messagesToGemini,
  geminiUsageToPartial,
  buildGeminiRequestBody,
} from '../src/provider/gemini';
import {
  getStatus,
  is529Error,
  shouldRetry,
  getRetryDelay,
  getDefaultMaxRetries,
  withRetry,
} from '../src/provider/retry';
import { streamWithRetry } from '../src/provider/stream-retry';
import { resolveProvider } from '../src/provider/register';
import {
  FallbackTriggeredError,
  CannotRetryError,
  type LLMProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
} from '../src/provider/types';

// ─── helpers ─────────────────────────────────────────────────────────────

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

/** OpenAI/DeepSeek SSE 帧(无 event 行)。 */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
/** 带具名 event 的 SSE 帧(Anthropic / Responses)。 */
function sseEvt(event: string, obj: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function assistantOf(events: ProviderStreamEvent[]) {
  return events.find((e) => e.type === 'assistant') as Extract<
    ProviderStreamEvent,
    { type: 'assistant' }
  >;
}

const BASE_REQ: ProviderRequest = {
  model: 'claude-opus-4-8',
  system: [{ type: 'text', text: 'You are X', cacheScope: 'global' }],
  tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

const noSleep = async () => {};
const liveSignal = () => new AbortController().signal;

// ════════════════════════════════════════════════════════════════════════════
// Anthropic — thinking / redacted_thinking / tool_use input 累计 / cache 细分
// ════════════════════════════════════════════════════════════════════════════

describe('anthropic: thinking + redacted_thinking + signature', () => {
  const STREAM = [
    sseEvt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sseEvt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' rea' } }),
    sseEvt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'son' } }),
    sseEvt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
    sseEvt('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvt('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENC' } }),
    sseEvt('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseEvt('message_stop', { type: 'message_stop' }),
  ];

  test('thinking_delta accumulates and signature attaches; redacted_thinking passes data', async () => {
    const events = await collect(normalizeAnthropicStream(parseSSE(streamFromChunks(STREAM))));
    const a = assistantOf(events);
    const content = (a.message as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'thinking', thinking: ' reason', signature: 'sig-abc' });
    expect(content[1]).toEqual({ type: 'redacted_thinking', data: 'ENC' });
    // content_block_start for thinking surfaces blockType 'thinking'
    const starts = events.filter((e) => e.type === 'content_block_start') as Extract<
      ProviderStreamEvent,
      { type: 'content_block_start' }
    >[];
    expect(starts[0].blockType).toBe('thinking');
    expect(starts[1].blockType).toBe('thinking');
  });
});

describe('anthropic: tool_use input json accumulated across deltas', () => {
  test('partial_json fragments concatenate then JSON.parse into input', async () => {
    const STREAM = [
      sseEvt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_9', name: 'fn' } }),
      sseEvt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"k":' } }),
      sseEvt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"v"}' } }),
      sseEvt('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseEvt('message_stop', { type: 'message_stop' }),
    ];
    const a = assistantOf(await collect(normalizeAnthropicStream(parseSSE(streamFromChunks(STREAM)))));
    const content = (a.message as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'tool_use', id: 'tu_9', name: 'fn', input: { k: 'v' } });
  });

  test('malformed tool_use args fall back to empty input (defensive)', async () => {
    const STREAM = [
      sseEvt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'fn' } }),
      sseEvt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'not-json' } }),
      sseEvt('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sseEvt('message_stop', { type: 'message_stop' }),
    ];
    const a = assistantOf(await collect(normalizeAnthropicStream(parseSSE(streamFromChunks(STREAM)))));
    const content = (a.message as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'tool_use', id: 'tu_1', name: 'fn', input: {} });
  });
});

describe('anthropic: message_start usage cache_creation detail + requestId', () => {
  test('cache_creation ephemeral 1h/5m mapped; assistant carries requestId', async () => {
    const STREAM = [
      sseEvt('message_start', {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 80,
            cache_creation_input_tokens: 12,
            cache_creation: { ephemeral_1h_input_tokens: 4, ephemeral_5m_input_tokens: 8 },
          },
        },
      }),
      sseEvt('message_stop', { type: 'message_stop' }),
    ];
    const events = await collect(
      normalizeAnthropicStream(parseSSE(streamFromChunks(STREAM)), { requestId: 'req_xyz' }),
    );
    const a = assistantOf(events);
    expect(a.requestId).toBe('req_xyz');
    expect(a.usage.cacheCreationInputTokens).toBe(12);
    expect(a.usage.cacheCreation).toEqual({ ephemeral1h: 4, ephemeral5m: 8 });
  });
});

describe('anthropic: buildRequestBody adaptive thinking', () => {
  test('adaptive thinking sets {type:adaptive} and omits temperature', () => {
    const body = buildRequestBody({ ...BASE_REQ, temperature: 0.5, thinking: { type: 'adaptive' } });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.temperature).toBeUndefined();
  });

  test('disabled thinking still passes temperature', () => {
    const body = buildRequestBody({ ...BASE_REQ, temperature: 0.2, thinking: { type: 'disabled' } });
    expect(body.temperature).toBe(0.2);
    expect(body.thinking).toBeUndefined();
  });

  test('enablePromptCaching=false skips message cache annotation', () => {
    const req: ProviderRequest = {
      ...BASE_REQ,
      enablePromptCaching: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const body = buildRequestBody(req);
    const msgs = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[0].content[0].cache_control).toBeUndefined();
  });

  test('annotateMessageCache skipCacheWrite targets second-to-last user', () => {
    const msgs: Array<{ role: string; content: Array<Record<string, unknown>> }> = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ];
    annotateMessageCache(msgs, true);
    expect(msgs[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(msgs[2].content[0].cache_control).toBeUndefined();
  });

  test('systemBlocksToAnthropic marks last consecutive scoped block', () => {
    const arr = systemBlocksToAnthropic([
      { type: 'text', text: 'a', cacheScope: 'global' },
      { type: 'text', text: 'b', cacheScope: 'org' },
    ]) as Array<Record<string, unknown>>;
    // first has a next-with-scope → no marker; second is last scoped → marker
    expect(arr[0].cache_control).toBeUndefined();
    expect(arr[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Anthropic — factory fetch error path (non-2xx with status + retry-after)
// ════════════════════════════════════════════════════════════════════════════

describe('anthropic: factory error + success via fake fetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('non-2xx throws Error with status + retryAfterMs from retry-after header', async () => {
    globalThis.fetch = (async () =>
      new Response('overloaded', {
        status: 529,
        headers: { 'retry-after': '3' },
      })) as unknown as typeof fetch;
    const provider = resolveProvider('anthropic-messages', { apiKey: 'sk-test' });
    await expect(
      collect(provider.stream(BASE_REQ, { signal: liveSignal() })),
    ).rejects.toMatchObject({ status: 529, retryAfterMs: 3000 });
  });

  test('2xx drives SSE → aggregated assistant with requestId from request-id header', async () => {
    globalThis.fetch = (async () =>
      new Response(
        streamFromChunks([
          sseEvt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          sseEvt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
          sseEvt('content_block_stop', { type: 'content_block_stop', index: 0 }),
          sseEvt('message_stop', { type: 'message_stop' }),
        ]),
        { status: 200, headers: { 'request-id': 'rq_42' } },
      )) as unknown as typeof fetch;
    const provider = resolveProvider('anthropic-messages', { apiKey: 'sk-test', baseUrl: 'https://x.y/' });
    const a = assistantOf(await collect(provider.stream(BASE_REQ, { signal: liveSignal() })));
    expect((a.message as { content: unknown[] }).content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(a.requestId).toBe('rq_42');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OpenAI-compat — image content / tool_result text / finish branches / residual
// ════════════════════════════════════════════════════════════════════════════

describe('openai-compat: content mapping edges', () => {
  test('image block → image_url data URL; mixed parts stay array', () => {
    const msgs = messagesToOpenAI(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
          ],
        },
      ],
      [],
    ) as Array<Record<string, unknown>>;
    const parts = msgs[0].content as Array<Record<string, unknown>>;
    expect(parts).toContainEqual({ type: 'text', text: 'see' });
    expect(parts).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
  });

  test('tool_result with block content → joined text on role:tool', () => {
    const msgs = messagesToOpenAI(
      [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          ],
        },
      ],
      [],
    ) as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: 'tool', tool_call_id: 'tc_1', content: 'ab' });
  });
});

describe('openai-compat: finish_reason branches', () => {
  test('function_call finish → tool_use, content_filter → refusal, length → max_tokens', async () => {
    const mk = async (finish: string) => {
      const a = assistantOf(
        await collect(
          normalizeOpenAIStream(
            parseSSE(streamFromChunks([sse({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: finish }] })])),
          ),
        ),
      );
      return a.stopReason;
    };
    expect(await mk('function_call')).toBe('tool_use');
    expect(await mk('content_filter')).toBe('refusal');
    expect(await mk('length')).toBe('max_tokens');
    expect(await mk('weird')).toBe(null);
  });

  test('stream ends without finish_reason → residual tool_call collected', async () => {
    const chunks = [
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc_9', function: { name: 'fn', arguments: '{"a":1}' } }] } }] }),
      // no finish chunk, no [DONE]
    ];
    const a = assistantOf(await collect(normalizeOpenAIStream(parseSSE(streamFromChunks(chunks)))));
    const content = (a.message as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'tool_use', id: 'tc_9', name: 'fn', input: { a: 1 } });
  });

  test('residual tool_call with malformed args → empty input', async () => {
    const chunks = [
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'fn', arguments: 'nope' } }] } }] }),
    ];
    const a = assistantOf(await collect(normalizeOpenAIStream(parseSSE(streamFromChunks(chunks)))));
    const content = (a.message as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toMatchObject({ type: 'tool_use', name: 'fn', input: {} });
  });
});

describe('openai-compat: factory error via fake fetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('non-2xx throws with status + retryAfterMs', async () => {
    globalThis.fetch = (async () =>
      new Response('limit', { status: 503, headers: { 'retry-after': '1' } })) as unknown as typeof fetch;
    const provider = resolveProvider('openai-compat', { apiKey: 'sk-test' });
    await expect(
      collect(provider.stream({ ...BASE_REQ, model: 'gpt-4o' }, { signal: liveSignal() })),
    ).rejects.toMatchObject({ status: 503, retryAfterMs: 1000 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OpenAI-responses — image / tool_result / string content / residual / factory
// ════════════════════════════════════════════════════════════════════════════

describe('openai-responses: input mapping edges', () => {
  test('image block → input_image data url; tool_result → function_call_output', () => {
    const input = messagesToResponseInput([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
          { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'r' }] },
        ],
      },
    ]) as Array<Record<string, unknown>>;
    // tool_result emitted first, then user message with image
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'r' });
    const userMsg = input.find((i) => (i as Record<string, unknown>).role === 'user') as Record<string, unknown>;
    expect(userMsg.content).toContainEqual({ type: 'input_image', image_url: 'data:image/png;base64,BBBB' });
  });

  test('string assistant + string user content degrade to message items', () => {
    const input = messagesToResponseInput([
      { role: 'assistant', content: 'plain reply' },
      { role: 'user', content: 'plain ask' },
    ]) as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'plain reply' }] });
    expect(input[1]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'plain ask' }] });
  });

  test('buildResponsesRequestBody passes temperature when no thinking', () => {
    const body = buildResponsesRequestBody({ ...BASE_REQ, temperature: 0.4 });
    expect(body.temperature).toBe(0.4);
    expect(body.reasoning).toBeUndefined();
  });
});

describe('openai-responses: response.completed residual tool call + failed event', () => {
  test('tool call open at completed (no .done) gets collected', async () => {
    const chunks = [
      sseEvt('response.output_item.added', {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'fn', arguments: '{"a":1}' },
      }),
      sseEvt('response.completed', {
        type: 'response.completed',
        response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ];
    const a = assistantOf(await collect(normalizeResponsesStream(parseSSE(streamFromChunks(chunks)))));
    const content = (a.message as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'fn', input: { a: 1 } });
    expect(a.stopReason).toBe('tool_use');
  });

  test('response.failed throws with derived status (invalid_request_error → 400)', async () => {
    const chunks = [
      sseEvt('response.failed', {
        type: 'response.failed',
        response: { error: { type: 'invalid_request_error', message: 'bad input' } },
      }),
    ];
    await expect(
      collect(normalizeResponsesStream(parseSSE(streamFromChunks(chunks)), { model: 'gpt-5' })),
    ).rejects.toMatchObject({ status: 400 });
  });

  test('error event without typed status still throws (no status field)', async () => {
    const chunks = [sseEvt('error', { type: 'error', error: { message: 'boom' } })];
    await expect(
      collect(normalizeResponsesStream(parseSSE(streamFromChunks(chunks)))),
    ).rejects.toThrow(/openai-responses stream error/);
  });
});

describe('openai-responses: factory error via fake fetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('non-2xx throws with status + retryAfterMs', async () => {
    globalThis.fetch = (async () =>
      new Response('rate', { status: 429, headers: { 'retry-after': '4' } })) as unknown as typeof fetch;
    const provider = resolveProvider('openai-responses', { apiKey: 'sk-test', baseUrl: 'https://x.y' });
    await expect(
      collect(provider.stream({ ...BASE_REQ, model: 'gpt-5' }, { signal: liveSignal() })),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 4000 });
  });

  test('2xx drives SSE → assistant aggregated', async () => {
    globalThis.fetch = (async () =>
      new Response(
        streamFromChunks([
          sseEvt('response.output_text.delta', { type: 'response.output_text.delta', delta: 'yo' }),
          sseEvt('response.completed', { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } } }),
        ]),
        { status: 200, headers: { 'x-request-id': 'rr_1' } },
      )) as unknown as typeof fetch;
    const provider = resolveProvider('openai-responses', { apiKey: 'sk-test' });
    const a = assistantOf(await collect(provider.stream({ ...BASE_REQ, model: 'gpt-5' }, { signal: liveSignal() })));
    expect((a.message as { content: unknown[] }).content[0]).toEqual({ type: 'text', text: 'yo' });
    expect(a.requestId).toBe('rr_1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Gemini — image / tool_use part / tool_result text / usage edges / factory
// ════════════════════════════════════════════════════════════════════════════

describe('gemini: content mapping edges', () => {
  test('image block → inlineData; assistant tool_use → functionCall part', () => {
    const contents = messagesToGemini([
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' } }],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'fn', input: { z: 9 } }] },
    ]) as Array<Record<string, unknown>>;
    expect((contents[0].parts as Array<Record<string, unknown>>)[0]).toEqual({
      inlineData: { data: 'CCCC', mimeType: 'image/webp' },
    });
    expect((contents[1].parts as Array<Record<string, unknown>>)[0]).toEqual({
      functionCall: { name: 'fn', args: { z: 9 } },
    });
  });

  test('tool_result with block content joins text into functionResponse', () => {
    const contents = messagesToGemini([
      {
        role: 'user',
        content: [{ type: 'tool_result', name: 'fn', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] }],
      },
    ]) as Array<Record<string, unknown>>;
    expect((contents[0].parts as Array<Record<string, unknown>>)[0]).toEqual({
      functionResponse: { name: 'fn', response: { result: 'xy' } },
    });
  });

  test('geminiUsageToPartial with no candidate/thought counts omits outputTokens', () => {
    expect(geminiUsageToPartial({ promptTokenCount: 7 })).toEqual({ inputTokens: 7 });
    expect(geminiUsageToPartial(undefined)).toEqual({});
  });

  test('image without media_type defaults to image/png; string content path', () => {
    const contents = messagesToGemini([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'DDDD' } }] },
      { role: 'assistant', content: 'reply text' },
    ]) as Array<Record<string, unknown>>;
    expect((contents[0].parts as Array<Record<string, unknown>>)[0]).toEqual({
      inlineData: { data: 'DDDD', mimeType: 'image/png' },
    });
    expect(contents[1]).toEqual({ role: 'model', parts: [{ text: 'reply text' }] });
  });

  test('buildGeminiRequestBody passes temperature when no thinking', () => {
    const body = buildGeminiRequestBody({ ...BASE_REQ, model: 'gemini-2.0-flash', temperature: 0.6 });
    const gc = body.generationConfig as Record<string, unknown>;
    expect(gc.temperature).toBe(0.6);
    expect(gc.thinkingConfig).toBeUndefined();
  });

  test('finishReason MAX_TOKENS → max_tokens, SAFETY → refusal (not overridden by tool_use)', async () => {
    const mk = async (fr: string) => {
      const a = assistantOf(
        await collect(
          normalizeGeminiStream(
            parseSSE(
              streamFromChunks([
                sse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: fr }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
              ]),
            ),
          ),
        ),
      );
      return a.stopReason;
    };
    expect(await mk('MAX_TOKENS')).toBe('max_tokens');
    expect(await mk('SAFETY')).toBe('refusal');
  });

  test('malformed chunk data is skipped, not thrown', async () => {
    const chunks = [
      'data: not-json\n\n',
      sse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    ];
    const a = assistantOf(await collect(normalizeGeminiStream(parseSSE(streamFromChunks(chunks)))));
    expect((a.message as { content: unknown[] }).content[0]).toEqual({ type: 'text', text: 'ok' });
  });
});

describe('gemini: factory error via fake fetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('non-2xx throws with status', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const provider = resolveProvider('gemini', { apiKey: 'k', baseUrl: 'https://g/' });
    await expect(
      collect(provider.stream({ ...BASE_REQ, model: 'gemini-2.0-flash' }, { signal: liveSignal() })),
    ).rejects.toMatchObject({ status: 500 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// retry — getStatus / is529 / shouldRetry / getRetryDelay / env / sleep / withRetry
// ════════════════════════════════════════════════════════════════════════════

describe('retry: getStatus & is529Error & shouldRetry branches', () => {
  test('getStatus reads status then statusCode then undefined', () => {
    expect(getStatus({ status: 503 })).toBe(503);
    expect(getStatus({ statusCode: 429 })).toBe(429);
    expect(getStatus({})).toBeUndefined();
    expect(getStatus('string-err')).toBeUndefined();
  });

  test('is529Error false when neither status nor overloaded message', () => {
    expect(is529Error({ status: 500 })).toBe(false);
    expect(is529Error(new Error('plain'))).toBe(false);
  });

  test('shouldRetry: 409 retryable; 404/422 terminal; <500 unknown not retryable', () => {
    expect(shouldRetry({ status: 409 })).toBe(true);
    expect(shouldRetry({ status: 408 })).toBe(true);
    expect(shouldRetry({ status: 404 })).toBe(false);
    expect(shouldRetry({ status: 422 })).toBe(false);
    expect(shouldRetry({ status: 418 })).toBe(false); // 4xx not in retryable set
  });

  test('shouldRetry: error code nested in cause → retryable', () => {
    expect(shouldRetry({ cause: { code: 'ECONNRESET' } })).toBe(true);
  });

  test('shouldRetry: no status, no code → conservatively retry', () => {
    expect(shouldRetry({ message: 'mystery' })).toBe(true);
  });
});

describe('retry: getRetryDelay & getDefaultMaxRetries', () => {
  test('retry-after non-numeric header falls through to backoff', () => {
    const d = getRetryDelay(1, 'soon');
    expect(d).toBeGreaterThanOrEqual(500);
    expect(d).toBeLessThanOrEqual(500 * 1.25);
  });

  test('getDefaultMaxRetries reads env override then default', () => {
    const prev = process.env.FORGEAX_MAX_RETRIES;
    process.env.FORGEAX_MAX_RETRIES = '4';
    try {
      expect(getDefaultMaxRetries()).toBe(4);
      process.env.FORGEAX_MAX_RETRIES = 'not-a-number';
      expect(getDefaultMaxRetries()).toBe(10); // falls back to DEFAULT
    } finally {
      if (prev === undefined) delete process.env.FORGEAX_MAX_RETRIES;
      else process.env.FORGEAX_MAX_RETRIES = prev;
    }
  });
});

describe('retry: withRetry default sleep path + retryAfter-derived delay', () => {
  test('real defaultSleep resolves; retryAfterMs error short-circuits delay', async () => {
    let calls = 0;
    const start = Date.now();
    const r = await withRetry(
      async (attempt) => {
        calls++;
        if (attempt === 1) throw { status: 503, retryAfterMs: 10 }; // ~10ms via real sleep
        return 'done';
      },
      { model: 'm', maxRetries: 2 },
    );
    expect(r).toBe('done');
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('aborted signal before first attempt throws AbortError', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      withRetry(async () => 'x', { model: 'm', signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('abort mid-flight (sleep rejects) propagates AbortError', async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          // schedule abort during the upcoming real sleep
          setTimeout(() => ac.abort(), 0);
          throw { status: 503 };
        }
        return 'never';
      },
      { model: 'm', signal: ac.signal, maxRetries: 5 },
    );
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('initialConsecutive529Errors pre-seeds streak → fallback sooner', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 529 };
        },
        { model: 'opus', fallbackModel: 'sonnet', sleep: noSleep, initialConsecutive529Errors: 2 },
      ),
    ).rejects.toBeInstanceOf(FallbackTriggeredError);
    expect(calls).toBe(1); // 2 (seed) + 1 = MAX_529_RETRIES(3)
  });

  test('non-529 error resets 529 streak (no premature fallback)', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async (attempt) => {
          calls++;
          // alternate 529 / 503 so streak never reaches 3
          throw attempt % 2 === 1 ? { status: 529 } : { status: 503 };
        },
        { model: 'opus', fallbackModel: 'sonnet', maxRetries: 4, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(CannotRetryError);
    expect(calls).toBe(5); // exhausted without ever tripping fallback
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stream-retry — aborted signal early return + retryAfterMs header derivation
// ════════════════════════════════════════════════════════════════════════════

describe('stream-retry: abort + retry-after', () => {
  test('already-aborted signal returns immediately without calling provider', async () => {
    const ac = new AbortController();
    ac.abort();
    let called = 0;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        called++;
      },
    };
    const out = await collect(
      streamWithRetry(provider, { model: 'm', system: [], tools: [], messages: [] }, { signal: ac.signal }, { sleep: noSleep }),
    );
    expect(out.length).toBe(0);
    expect(called).toBe(0);
  });

  test('retryAfterMs error derives header → sleep delay (retried then ok)', async () => {
    let n = 0;
    let sleptMs = -1;
    const provider: LLMProvider = {
      api: 'x',
      async *stream() {
        n++;
        if (n === 1) throw Object.assign(new Error('slow'), { status: 429, retryAfterMs: 2000 });
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          stopReason: 'end_turn',
        } as ProviderStreamEvent;
      },
    };
    const out = await collect(
      streamWithRetry(
        provider,
        { model: 'm', system: [], tools: [], messages: [] },
        { signal: liveSignal() },
        { sleep: async (ms) => { sleptMs = ms; } },
      ),
    );
    expect(n).toBe(2);
    expect(out.length).toBe(1);
    expect(sleptMs).toBe(2000); // 2000ms ← round(2000/1000)*1000 via retryAfterHeader
  });
});
