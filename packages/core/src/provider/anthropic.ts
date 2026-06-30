/**
 * Anthropic Messages provider (C4) — 原生 fetch + SSE 流式。
 *
 * **不 import @anthropic-ai/sdk**（boundary lint 禁止，且会引入 package.json 依赖）：
 * 直接 POST `${baseUrl}/v1/messages` with `stream:true`，手解 SSE。
 *
 * 实现 LLMProvider.stream，把 Anthropic 的 SSE 事件规范化成 ProviderStreamEvent：
 *   message_start / content_block_start / content_block_delta / content_block_stop /
 *   message_delta / message_stop + 一条聚合后的 `assistant` 事件。
 * usage 用 C4 的 mergeUsage 累计。
 *
 * Boundary：只 import C4 契约（types.ts）。重试由上层 withRetry 包（retry.ts）。
 */

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

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// ─── 请求体构造 ─────────────────────────────────────────────────────────────

/** system 块 → Anthropic system 数组；cacheScope 非空 → 打 cache_control（C7 边界）。 */
export function systemBlocksToAnthropic(blocks: SystemBlock[]): unknown[] {
  // 剔除内部 cache 分界哨兵(boundary):它不是模型内容,发出去会泄漏哨兵串。
  // 过滤后 cache marker 仍落在最后一个 scoped 块(末块或下一块无 scope),位置不变。
  return blocks.filter((b) => !b.boundary).map((block, i, arr) => {
    const entry: Record<string, unknown> = { type: 'text', text: block.text };
    // 在「最后一个带 cacheScope 的块」上落 cache marker：下一块无 scope 或已是末尾。
    const nextHasScope = i < arr.length - 1 && arr[i + 1].cacheScope != null;
    if (block.cacheScope != null && !nextHasScope) {
      entry.cache_control = { type: 'ephemeral' };
    }
    return entry;
  });
}

export function toolDefsToAnthropic(tools: ProviderToolDef[]): unknown[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function messagesToAnthropic(messages: ProviderMessage[]): unknown[] {
  // content 已是 backend 中立形（string | ContentBlock[]）——直接透传，由调用方规范化。
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * fire-and-forget fork：cache 标记打倒数第二条 user content 的最后一块
 * （skipCacheWrite 反转语义 —— 默认打最后一条；skipCacheWrite 时退一条，
 * 让最新一条的 dynamic 字节落在 cache prefix 外）。
 */
export function annotateMessageCache(messages: unknown[], skipCacheWrite?: boolean): void {
  const userIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { role?: string };
    if (m?.role === 'user') userIdxs.push(i);
  }
  if (userIdxs.length === 0) return;
  const targetUserIdx = skipCacheWrite
    ? userIdxs[userIdxs.length - 2]
    : userIdxs[userIdxs.length - 1];
  if (targetUserIdx === undefined) return;

  const msg = messages[targetUserIdx] as { content?: unknown };
  const content = msg.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const last = content[content.length - 1] as Record<string, unknown> | undefined;
  if (last && typeof last === 'object') {
    content[content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
  }
}

export function buildRequestBody(req: ProviderRequest): Record<string, unknown> {
  const anthropicMessages = messagesToAnthropic(req.messages);
  const body: Record<string, unknown> = {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: true,
  };

  const systemArr = systemBlocksToAnthropic(req.system);
  if (systemArr.length) body.system = systemArr;

  if (req.enablePromptCaching !== false) {
    annotateMessageCache(anthropicMessages, req.skipCacheWrite);
  }

  const tools = toolDefsToAnthropic(req.tools);
  if (tools) body.tools = tools;

  if (req.thinking && req.thinking.type !== 'disabled') {
    if (req.thinking.type === 'adaptive') {
      // display:'summarized' 才会流式吐 thinking 增量(UI 可见)；缺省思考但不显示。
      body.thinking = req.thinking.display
        ? { type: 'adaptive', display: req.thinking.display }
        : { type: 'adaptive' };
    } else {
      const budget = req.thinking.budgetTokens ?? 8192;
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // max_tokens 必须 > budget_tokens,否则 Anthropic 400。
      if ((body.max_tokens as number) <= budget) body.max_tokens = budget + 4096;
    }
    // thinking 开启时不发 temperature（API 要求 temp=1，省略即可）。
  } else if (typeof req.temperature === 'number') {
    body.temperature = req.temperature;
  }

  return body;
}

// ─── SSE 解析 ───────────────────────────────────────────────────────────────

/** SSE 读空闲超时(ms):上游连续这么久不吐**任何字节**(含 ping)即判定卡死,abort 抛错。
 *  健康但慢的流靠 ping 持续重置计时器,不会误杀;真正 stall(代理 hold 住连接不发数据)
 *  才触发 —— 修「整轮无响应永久挂死」的根因。0/负 = 关闭(回退旧无超时行为)。
 *  缺省 90s(同一根因:请求超时只覆盖 fetch() 初次握手,不覆盖流式 body)。
 *  env `FORGEAX_PROVIDER_IDLE_MS` 可调。该看门狗默认**开**(实测被此 bug 命中)。 */
function providerStreamIdleMs(): number {
  const v = Number(process.env.FORGEAX_PROVIDER_IDLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 90_000;
}

/** `reader.read()` 加空闲超时:超时则 cancel reader 并抛错(让上层把本轮干净 error 封口,
 *  而非无限 await)。任何到达的字节(含 ping)都会让下一次调用重置计时器。 */
async function readWithIdleTimeout(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> },
  idleMs: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`anthropic stream idle ${idleMs}ms with no data — aborting (likely upstream/proxy stall)`)),
      idleMs,
    );
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } catch (e) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 解析 SSE 字节流为 { event?, data } 帧。CRLF 规范化 + `\n\n` 分块。 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  idleMs: number = providerStreamIdleMs(),
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = idleMs > 0 ? await readWithIdleTimeout(reader, idleMs) : await reader.read();
      if (done) break;
      buffer += decoder
        .decode(value, { stream: true })
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── 流事件规范化 ───────────────────────────────────────────────────────────

type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface CurrentBlock {
  blockType: 'text' | 'thinking' | 'tool_use' | 'server_tool_use';
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  toolId?: string;
  toolName?: string;
  toolArgs?: string;
}

function rawUsageToPartial(raw: Record<string, unknown> | undefined): Partial<Usage> {
  if (!raw) return {};
  const num = (k: string): number | undefined =>
    typeof raw[k] === 'number' ? (raw[k] as number) : undefined;
  const out: Partial<Usage> = {};
  const input = num('input_tokens');
  if (input !== undefined) out.inputTokens = input;
  const output = num('output_tokens');
  if (output !== undefined) out.outputTokens = output;
  const cacheRead = num('cache_read_input_tokens');
  if (cacheRead !== undefined) out.cacheReadInputTokens = cacheRead;
  const cacheCreate = num('cache_creation_input_tokens');
  if (cacheCreate !== undefined) out.cacheCreationInputTokens = cacheCreate;
  const cc = raw['cache_creation'];
  if (cc && typeof cc === 'object') {
    const ccr = cc as Record<string, unknown>;
    out.cacheCreation = {
      ephemeral1h: typeof ccr.ephemeral_1h_input_tokens === 'number' ? ccr.ephemeral_1h_input_tokens : undefined,
      ephemeral5m: typeof ccr.ephemeral_5m_input_tokens === 'number' ? ccr.ephemeral_5m_input_tokens : undefined,
    };
  }
  return out;
}

function normalizeStopReason(raw: unknown): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'refusal':
    case 'model_context_window_exceeded':
      return raw;
    default:
      return null;
  }
}

/**
 * 把 Anthropic SSE 帧序列规范化成 ProviderStreamEvent 序列（纯逻辑，便于测试）。
 * 不打网络：传入 parseSSE 出的 {event,data} 帧即可。
 */
export async function* normalizeAnthropicStream(
  frames: AsyncIterable<{ event?: string; data: string }>,
  opts?: { requestId?: string; signal?: AbortSignal },
): AsyncGenerator<ProviderStreamEvent> {
  let usage: Usage = { ...EMPTY_USAGE };
  let stopReason: StopReason = null;
  let current: CurrentBlock | null = null;
  const blocks: AssistantBlock[] = [];
  const startedAt = Date.now();
  let firstTokenAt: number | undefined;

  for await (const { event, data } of frames) {
    if (opts?.signal?.aborted) break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = (event ?? (parsed.type as string | undefined)) as string | undefined;

    switch (type) {
      case 'message_start': {
        const msg = parsed.message as { usage?: Record<string, unknown> } | undefined;
        const partial = rawUsageToPartial(msg?.usage);
        usage = mergeUsage(usage, partial);
        yield { type: 'message_start', usage: partial };
        break;
      }

      case 'content_block_start': {
        const index = (parsed.index as number) ?? 0;
        const block = parsed.content_block as Record<string, unknown> | undefined;
        const bt = block?.type;
        if (bt === 'tool_use' || bt === 'server_tool_use') {
          current = {
            blockType: bt === 'server_tool_use' ? 'server_tool_use' : 'tool_use',
            toolId: typeof block?.id === 'string' ? block.id : undefined,
            toolName: typeof block?.name === 'string' ? block.name : undefined,
            toolArgs: '',
          };
          yield { type: 'content_block_start', index, blockType: current.blockType };
        } else if (bt === 'thinking') {
          current = {
            blockType: 'thinking',
            thinking: typeof block?.thinking === 'string' ? block.thinking : '',
            signature: typeof block?.signature === 'string' ? block.signature : undefined,
          };
          yield { type: 'content_block_start', index, blockType: 'thinking' };
        } else if (bt === 'redacted_thinking') {
          current = {
            blockType: 'thinking',
            data: typeof block?.data === 'string' ? block.data : '',
          };
          yield { type: 'content_block_start', index, blockType: 'thinking' };
        } else {
          current = { blockType: 'text', text: typeof block?.text === 'string' ? block.text : '' };
          yield { type: 'content_block_start', index, blockType: 'text' };
        }
        break;
      }

      case 'content_block_delta': {
        const index = (parsed.index as number) ?? 0;
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (!delta) break;
        if (firstTokenAt === undefined) firstTokenAt = Date.now();
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (current?.blockType === 'text') current.text = (current.text ?? '') + delta.text;
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          if (current?.blockType === 'thinking')
            current.thinking = (current.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          if (current?.blockType === 'thinking') current.signature = delta.signature;
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (current && (current.blockType === 'tool_use' || current.blockType === 'server_tool_use'))
            current.toolArgs = (current.toolArgs ?? '') + delta.partial_json;
        }
        yield { type: 'content_block_delta', index, delta };
        break;
      }

      case 'content_block_stop': {
        const index = (parsed.index as number) ?? 0;
        let finished: AssistantBlock | undefined;
        if (current) {
          if (current.blockType === 'tool_use' || current.blockType === 'server_tool_use') {
            let input: Record<string, unknown> = {};
            try {
              input = current.toolArgs ? (JSON.parse(current.toolArgs) as Record<string, unknown>) : {};
            } catch {
              input = {};
            }
            finished = {
              type: 'tool_use',
              id: current.toolId ?? '_tool',
              name: current.toolName ?? 'unknown_tool',
              input,
            };
          } else if (current.blockType === 'thinking') {
            if (current.data !== undefined) {
              finished = { type: 'redacted_thinking', data: current.data };
            } else {
              finished = {
                type: 'thinking',
                thinking: current.thinking ?? '',
                ...(current.signature ? { signature: current.signature } : {}),
              };
            }
          } else if (current.blockType === 'text' && current.text) {
            finished = { type: 'text', text: current.text };
          }
        }
        if (finished) blocks.push(finished);
        yield { type: 'content_block_stop', index, block: finished };
        current = null;
        break;
      }

      case 'message_delta': {
        const partial = rawUsageToPartial(parsed.usage as Record<string, unknown> | undefined);
        usage = mergeUsage(usage, partial);
        const dr = (parsed.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
        stopReason = normalizeStopReason(dr);
        yield { type: 'message_delta', usage: partial, stopReason };
        break;
      }

      case 'message_stop': {
        yield { type: 'message_stop' };
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: blocks },
          usage,
          stopReason,
          ...(opts?.requestId ? { requestId: opts.requestId } : {}),
        };
        break;
      }

      default:
        break;
    }
  }

  // 防御：若上游未发 message_stop（连接断），仍吐已聚合的 assistant。
  void startedAt;
  void firstTokenAt;
}

// ─── HTTP 错误（带 status / retryAfterMs，供 retry.ts 消费）────────────────

function throwHttpError(res: Response, text: string, model: string): never {
  const err = new Error(`anthropic API error ${res.status}: ${text.slice(0, 500)}`) as Error & {
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

// ─── Provider 工厂 ──────────────────────────────────────────────────────────

export const createAnthropicProvider: ProviderFactory = (
  opts: ProviderFactoryOpts,
): LLMProvider => {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${base}/v1/messages`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-api-key': opts.apiKey,
    ...(opts.headers ?? {}),
  };

  return {
    api: 'anthropic-messages',
    async *stream(
      req: ProviderRequest,
      callOpts: ProviderCallOpts,
    ): AsyncIterable<ProviderStreamEvent> {
      const body = buildRequestBody(req);
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
      const requestId = res.headers.get('request-id') ?? res.headers.get('x-request-id') ?? undefined;
      yield* normalizeAnthropicStream(parseSSE(res.body), {
        requestId,
        signal: callOpts.signal,
      });
    },
  };
};
