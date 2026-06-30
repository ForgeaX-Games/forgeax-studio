/**
 * OpenAI Responses API provider (C4) — POST `${baseUrl}/responses`，SSE 流式，api='openai-responses'。
 *
 * Wire 形状(对齐 cli `src/llm/openai-response.ts`，只读)：
 *   - 顶层 system → `instructions`(string)。
 *   - 历史 → `input: any[]`，typed items：
 *       {role:"user", content:[{type:"input_text"|"input_image", ...}]}
 *       {type:"message", role:"assistant", content:[{type:"output_text", text}]}
 *       {type:"function_call", call_id, name, arguments}（assistant tool call，平铺顶层）
 *       {type:"function_call_output", call_id, output}（tool result）
 *   - SSE 事件名(下划线!)：response.created / .output_item.added /
 *       .function_call_arguments.delta|.done / .output_text.delta|.done /
 *       response.reasoning*.delta|.done / response.completed / error|response.failed
 *   - usage：response.completed.response.usage = {input_tokens, output_tokens,
 *       input_tokens_details:{cached_tokens}, output_tokens_details:{reasoning_tokens}}。
 *
 * 规范化成 C4 ProviderStreamEvent（同 anthropic：合成 content_block_* 边界 + assistant 聚合）。
 *
 * Boundary：只 import core-local；走 fetch，不引外部 SDK。复用 anthropic.parseSSE。
 */

import { parseSSE } from './anthropic';
import {
  EMPTY_USAGE,
  mergeUsage,
  type LLMProvider,
  type ProviderCallOpts,
  type ProviderFactory,
  type ProviderFactoryOpts,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderStreamEvent,
  type ProviderToolDef,
  type StopReason,
  type SystemBlock,
  type Usage,
} from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// ─── 请求体构造 ─────────────────────────────────────────────────────────────

export function systemBlocksToInstructions(blocks: SystemBlock[]): string | undefined {
  const text = blocks
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
  return text.length > 0 ? text : undefined;
}

export function toolDefsToResponses(tools: ProviderToolDef[]): unknown[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

/** 中立 content block → Responses `input_*` content part。 */
function neutralBlockToInputPart(raw: unknown): unknown | undefined {
  if (typeof raw === 'string') return { type: 'input_text', text: raw };
  if (!raw || typeof raw !== 'object') return undefined;
  const block = raw as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'input_text', text: block.text };
  }
  if (block.type === 'image' && block.source && typeof block.source === 'object') {
    const src = block.source as Record<string, unknown>;
    if (src.type === 'base64' && typeof src.data === 'string') {
      const media = typeof src.media_type === 'string' ? src.media_type : 'image/png';
      return { type: 'input_image', image_url: `data:${media};base64,${src.data}` };
    }
  }
  return undefined;
}

function neutralContentToInputList(content: unknown): unknown[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const raw of content) {
    const p = neutralBlockToInputPart(raw);
    if (p) parts.push(p);
  }
  return parts;
}

/** tool_result.content → Responses function_call_output.output（string）。 */
function toolResultToOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'text') {
        const t = (raw as Record<string, unknown>).text;
        return typeof t === 'string' ? t : '';
      }
      return '';
    })
    .join('');
}

/** 中立 ProviderMessage[] → Responses `input` 数组。 */
export function messagesToResponseInput(messages: ProviderMessage[]): unknown[] {
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(
        (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result',
      );
      const rest = msg.content.filter(
        (b) => !(b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result'),
      );
      for (const tr of toolResults) {
        const block = tr as Record<string, unknown>;
        out.push({
          type: 'function_call_output',
          call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '_tool',
          output: toolResultToOutput(block.content),
        });
      }
      if (rest.length > 0) {
        out.push({ role: 'user', content: neutralContentToInputList(rest) });
      }
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textParts: unknown[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      for (const raw of msg.content) {
        if (!raw || typeof raw !== 'object') continue;
        const block = raw as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          textParts.push({ type: 'output_text', text: block.text });
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            type: 'function_call',
            call_id: typeof block.id === 'string' ? block.id : '_tool',
            name: typeof block.name === 'string' ? block.name : 'unknown_tool',
            arguments: JSON.stringify(block.input ?? {}),
          });
        }
      }
      if (textParts.length > 0) {
        out.push({ type: 'message', role: 'assistant', content: textParts });
      }
      for (const tc of toolCalls) out.push(tc);
      continue;
    }

    // string content 或非数组 → 退化为 input_text user/assistant 消息。
    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    } else {
      out.push({ role: 'user', content: neutralContentToInputList(msg.content) });
    }
  }
  return out;
}

export function buildResponsesRequestBody(req: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: messagesToResponseInput(req.messages),
    stream: true,
    store: false,
  };
  const instructions = systemBlocksToInstructions(req.system);
  if (instructions) body.instructions = instructions;

  const tools = toolDefsToResponses(req.tools);
  if (tools) body.tools = tools;

  body.max_output_tokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  if (req.thinking && req.thinking.type !== 'disabled') {
    body.reasoning = { effort: 'medium', summary: 'auto' };
  } else if (typeof req.temperature === 'number') {
    body.temperature = req.temperature;
  }

  return body;
}

// ─── usage 映射 ─────────────────────────────────────────────────────────────

export function responsesUsageToPartial(raw: Record<string, unknown> | undefined): Partial<Usage> {
  if (!raw) return {};
  const out: Partial<Usage> = {};
  if (typeof raw.input_tokens === 'number') out.inputTokens = raw.input_tokens;
  if (typeof raw.output_tokens === 'number') out.outputTokens = raw.output_tokens;
  const details = raw.input_tokens_details as Record<string, unknown> | undefined;
  if (details && typeof details.cached_tokens === 'number') {
    out.cacheReadInputTokens = details.cached_tokens;
  }
  return out;
}

// ─── 流事件规范化 ───────────────────────────────────────────────────────────

type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface PendingCall {
  callId: string;
  name: string;
  args: string;
  blockIndex: number;
}

/** Responses stream 错误 → 带 status 的 Error（供 retry.ts 分类）。 */
function throwStreamError(parsed: Record<string, unknown>, model: string): never {
  const response = parsed.response as Record<string, unknown> | undefined;
  const error = (parsed.error ?? response?.error) as Record<string, unknown> | undefined;
  const errType = typeof error?.type === 'string' ? error.type : undefined;
  const code = (typeof error?.code === 'string' && error.code) || errType;
  const message =
    typeof error?.message === 'string' ? error.message : 'Responses stream failed';
  const status =
    errType === 'invalid_request_error' || code === 'context_length_exceeded'
      ? 400
      : errType === 'rate_limit_error' || code === 'rate_limit_exceeded'
        ? 429
        : undefined;
  const err = new Error(
    `openai-responses stream error${code ? ` (${code})` : ''}: ${message}`,
  ) as Error & { status?: number; model: string };
  if (status) err.status = status;
  err.model = model;
  throw err;
}

/**
 * Responses SSE 帧序列 → ProviderStreamEvent。纯逻辑，便于测试。
 * 帧含 {event, data}；event 缺时回落到 parsed.type。
 */
export async function* normalizeResponsesStream(
  frames: AsyncIterable<{ event?: string; data: string }>,
  opts?: { requestId?: string; signal?: AbortSignal; model?: string },
): AsyncGenerator<ProviderStreamEvent> {
  let usage: Usage = { ...EMPTY_USAGE };
  let stopReason: StopReason = null;
  let startedEmitted = false;
  let nextIndex = 0;

  let textIndex = -1;
  let textBuf = '';
  let thinkingIndex = -1;
  let thinkingBuf = '';

  // pendingCalls 按 SSE item_id 定位载体（output_item.added 起，arguments.done 收）。
  const pending = new Map<string, PendingCall>();
  const blocks: AssistantBlock[] = [];

  const ensureStarted = function* (): Generator<ProviderStreamEvent> {
    if (!startedEmitted) {
      startedEmitted = true;
      yield { type: 'message_start', usage: {} };
    }
  };

  const closeText = function* (): Generator<ProviderStreamEvent> {
    if (textIndex >= 0) {
      const block: AssistantBlock = { type: 'text', text: textBuf };
      blocks.push(block);
      yield { type: 'content_block_stop', index: textIndex, block };
      textIndex = -1;
      textBuf = '';
    }
  };

  const closeThinking = function* (): Generator<ProviderStreamEvent> {
    if (thinkingIndex >= 0) {
      const block: AssistantBlock = { type: 'thinking', thinking: thinkingBuf };
      blocks.push(block);
      yield { type: 'content_block_stop', index: thinkingIndex, block };
      thinkingIndex = -1;
      thinkingBuf = '';
    }
  };

  for await (const { event, data } of frames) {
    if (opts?.signal?.aborted) break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (event ?? (parsed.type as string | undefined)) as string | undefined;
    if (!type) continue;

    yield* ensureStarted();

    if (type === 'error' || type === 'response.failed') {
      throwStreamError(parsed, opts?.model ?? '');
    }

    if (type === 'response.output_item.added') {
      const item = parsed.item as Record<string, unknown> | undefined;
      if (item?.type === 'function_call' && typeof item.id === 'string') {
        yield* closeText();
        yield* closeThinking();
        const blockIndex = nextIndex++;
        pending.set(item.id, {
          callId: typeof item.call_id === 'string' ? item.call_id : item.id,
          name: typeof item.name === 'string' ? item.name : '',
          args: typeof item.arguments === 'string' ? item.arguments : '',
          blockIndex,
        });
        yield { type: 'content_block_start', index: blockIndex, blockType: 'tool_use' };
      }
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      const itemId = parsed.item_id;
      const delta = parsed.delta;
      if (typeof itemId === 'string' && typeof delta === 'string') {
        const pc = pending.get(itemId);
        if (pc) {
          pc.args += delta;
          yield {
            type: 'content_block_delta',
            index: pc.blockIndex,
            delta: { type: 'input_json_delta', partial_json: delta },
          };
        }
      }
      continue;
    }

    if (type === 'response.function_call_arguments.done') {
      const itemId = parsed.item_id;
      const final = parsed.arguments;
      if (typeof itemId === 'string') {
        const pc = pending.get(itemId);
        if (pc) {
          if (typeof final === 'string') pc.args = final;
          let input: Record<string, unknown> = {};
          try {
            input = pc.args ? (JSON.parse(pc.args) as Record<string, unknown>) : {};
          } catch {
            input = {};
          }
          const block: AssistantBlock = {
            type: 'tool_use',
            id: pc.callId || '_tool',
            name: pc.name || 'unknown_tool',
            input,
          };
          blocks.push(block);
          pending.delete(itemId);
          yield { type: 'content_block_stop', index: pc.blockIndex, block };
        }
      }
      continue;
    }

    if (type === 'response.output_text.delta') {
      const delta = parsed.delta;
      if (typeof delta === 'string' && delta.length > 0) {
        yield* closeThinking();
        if (textIndex < 0) {
          textIndex = nextIndex++;
          yield { type: 'content_block_start', index: textIndex, blockType: 'text' };
        }
        textBuf += delta;
        yield { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta } };
      }
      continue;
    }

    if (type === 'response.output_text.done') {
      yield* closeText();
      continue;
    }

    // 推理摘要流（事件名跨版本变动 → 用前后缀匹配）。
    if (type.startsWith('response.reasoning') && type.endsWith('.delta')) {
      const delta = parsed.delta;
      if (typeof delta === 'string' && delta.length > 0) {
        if (thinkingIndex < 0) {
          thinkingIndex = nextIndex++;
          yield { type: 'content_block_start', index: thinkingIndex, blockType: 'thinking' };
        }
        thinkingBuf += delta;
        yield {
          type: 'content_block_delta',
          index: thinkingIndex,
          delta: { type: 'thinking_delta', thinking: delta },
        };
      }
      continue;
    }
    if (type.startsWith('response.reasoning') && type.endsWith('.done')) {
      yield* closeThinking();
      continue;
    }

    if (type === 'response.completed') {
      const r = (parsed.response ?? {}) as Record<string, unknown>;
      const rawUsage = r.usage as Record<string, unknown> | undefined;
      if (rawUsage) usage = mergeUsage(usage, responsesUsageToPartial(rawUsage));
      yield* closeText();
      yield* closeThinking();
      // 收口未显式 .done 的 tool call（防御）。
      for (const [, pc] of pending) {
        let input: Record<string, unknown> = {};
        try {
          input = pc.args ? (JSON.parse(pc.args) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        const block: AssistantBlock = {
          type: 'tool_use',
          id: pc.callId || '_tool',
          name: pc.name || 'unknown_tool',
          input,
        };
        blocks.push(block);
        yield { type: 'content_block_stop', index: pc.blockIndex, block };
      }
      pending.clear();
      stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      yield { type: 'message_delta', usage: {}, stopReason };
      continue;
    }
  }

  yield* ensureStarted();
  yield { type: 'message_stop' };
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: blocks },
    usage,
    stopReason,
    ...(opts?.requestId ? { requestId: opts.requestId } : {}),
  };
}

// ─── HTTP 错误 ──────────────────────────────────────────────────────────────

function throwHttpError(res: Response, text: string, model: string): never {
  const err = new Error(`openai-responses API error ${res.status}: ${text.slice(0, 500)}`) as Error & {
    status: number;
    model: string;
    responseText: string;
    retryAfterMs?: number;
  };
  err.status = res.status;
  err.model = model;
  err.responseText = text;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) err.retryAfterMs = seconds * 1000;
  }
  throw err;
}

// ─── base url 规范化 ─────────────────────────────────────────────────────────

export function normalizeResponsesBaseUrl(url: string): string {
  let u = url.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

// ─── Provider 工厂 ──────────────────────────────────────────────────────────

export const createOpenAIResponseProvider: ProviderFactory = (
  opts: ProviderFactoryOpts,
): LLMProvider => {
  const base = normalizeResponsesBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
  const url = `${base}/responses`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
    accept: 'text/event-stream',
    ...(opts.headers ?? {}),
  };

  return {
    api: 'openai-responses',
    async *stream(
      req: ProviderRequest,
      callOpts: ProviderCallOpts,
    ): AsyncIterable<ProviderStreamEvent> {
      const body = buildResponsesRequestBody(req);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: callOpts.signal,
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : '';
        throwHttpError(res, text, req.model);
      }
      const requestId =
        res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? undefined;
      yield* normalizeResponsesStream(parseSSE(res.body), {
        requestId,
        signal: callOpts.signal,
        model: req.model,
      });
    },
  };
};
