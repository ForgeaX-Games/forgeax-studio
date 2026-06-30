/**
 * OpenAI Chat Completions 兼容 provider (C4) — 原生 fetch + SSE 流式。
 *
 * POST `${baseUrl}/chat/completions` with `stream:true` + `stream_options.include_usage`，
 * 手解 SSE。把 OpenAI Chat Completions 的 delta 流规范化成 C4 ProviderStreamEvent：
 *   message_start / content_block_start / content_block_delta / content_block_stop /
 *   message_delta / message_stop + 一条聚合 `assistant` 事件。
 *
 * 对齐参考(只读)：cli `src/llm/openai-compat.ts`(wire 形状 + per-model 字段分派)。
 * 去掉了对 cli 内部(media-storage / provider-utils / types)的依赖——只 import C4 契约。
 *
 * Boundary：只 import core-local 契约(types.ts)；全部走 fetch，不引外部 SDK。
 * 复用 anthropic.ts 导出的 parseSSE（同子目录、C4 范畴）。
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

/** system 块拍平为单条 system role 文本（cacheScope 在 OpenAI 隐式前缀缓存下不需要显式 marker）。 */
export function systemBlocksToText(blocks: SystemBlock[]): string {
  return blocks
    .filter((b) => !b.boundary) // 剔除内部 cache 分界哨兵,勿泄漏给模型
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
}

export function toolDefsToOpenAI(tools: ProviderToolDef[]): unknown[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/** 中立 content（string | block[]）→ OpenAI content（string | part[]）。 */
function neutralContentToOpenAI(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: unknown[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && block.source && typeof block.source === 'object') {
      const src = block.source as Record<string, unknown>;
      if (src.type === 'base64' && typeof src.data === 'string') {
        const media = typeof src.media_type === 'string' ? src.media_type : 'image/png';
        parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } });
      }
    }
  }
  // 纯文本数组退化为 string（多数 OpenAI 兼容端更稳）。
  if (parts.length > 0 && parts.every((p) => (p as { type?: string }).type === 'text')) {
    return parts.map((p) => (p as { text: string }).text).join('');
  }
  return parts;
}

/** 从中立 assistant content 抽 tool_use 块 → OpenAI tool_calls。 */
function extractToolCalls(content: unknown): unknown[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls: unknown[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'tool_use') {
      calls.push({
        id: typeof block.id === 'string' ? block.id : '_tool',
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : 'unknown_tool',
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

/** assistant content 去掉 tool_use 后的可见内容（OpenAI 把 tool_call 拆到 tool_calls 字段）。 */
function assistantVisibleContent(content: unknown): unknown {
  if (!Array.isArray(content)) return neutralContentToOpenAI(content);
  const visible = content.filter((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    return (raw as Record<string, unknown>).type !== 'tool_use';
  });
  return neutralContentToOpenAI(visible);
}

/**
 * 中立 ProviderMessage[] → OpenAI Chat Completions messages。
 * - user 含 tool_result 块 → 拆成独立 `role:"tool"` 消息（OpenAI 协议）。
 * - assistant 含 tool_use 块 → 提到 tool_calls 字段。
 */
export function messagesToOpenAI(messages: ProviderMessage[], system: SystemBlock[]): unknown[] {
  const out: unknown[] = [];
  const sysText = systemBlocksToText(system);
  if (sysText.length > 0) out.push({ role: 'system', content: sysText });

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
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '_tool',
          content: toolResultToText(block.content),
        });
      }
      if (rest.length > 0) {
        out.push({ role: 'user', content: neutralContentToOpenAI(rest) });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant' };
      const visible = assistantVisibleContent(msg.content);
      if (typeof visible === 'string' ? visible.length > 0 : Array.isArray(visible) && visible.length > 0) {
        entry.content = visible;
      }
      const toolCalls = extractToolCalls(msg.content);
      if (toolCalls) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }

    out.push({ role: msg.role, content: neutralContentToOpenAI(msg.content) });
  }
  return out;
}

/** tool_result.content（string | block[]）→ 纯文本（OpenAI tool role 只吃 string）。 */
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

/** GPT-5 / o1 / o3 / o4-mini 系列拒绝 legacy `max_tokens`，要 `max_completion_tokens`。 */
export function usesCompletionTokensField(model: string): boolean {
  return /^(gpt-5|o1|o3|o4-mini)/i.test(model);
}

/** 新推理模型族只接受默认采样（发 temperature 会 400）。 */
export function disallowsTemperatureField(model: string): boolean {
  return /^(gpt-5|o1|o3|o4-mini)/i.test(model);
}

export interface BuildOpenAIBodyOpts {
  /** 额外 top-level 字段（provider 扩展，如 DeepSeek 的 `thinking`）。 */
  extraBody?: Record<string, unknown>;
}

export function buildOpenAIRequestBody(
  req: ProviderRequest,
  opts?: BuildOpenAIBodyOpts,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: messagesToOpenAI(req.messages, req.system),
    stream: true,
    stream_options: { include_usage: true },
    ...(opts?.extraBody ?? {}),
  };

  const maxTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  body[usesCompletionTokensField(req.model) ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;

  if (typeof req.temperature === 'number' && !disallowsTemperatureField(req.model)) {
    body.temperature = req.temperature;
  }

  const tools = toolDefsToOpenAI(req.tools);
  if (tools) body.tools = tools;

  return body;
}

// ─── usage 映射 ─────────────────────────────────────────────────────────────

/** OpenAI usage → C4 Usage 部分形（prompt→input、completion→output、cached→cacheRead）。 */
export function openAIUsageToPartial(raw: Record<string, unknown> | undefined): Partial<Usage> {
  if (!raw) return {};
  const out: Partial<Usage> = {};
  if (typeof raw.prompt_tokens === 'number') out.inputTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === 'number') out.outputTokens = raw.completion_tokens;
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  if (details && typeof details.cached_tokens === 'number') {
    out.cacheReadInputTokens = details.cached_tokens;
  } else if (typeof raw.prompt_cache_hit_tokens === 'number') {
    // DeepSeek 顶层字段
    out.cacheReadInputTokens = raw.prompt_cache_hit_tokens;
  }
  return out;
}

// ─── 流事件规范化 ───────────────────────────────────────────────────────────

type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

function normalizeFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return null;
  }
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
  blockIndex: number;
}

/**
 * 把 OpenAI Chat Completions SSE 帧序列规范化成 ProviderStreamEvent。纯逻辑，便于测试。
 * 不打网络：传入 parseSSE 出的 {data} 帧即可（OpenAI 不带 event 行，`[DONE]` 结束）。
 *
 * 由于 wire 无显式 block 边界，本函数在「首次 text/thinking delta」处合成
 * content_block_start，在收口（finish 或 stream 结束）处合成 content_block_stop。
 */
export async function* normalizeOpenAIStream(
  frames: AsyncIterable<{ event?: string; data: string }>,
  opts?: {
    requestId?: string;
    signal?: AbortSignal;
    /** 是否把 delta.reasoning_content 当 thinking 块吐出（DeepSeek 等）。 */
    extractReasoning?: boolean;
  },
): AsyncGenerator<ProviderStreamEvent> {
  let usage: Usage = { ...EMPTY_USAGE };
  let stopReason: StopReason = null;
  let startedEmitted = false;
  let nextIndex = 0;

  // 文本/思考块状态（OpenAI 单条流里 text 连续，故各最多一个 open block）。
  let textIndex = -1;
  let textBuf = '';
  let thinkingIndex = -1;
  let thinkingBuf = '';

  // tool_calls 按 OpenAI delta 的 index 累积。
  const pending = new Map<number, PendingToolCall>();
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
    if (data === '[DONE]') break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    yield* ensureStarted();

    // usage 可独立于 choices 出现（OpenAI 尾 chunk choices:[] / DeepSeek 搭末 delta）。
    if (parsed.usage && typeof parsed.usage === 'object') {
      const partial = openAIUsageToPartial(parsed.usage as Record<string, unknown>);
      usage = mergeUsage(usage, partial);
    }

    const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;

    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      // reasoning_content → thinking 块
      if (opts?.extractReasoning && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (thinkingIndex < 0) {
          thinkingIndex = nextIndex++;
          yield { type: 'content_block_start', index: thinkingIndex, blockType: 'thinking' };
        }
        thinkingBuf += delta.reasoning_content;
        yield {
          type: 'content_block_delta',
          index: thinkingIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        };
      }

      // 普通文本 → text 块
      if (typeof delta.content === 'string' && delta.content) {
        // text 到来前先收口 thinking（思考完才正文）。
        yield* closeThinking();
        if (textIndex < 0) {
          textIndex = nextIndex++;
          yield { type: 'content_block_start', index: textIndex, blockType: 'text' };
        }
        textBuf += delta.content;
        yield {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: delta.content },
        };
      }

      // tool_calls 增量
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        // tool_call 开始前收口正文。
        yield* closeText();
        yield* closeThinking();
        for (const tc of toolCalls) {
          const tcIndex = typeof tc.index === 'number' ? tc.index : 0;
          let pc = pending.get(tcIndex);
          if (!pc) {
            pc = { id: '', name: '', args: '', blockIndex: nextIndex++ };
            pending.set(tcIndex, pc);
            yield { type: 'content_block_start', index: pc.blockIndex, blockType: 'tool_use' };
          }
          if (typeof tc.id === 'string' && tc.id) pc.id = tc.id;
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn.name === 'string' && fn.name) pc.name = fn.name;
            if (typeof fn.arguments === 'string' && fn.arguments) {
              pc.args += fn.arguments;
              yield {
                type: 'content_block_delta',
                index: pc.blockIndex,
                delta: { type: 'input_json_delta', partial_json: fn.arguments },
              };
            }
          }
        }
      }
    }

    const finish = choice.finish_reason;
    if (finish != null) {
      stopReason = normalizeFinishReason(finish);
      yield* closeText();
      yield* closeThinking();
      for (const [, pc] of pending) {
        let input: Record<string, unknown> = {};
        try {
          input = pc.args ? (JSON.parse(pc.args) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        const block: AssistantBlock = {
          type: 'tool_use',
          id: pc.id || '_tool',
          name: pc.name || 'unknown_tool',
          input,
        };
        blocks.push(block);
        yield { type: 'content_block_stop', index: pc.blockIndex, block };
      }
      pending.clear();
      yield { type: 'message_delta', usage: {}, stopReason };
    }
  }

  // 防御：stream 结束但未见 finish_reason —— 收口残留块。
  yield* closeText();
  yield* closeThinking();
  for (const [, pc] of pending) {
    let input: Record<string, unknown> = {};
    try {
      input = pc.args ? (JSON.parse(pc.args) as Record<string, unknown>) : {};
    } catch {
      input = {};
    }
    const block: AssistantBlock = {
      type: 'tool_use',
      id: pc.id || '_tool',
      name: pc.name || 'unknown_tool',
      input,
    };
    blocks.push(block);
    yield { type: 'content_block_stop', index: pc.blockIndex, block };
  }
  pending.clear();

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

function throwHttpError(res: Response, text: string, model: string, name: string): never {
  const err = new Error(`${name} API error ${res.status}: ${text.slice(0, 500)}`) as Error & {
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

/** 去尾斜杠 + 补 `/v1`（若缺）。OpenAI 兼容端点路径 `${base}/chat/completions`。 */
export function normalizeOpenAIBaseUrl(url: string): string {
  let u = url.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

// ─── Provider 工厂 ──────────────────────────────────────────────────────────

/** 共享工厂：openai-compat + deepseek 复用。 */
export function createOpenAICompatLikeProvider(
  opts: ProviderFactoryOpts,
  config: {
    api: string;
    defaultBaseUrl: string;
    name: string;
    buildBody?: (req: ProviderRequest) => Record<string, unknown>;
    extractReasoning?: boolean;
  },
): LLMProvider {
  const base = normalizeOpenAIBaseUrl(opts.baseUrl ?? config.defaultBaseUrl);
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
    ...(opts.headers ?? {}),
  };

  return {
    api: config.api,
    async *stream(
      req: ProviderRequest,
      callOpts: ProviderCallOpts,
    ): AsyncIterable<ProviderStreamEvent> {
      const body = config.buildBody ? config.buildBody(req) : buildOpenAIRequestBody(req);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: callOpts.signal,
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : '';
        throwHttpError(res, text, req.model, config.name);
      }
      const requestId =
        res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? undefined;
      yield* normalizeOpenAIStream(parseSSE(res.body), {
        requestId,
        signal: callOpts.signal,
        extractReasoning: config.extractReasoning,
      });
    },
  };
}

export const createOpenAICompatProvider: ProviderFactory = (
  opts: ProviderFactoryOpts,
): LLMProvider =>
  createOpenAICompatLikeProvider(opts, {
    api: 'openai-compat',
    defaultBaseUrl: DEFAULT_BASE_URL,
    name: 'openai-compat',
    extractReasoning: true,
  });
