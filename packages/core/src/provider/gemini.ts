/**
 * Google Gemini provider (C4) — generateContent (streamGenerateContent)，api='gemini'。
 *
 * **用 fetch，不引 @google/genai**（boundary 禁外部包）。
 * POST `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
 * (key 也可走 header `x-goog-api-key`)；SSE 每帧 data 是一个 GenerateContentResponse chunk。
 *
 * Wire 形状(对齐 cli `src/llm/gemini-shared.ts`，只读)：
 *   - system → top-level `systemInstruction: {parts:[{text}]}`。
 *   - 历史 → `contents: [{role:"user"|"model", parts:[...]}]`；tool_result → functionResponse part；
 *     assistant tool_use → functionCall part。
 *   - tools → `[{functionDeclarations:[{name, description, parameters}]}]`。
 *   - chunk: candidates[0].content.parts[] 各 part 为 {text} / {text,thought:true} / {functionCall:{name,args}}；
 *     candidates[0].finishReason；顶层 usageMetadata:{promptTokenCount, candidatesTokenCount,
 *     thoughtsTokenCount, cachedContentTokenCount}。
 *
 * 规范化成 C4 ProviderStreamEvent（合成 content_block_* 边界 + assistant 聚合）。
 *
 * Boundary：只 import core-local；走 fetch。复用 anthropic.parseSSE。
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

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// ─── 请求体构造 ─────────────────────────────────────────────────────────────

export function systemBlocksToGemini(blocks: SystemBlock[]): Record<string, unknown> | undefined {
  const text = blocks
    .filter((b) => !b.boundary) // 剔除内部 cache 分界哨兵,勿泄漏给模型
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
  return text.length > 0 ? { parts: [{ text }] } : undefined;
}

export function toolDefsToGemini(tools: ProviderToolDef[]): unknown[] | undefined {
  if (!tools.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

/** 中立 content block → Gemini part。 */
function neutralBlockToGeminiPart(raw: unknown): unknown | undefined {
  if (typeof raw === 'string') return { text: raw };
  if (!raw || typeof raw !== 'object') return undefined;
  const block = raw as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') {
    return { text: block.text };
  }
  if (block.type === 'image' && block.source && typeof block.source === 'object') {
    const src = block.source as Record<string, unknown>;
    if (src.type === 'base64' && typeof src.data === 'string') {
      const media = typeof src.media_type === 'string' ? src.media_type : 'image/png';
      return { inlineData: { data: src.data, mimeType: media } };
    }
  }
  if (block.type === 'tool_use') {
    return {
      functionCall: {
        name: typeof block.name === 'string' ? block.name : 'unknown_tool',
        args: (block.input as Record<string, unknown>) ?? {},
      },
    };
  }
  return undefined;
}

function toolResultToText(content: unknown): string {
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

/** 中立 ProviderMessage[] → Gemini `contents`。role: user→user, assistant→model。 */
export function messagesToGemini(messages: ProviderMessage[]): unknown[] {
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const parts: unknown[] = [];
      for (const raw of msg.content) {
        if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'tool_result') {
          const block = raw as Record<string, unknown>;
          parts.push({
            functionResponse: {
              name: typeof block.name === 'string' ? block.name : 'unknown_tool',
              response: { result: toolResultToText(block.content) },
            },
          });
        } else {
          const p = neutralBlockToGeminiPart(raw);
          if (p) parts.push(p);
        }
      }
      if (parts.length > 0) out.push({ role: 'user', parts });
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: unknown[] = [];
    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const raw of msg.content) {
        const p = neutralBlockToGeminiPart(raw);
        if (p) parts.push(p);
      }
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

export function buildGeminiRequestBody(req: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: messagesToGemini(req.messages),
  };

  const sys = systemBlocksToGemini(req.system);
  if (sys) body.systemInstruction = sys;

  const tools = toolDefsToGemini(req.tools);
  if (tools) body.tools = tools;

  const genConfig: Record<string, unknown> = {
    maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (req.thinking && req.thinking.type !== 'disabled') {
    const budget = req.thinking.budgetTokens;
    genConfig.thinkingConfig = {
      includeThoughts: true,
      ...(typeof budget === 'number' ? { thinkingBudget: budget } : {}),
    };
  } else if (typeof req.temperature === 'number') {
    genConfig.temperature = req.temperature;
  }
  body.generationConfig = genConfig;

  return body;
}

// ─── usage 映射 ─────────────────────────────────────────────────────────────

/** Gemini usageMetadata → C4 Usage（output = candidates + thoughts，cacheRead = cachedContent）。 */
export function geminiUsageToPartial(raw: Record<string, unknown> | undefined): Partial<Usage> {
  if (!raw) return {};
  const out: Partial<Usage> = {};
  const prompt = typeof raw.promptTokenCount === 'number' ? raw.promptTokenCount : undefined;
  if (prompt !== undefined) out.inputTokens = prompt;
  const candidates = typeof raw.candidatesTokenCount === 'number' ? raw.candidatesTokenCount : 0;
  const thoughts = typeof raw.thoughtsTokenCount === 'number' ? raw.thoughtsTokenCount : 0;
  if (typeof raw.candidatesTokenCount === 'number' || typeof raw.thoughtsTokenCount === 'number') {
    out.outputTokens = candidates + thoughts;
  }
  if (typeof raw.cachedContentTokenCount === 'number') {
    out.cacheReadInputTokens = raw.cachedContentTokenCount;
  }
  return out;
}

function normalizeFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'refusal';
    default:
      return null;
  }
}

// ─── 流事件规范化 ───────────────────────────────────────────────────────────

type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

let toolCallSeq = 0;
function genToolCallId(): string {
  toolCallSeq += 1;
  return `call_${Date.now()}_${toolCallSeq}`;
}

/**
 * Gemini SSE chunk 序列 → ProviderStreamEvent。纯逻辑，便于测试。
 * 每帧 data 是一个 GenerateContentResponse chunk。
 * functionCall 在 Gemini 是整块到达（非增量），故合成 start+delta+stop 一气呵成。
 */
export async function* normalizeGeminiStream(
  frames: AsyncIterable<{ event?: string; data: string }>,
  opts?: { requestId?: string; signal?: AbortSignal },
): AsyncGenerator<ProviderStreamEvent> {
  let usage: Usage = { ...EMPTY_USAGE };
  let stopReason: StopReason = null;
  let startedEmitted = false;
  let nextIndex = 0;

  let textIndex = -1;
  let textBuf = '';
  let thinkingIndex = -1;
  let thinkingBuf = '';

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

  for await (const { data } of frames) {
    if (opts?.signal?.aborted) break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    yield* ensureStarted();

    const candidate = (parsed.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;

    if (parts) {
      for (const part of parts) {
        if (part.functionCall && typeof part.functionCall === 'object') {
          yield* closeText();
          yield* closeThinking();
          const fc = part.functionCall as Record<string, unknown>;
          const id = genToolCallId();
          const name = typeof fc.name === 'string' ? fc.name : 'unknown_tool';
          const input = (fc.args as Record<string, unknown>) ?? {};
          const idx = nextIndex++;
          yield { type: 'content_block_start', index: idx, blockType: 'tool_use' };
          yield {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
          };
          const block: AssistantBlock = { type: 'tool_use', id, name, input };
          blocks.push(block);
          yield { type: 'content_block_stop', index: idx, block };
        } else if (typeof part.text === 'string' && part.text.length > 0) {
          if (part.thought === true) {
            if (thinkingIndex < 0) {
              thinkingIndex = nextIndex++;
              yield { type: 'content_block_start', index: thinkingIndex, blockType: 'thinking' };
            }
            thinkingBuf += part.text;
            yield {
              type: 'content_block_delta',
              index: thinkingIndex,
              delta: { type: 'thinking_delta', thinking: part.text },
            };
          } else {
            yield* closeThinking();
            if (textIndex < 0) {
              textIndex = nextIndex++;
              yield { type: 'content_block_start', index: textIndex, blockType: 'text' };
            }
            textBuf += part.text;
            yield {
              type: 'content_block_delta',
              index: textIndex,
              delta: { type: 'text_delta', text: part.text },
            };
          }
        }
      }
    }

    const meta = parsed.usageMetadata as Record<string, unknown> | undefined;
    if (meta) usage = mergeUsage(usage, geminiUsageToPartial(meta));

    if (candidate?.finishReason != null) {
      stopReason = normalizeFinishReason(candidate.finishReason);
    }
  }

  yield* closeText();
  yield* closeThinking();

  // Gemini 不发独立 tool_use stop_reason；有 tool_use 块则修正为 tool_use。
  if (stopReason !== 'max_tokens' && stopReason !== 'refusal' && blocks.some((b) => b.type === 'tool_use')) {
    stopReason = 'tool_use';
  }
  if (stopReason === null && blocks.length > 0) stopReason = 'end_turn';

  yield* ensureStarted();
  yield { type: 'message_delta', usage: {}, stopReason };
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
  const err = new Error(`gemini API error ${res.status}: ${text.slice(0, 500)}`) as Error & {
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

export function normalizeGeminiBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// ─── Provider 工厂 ──────────────────────────────────────────────────────────

export const createGeminiProvider: ProviderFactory = (
  opts: ProviderFactoryOpts,
): LLMProvider => {
  const base = normalizeGeminiBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-goog-api-key': opts.apiKey,
    ...(opts.headers ?? {}),
  };

  return {
    api: 'gemini',
    async *stream(
      req: ProviderRequest,
      callOpts: ProviderCallOpts,
    ): AsyncIterable<ProviderStreamEvent> {
      const body = buildGeminiRequestBody(req);
      const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
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
      const requestId = res.headers.get('x-request-id') ?? undefined;
      yield* normalizeGeminiStream(parseSSE(res.body), {
        requestId,
        signal: callOpts.signal,
      });
    },
  };
};
