/**
 * PROV — 多 provider backend 单测（openai-compat / openai-responses / gemini / deepseek-v4）。
 *
 * 全部用假 fetch / ReadableStream mock + 纯 normalize 函数测，不打真网络。覆盖：
 *  - 每个 backend 的 SSE 解析 → 规范化 ProviderStreamEvent 事件序列 + 聚合 assistant
 *  - tool_call 增量累积 → tool_use 块 + stopReason='tool_use'
 *  - usage 映射（prompt/completion/cached → input/output/cacheRead；mergeUsage 累计）
 *  - 请求体构造（per-model 字段分派、thinking、system/tools）
 *  - registry：4 个 backend 已注册、resolveProvider 实例化
 */
import { test, expect, describe, afterEach } from 'bun:test';

import {
  parseSSE,
} from '../src/provider/anthropic';
import {
  normalizeOpenAIStream,
  buildOpenAIRequestBody,
  messagesToOpenAI,
  openAIUsageToPartial,
  usesCompletionTokensField,
  disallowsTemperatureField,
  normalizeOpenAIBaseUrl,
} from '../src/provider/openai-compat';
import {
  normalizeResponsesStream,
  buildResponsesRequestBody,
  messagesToResponseInput,
  responsesUsageToPartial,
} from '../src/provider/openai-response';
import {
  normalizeGeminiStream,
  buildGeminiRequestBody,
  messagesToGemini,
  geminiUsageToPartial,
} from '../src/provider/gemini';
import { buildDeepSeekRequestBody, createDeepSeekProvider } from '../src/provider/deepseek';
import { resolveProvider, listProviders } from '../src/provider/register';
import type { ProviderRequest, ProviderStreamEvent } from '../src/provider/types';

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

/** OpenAI/DeepSeek/Responses SSE: `data: {...}\n\n`（无 event 行）。 */
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Responses 带具名 event。 */
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
  model: 'gpt-4o',
  system: [{ type: 'text', text: 'You are X', cacheScope: 'global' }],
  tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

// ════════════════════════════════════════════════════════════════════════════
// OpenAI Chat Completions
// ════════════════════════════════════════════════════════════════════════════

describe('openai-compat: normalizeOpenAIStream', () => {
  const TEXT_THEN_TOOL = [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }),
    sse({ choices: [{ index: 0, delta: { content: 'lo' } }] }),
    sse({
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'tc_1', function: { name: 'do_thing', 'arguments': '{"a":' } }] } },
      ],
    }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { 'arguments': '1}' } }] } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 50 } } }),
    'data: [DONE]\n\n',
  ];

  test('emits message_start → blocks → message_delta → message_stop → assistant', async () => {
    const events = await collect(normalizeOpenAIStream(parseSSE(streamFromChunks(TEXT_THEN_TOOL))));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_delta');
    expect(types).toContain('content_block_stop');
    expect(types).toContain('message_delta');
    expect(types[types.length - 2]).toBe('message_stop');
    expect(types[types.length - 1]).toBe('assistant');
  });

  test('aggregates text + tool_use blocks with parsed input', async () => {
    const events = await collect(normalizeOpenAIStream(parseSSE(streamFromChunks(TEXT_THEN_TOOL))));
    const a = assistantOf(events);
    expect(a.stopReason).toBe('tool_use');
    const msg = a.message as { content: Array<Record<string, unknown>> };
    expect(msg.content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(msg.content[1]).toEqual({ type: 'tool_use', id: 'tc_1', name: 'do_thing', input: { a: 1 } });
  });

  test('maps usage prompt/completion/cached → input/output/cacheRead', async () => {
    const events = await collect(normalizeOpenAIStream(parseSSE(streamFromChunks(TEXT_THEN_TOOL))));
    const a = assistantOf(events);
    expect(a.usage.inputTokens).toBe(100);
    expect(a.usage.outputTokens).toBe(42);
    expect(a.usage.cacheReadInputTokens).toBe(50);
  });

  test('extractReasoning surfaces reasoning_content as thinking block', async () => {
    const chunks = [
      sse({ choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] }),
      sse({ choices: [{ index: 0, delta: { content: 'answer' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    ];
    const events = await collect(
      normalizeOpenAIStream(parseSSE(streamFromChunks(chunks)), { extractReasoning: true }),
    );
    const a = assistantOf(events);
    const msg = a.message as { content: Array<Record<string, unknown>> };
    expect(msg.content[0]).toEqual({ type: 'thinking', thinking: 'thinking...' });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'answer' });
    expect(a.stopReason).toBe('end_turn');
  });

  test('malformed data line skipped, not thrown', async () => {
    const events = await collect(
      normalizeOpenAIStream(
        parseSSE(streamFromChunks([
          'data: not-json\n\n',
          sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        ])),
      ),
    );
    expect(events.map((e) => e.type)).toContain('assistant');
  });
});

describe('openai-compat: request body', () => {
  test('sets stream + stream_options + max_tokens + system + tools', () => {
    const body = buildOpenAIRequestBody(BASE_REQ);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(typeof body.max_tokens).toBe('number');
    expect(Array.isArray(body.tools)).toBe(true);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are X' });
  });

  test('gpt-5 family uses max_completion_tokens + drops temperature', () => {
    expect(usesCompletionTokensField('gpt-5.4-mini-2026')).toBe(true);
    expect(disallowsTemperatureField('o3')).toBe(true);
    const body = buildOpenAIRequestBody({ ...BASE_REQ, model: 'gpt-5', temperature: 0.7, maxOutputTokens: 1000 });
    expect(body.max_completion_tokens).toBe(1000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  test('legacy model keeps max_tokens + temperature', () => {
    const body = buildOpenAIRequestBody({ ...BASE_REQ, temperature: 0.3, maxOutputTokens: 512 });
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.3);
  });

  test('messagesToOpenAI splits tool_result to role:tool and tool_use to tool_calls', () => {
    const msgs = messagesToOpenAI(
      [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'tc_1', name: 'fn', input: { x: 1 } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: 'result text' }],
        },
      ],
      [],
    ) as Array<Record<string, unknown>>;
    const asst = msgs[0];
    expect(asst.role).toBe('assistant');
    expect(asst.content).toBe('calling');
    expect((asst.tool_calls as unknown[]).length).toBe(1);
    const toolMsg = msgs[1];
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'tc_1', content: 'result text' });
  });

  test('openAIUsageToPartial reads deepseek top-level cache hit', () => {
    expect(openAIUsageToPartial({ prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 7 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 7,
    });
  });

  test('normalizeOpenAIBaseUrl appends /v1 when missing', () => {
    expect(normalizeOpenAIBaseUrl('https://api.openai.com')).toBe('https://api.openai.com/v1');
    expect(normalizeOpenAIBaseUrl('https://x.y/v1/')).toBe('https://x.y/v1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DeepSeek (openai-compat variant)
// ════════════════════════════════════════════════════════════════════════════

describe('deepseek-v4', () => {
  test('buildDeepSeekRequestBody adds thinking enabled/disabled', () => {
    const off = buildDeepSeekRequestBody(BASE_REQ);
    expect(off.thinking).toEqual({ type: 'disabled' });
    const on = buildDeepSeekRequestBody({ ...BASE_REQ, thinking: { type: 'enabled' } });
    expect(on.thinking).toEqual({ type: 'enabled' });
    // still an openai-compat body underneath
    expect(on.stream).toBe(true);
  });

  test('factory reuses openai-compat stream normalization', async () => {
    const provider = createDeepSeekProvider({ apiKey: 'sk-test' });
    expect(provider.api).toBe('deepseek-v4');
    expect(typeof provider.stream).toBe('function');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OpenAI Responses
// ════════════════════════════════════════════════════════════════════════════

describe('openai-responses: normalizeResponsesStream', () => {
  const RESP_STREAM = [
    sseEvt('response.created', { type: 'response.created', response: { id: 'resp_1' } }),
    sseEvt('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hel' }),
    sseEvt('response.output_text.delta', { type: 'response.output_text.delta', delta: 'lo' }),
    sseEvt('response.output_text.done', { type: 'response.output_text.done' }),
    sseEvt('response.output_item.added', {
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'do_thing', arguments: '' },
    }),
    sseEvt('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'item_1',
      delta: '{"a":1}',
    }),
    sseEvt('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: 'item_1',
      arguments: '{"a":1}',
    }),
    sseEvt('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: { input_tokens: 100, output_tokens: 42, input_tokens_details: { cached_tokens: 30 } },
      },
    }),
  ];

  test('produces text + tool_use blocks, tool_use stopReason, usage', async () => {
    const events = await collect(normalizeResponsesStream(parseSSE(streamFromChunks(RESP_STREAM))));
    const a = assistantOf(events);
    expect(a.stopReason).toBe('tool_use');
    const msg = a.message as { content: Array<Record<string, unknown>> };
    expect(msg.content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(msg.content[1]).toEqual({ type: 'tool_use', id: 'call_1', name: 'do_thing', input: { a: 1 } });
    expect(a.usage.inputTokens).toBe(100);
    expect(a.usage.outputTokens).toBe(42);
    expect(a.usage.cacheReadInputTokens).toBe(30);
  });

  test('event sequence starts with message_start, ends with assistant', async () => {
    const events = await collect(normalizeResponsesStream(parseSSE(streamFromChunks(RESP_STREAM))));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types[types.length - 1]).toBe('assistant');
    expect(types).toContain('message_delta');
  });

  test('reasoning delta surfaces as thinking block', async () => {
    const chunks = [
      sseEvt('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', delta: 'mmm' }),
      sseEvt('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done' }),
      sseEvt('response.output_text.delta', { type: 'response.output_text.delta', delta: 'ok' }),
      sseEvt('response.completed', { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } } }),
    ];
    const events = await collect(normalizeResponsesStream(parseSSE(streamFromChunks(chunks))));
    const a = assistantOf(events);
    const msg = a.message as { content: Array<Record<string, unknown>> };
    expect(msg.content[0]).toEqual({ type: 'thinking', thinking: 'mmm' });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'ok' });
  });

  test('error event throws with status', async () => {
    const chunks = [
      sseEvt('error', { type: 'error', error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'slow down' } }),
    ];
    await expect(
      collect(normalizeResponsesStream(parseSSE(streamFromChunks(chunks)), { model: 'gpt-5' })),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe('openai-responses: request body + input mapping', () => {
  test('system → instructions, tools flat shape, max_output_tokens', () => {
    const body = buildResponsesRequestBody(BASE_REQ);
    expect(body.instructions).toBe('You are X');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(typeof body.max_output_tokens).toBe('number');
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: 'function', name: 't' });
  });

  test('thinking enables reasoning + drops temperature', () => {
    const body = buildResponsesRequestBody({ ...BASE_REQ, temperature: 0.7, thinking: { type: 'enabled' } });
    expect(body.reasoning).toBeDefined();
    expect(body.temperature).toBeUndefined();
  });

  test('messagesToResponseInput emits function_call + function_call_output items', () => {
    const input = messagesToResponseInput([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'doing' },
          { type: 'tool_use', id: 'call_1', name: 'fn', input: { x: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'res' }] },
    ]) as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'doing' }] });
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'call_1', name: 'fn', arguments: '{"x":1}' });
    expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'res' });
  });

  test('responsesUsageToPartial maps input/output/cached', () => {
    expect(
      responsesUsageToPartial({ input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } }),
    ).toEqual({ inputTokens: 9, outputTokens: 3, cacheReadInputTokens: 4 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Gemini
// ════════════════════════════════════════════════════════════════════════════

describe('gemini: normalizeGeminiStream', () => {
  const GEMINI_STREAM = [
    sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] }),
    sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] } }] }),
    sse({
      candidates: [
        { content: { role: 'model', parts: [{ functionCall: { name: 'do_thing', args: { a: 1 } } }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 2, cachedContentTokenCount: 10 },
    }),
  ];

  test('aggregates text + tool_use, tool_use stopReason, usage', async () => {
    const events = await collect(normalizeGeminiStream(parseSSE(streamFromChunks(GEMINI_STREAM))));
    const a = assistantOf(events);
    const msg = a.message as { content: Array<Record<string, unknown>> };
    expect(msg.content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(msg.content[1]).toMatchObject({ type: 'tool_use', name: 'do_thing', input: { a: 1 } });
    // finishReason STOP but has tool_use → corrected to tool_use
    expect(a.stopReason).toBe('tool_use');
    // output = candidates(40) + thoughts(2)
    expect(a.usage.inputTokens).toBe(100);
    expect(a.usage.outputTokens).toBe(42);
    expect(a.usage.cacheReadInputTokens).toBe(10);
  });

  test('thought parts surface as thinking blocks', async () => {
    const chunks = [
      sse({ candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }] } }] }),
      sse({ candidates: [{ content: { parts: [{ text: 'final' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }),
    ];
    const events = await collect(normalizeGeminiStream(parseSSE(streamFromChunks(chunks))));
    const a = assistantOf(events);
    const msg = a.message as { content: Array<Record<string, unknown>> };
    expect(msg.content[0]).toEqual({ type: 'thinking', thinking: 'reasoning' });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'final' });
    expect(a.stopReason).toBe('end_turn');
  });

  test('event sequence message_start..assistant', async () => {
    const events = await collect(normalizeGeminiStream(parseSSE(streamFromChunks(GEMINI_STREAM))));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message_start');
    expect(types).toContain('message_delta');
    expect(types[types.length - 1]).toBe('assistant');
  });
});

describe('gemini: request body + mapping', () => {
  test('system → systemInstruction, tools functionDeclarations, generationConfig', () => {
    const body = buildGeminiRequestBody(BASE_REQ);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are X' }] });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect((tools[0].functionDeclarations as unknown[]).length).toBe(1);
    expect((body.generationConfig as Record<string, unknown>).maxOutputTokens).toBeDefined();
  });

  test('thinking sets thinkingConfig + drops temperature', () => {
    const body = buildGeminiRequestBody({ ...BASE_REQ, temperature: 0.7, thinking: { type: 'enabled', budgetTokens: 2048 } });
    const gc = body.generationConfig as Record<string, unknown>;
    expect(gc.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 2048 });
    expect(gc.temperature).toBeUndefined();
  });

  test('messagesToGemini maps roles and tool_result functionResponse', () => {
    const contents = messagesToGemini([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'fn', input: { x: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', name: 'fn', content: 'res' }] },
    ]) as Array<Record<string, unknown>>;
    expect(contents[0].role).toBe('model');
    expect((contents[0].parts as Array<Record<string, unknown>>)[0]).toEqual({
      functionCall: { name: 'fn', args: { x: 1 } },
    });
    expect(contents[1].role).toBe('user');
    expect((contents[1].parts as Array<Record<string, unknown>>)[0]).toEqual({
      functionResponse: { name: 'fn', response: { result: 'res' } },
    });
  });

  test('geminiUsageToPartial sums candidates + thoughts', () => {
    expect(
      geminiUsageToPartial({ promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 1 }),
    ).toEqual({ inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 1 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Registry
// ════════════════════════════════════════════════════════════════════════════

describe('registry: backends registered', () => {
  test('all 4 new backends listed', () => {
    const list = listProviders();
    expect(list).toContain('openai-compat');
    expect(list).toContain('openai-responses');
    expect(list).toContain('gemini');
    expect(list).toContain('deepseek-v4');
  });

  test('resolveProvider instantiates each with matching api', () => {
    for (const api of ['openai-compat', 'openai-responses', 'gemini', 'deepseek-v4']) {
      const p = resolveProvider(api, { apiKey: 'sk-test' });
      expect(p.api).toBe(api);
      expect(typeof p.stream).toBe('function');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// End-to-end via fake fetch (factory → stream → events)
// ════════════════════════════════════════════════════════════════════════════

describe('fake-fetch e2e', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('openai-compat factory drives a mocked SSE response', async () => {
    globalThis.fetch = (async () =>
      new Response(
        streamFromChunks([
          sse({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }),
          sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        ]),
        { status: 200, headers: { 'x-request-id': 'req_1' } },
      )) as unknown as typeof fetch;

    const provider = resolveProvider('openai-compat', { apiKey: 'sk-test' });
    const events = await collect(provider.stream(BASE_REQ, { signal: new AbortController().signal }));
    const a = assistantOf(events);
    expect((a.message as { content: unknown[] }).content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(a.usage.inputTokens).toBe(3);
    expect(a.requestId).toBe('req_1');
  });

  test('non-ok response throws with status for retry classification', async () => {
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })) as unknown as typeof fetch;
    const provider = resolveProvider('gemini', { apiKey: 'k' });
    await expect(
      collect(provider.stream({ ...BASE_REQ, model: 'gemini-2.0-flash' }, { signal: new AbortController().signal })),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 2000 });
  });
});
