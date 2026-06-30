/**
 * Builtin web tools (②) — `web_fetch` / `web_search`.
 *
 *   - web_fetch:真 `fetch(url)` 拉网页 → HTML 轻量转纯文本(去 script/style/标签) →
 *     返回正文(可 maxChars 截断)。只读 + 并发安全。
 *   - web_search:core 不内置搜索后端(搜索需第三方 API)——后端经
 *     `webToolsPack({ searchBackend })` **注入**(闭包捕获);未注入则返回明确
 *     「search backend not configured」。只读 + 并发安全。
 *
 * Boundary: 仅 import core-local 契约 + 全局 fetch(node18+/bun 内置)。
 */
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type ToolContext } from '../types';

// ─── 搜索后端注入接缝 ────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/** host 注入的搜索后端;core 不绑定任何具体搜索 API。 */
export type WebSearchBackend = (
  query: string,
  signal?: AbortSignal,
) => Promise<WebSearchResult[]>;

export interface WebToolsOptions {
  /** 注入的搜索后端;缺省 → web_search 返回未配置错误。 */
  searchBackend?: WebSearchBackend;
  /** 可注入 fetch(测试用假 fetch);缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** web_fetch 返回正文的最大字符数(默认 100k)。 */
  maxFetchChars?: number;
}

function toResultEvent(
  toolUseId: string,
  payload: Record<string, unknown>,
  isError = false,
): CoreEvent {
  return {
    type: CoreEventType.ToolCallResult,
    payload: { toolUseId, isError, ...payload },
    ts: Date.now(),
  };
}

/** 极简 HTML→文本:剥 script/style，去标签，解实体，压空白。「网页转纯文本」语义。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── web_fetch ───────────────────────────────────────────────────────────────

export interface WebFetchInput {
  url: string;
  /** 截断上限(覆盖 pack 默认)。 */
  max_chars?: number;
}

export interface WebFetchOutput {
  url: string;
  status: number;
  contentType: string;
  /** 提取出的正文(HTML 已转纯文本;非 HTML 原样)。 */
  text: string;
  truncated: boolean;
}

export function webFetchTool(opts: WebToolsOptions = {}): AgentTool<WebFetchInput, WebFetchOutput> {
  const doFetch = opts.fetchImpl ?? fetch;
  const cap = opts.maxFetchChars ?? 100_000;
  return buildTool<WebFetchInput, WebFetchOutput>({
    name: 'web_fetch',
    aliases: ['WebFetch'],
    searchHint: 'fetch a URL and return its text content',
    inputJSONSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute URL to fetch (http/https).' },
        max_chars: { type: 'number', description: 'Optional max characters of body text to return.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx): Promise<{ data: WebFetchOutput }> {
      if (typeof input.url !== 'string' || input.url === '') {
        throw new Error('web_fetch: url must be a non-empty string');
      }
      const url = input.url.trim();
      const res = await doFetch(url, { signal: ctx.signal, redirect: 'follow' });
      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const body = /html/i.test(contentType) ? htmlToText(raw) : raw;
      const limit = input.max_chars && input.max_chars > 0 ? input.max_chars : cap;
      const truncated = body.length > limit;
      return {
        data: {
          url,
          status: res.status,
          contentType,
          text: truncated ? body.slice(0, limit) : body,
          truncated,
        },
      };
    },
    mapResult: (o, id) =>
      toResultEvent(id, {
        result: o.text,
        url: o.url,
        status: o.status,
        truncated: o.truncated,
      }),
  });
}

// ─── web_search ──────────────────────────────────────────────────────────────

export interface WebSearchInput {
  query: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
}

export function webSearchTool(opts: WebToolsOptions = {}): AgentTool<WebSearchInput, WebSearchOutput> {
  const backend = opts.searchBackend;
  return buildTool<WebSearchInput, WebSearchOutput>({
    name: 'web_search',
    aliases: ['WebSearch'],
    searchHint: 'search the web for a query',
    inputJSONSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query string.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx): Promise<{ data: WebSearchOutput }> {
      if (typeof input.query !== 'string' || input.query === '') {
        throw new Error('web_search: query must be a non-empty string');
      }
      // 闭包后端优先;否则看 ctx 注入;都没有 → loud(对齐 fail-loud 注入契约)。
      const fn = backend ?? (ctx as ToolContext & { searchBackend?: WebSearchBackend }).searchBackend;
      if (!fn) {
        throw new Error(
          'web_search: search backend not configured — host must inject a WebSearchBackend via webToolsPack({ searchBackend }) or ctx.searchBackend.',
        );
      }
      const results = await fn(input.query, ctx.signal);
      return { data: { query: input.query, results } };
    },
    mapResult: (o, id) =>
      toResultEvent(id, {
        result: o.results.map((r) => `${r.title} — ${r.url}${r.snippet ? `\n  ${r.snippet}` : ''}`).join('\n'),
        count: o.results.length,
      }),
  });
}

/** web 工具聚合包(builtin 层)。 */
export function webToolsPack(opts: WebToolsOptions = {}) {
  return {
    name: 'web-tools',
    layer: 'builtin' as const,
    tools: [webFetchTool(opts), webSearchTool(opts)],
  };
}
