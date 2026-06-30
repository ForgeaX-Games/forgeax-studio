/**
 * Vertex AI (Anthropic on Google Cloud) provider (C4) — backend `vertex-anthropic`.
 *
 * 复用 anthropic 的 body 构造 + SSE 流解析(`buildRequestBody`/`parseSSE`/
 * `normalizeAnthropicStream`),仅换两正交轴里的 **backend** 部分:
 *   - URL:`{baseUrl}/{model}:streamRawPredict`
 *     (baseUrl = `https://{region}-aiplatform.googleapis.com/v1/projects/{proj}/locations/{region}/publishers/anthropic/models`)
 *   - body:删 `model`(model 在 URL)、加 `anthropic_version: "vertex-2023-10-16"`
 *   - auth:`Authorization: Bearer <token>`(opts.apiKey = GCP OAuth access token,host 提供)
 * 响应是 SSE,故 parseSSE + normalizeAnthropicStream 原样可用。
 *
 * 无 GCP 凭据 → 不做 live e2e;请求构造 + 流复用以单测覆盖(设计稿 §11)。
 * Boundary: 仅 import core-local。
 */
import type {
  LLMProvider,
  ProviderCallOpts,
  ProviderFactory,
  ProviderFactoryOpts,
  ProviderRequest,
  ProviderStreamEvent,
} from './types';
import { buildRequestBody, parseSSE, normalizeAnthropicStream } from './anthropic';

const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';

/** 把 anthropic body 改造成 Vertex 形状(导出供单测)。 */
export function buildVertexBody(req: ProviderRequest): Record<string, unknown> {
  const body = buildRequestBody(req);
  delete body.model; // model 在 URL,不进 body(Vertex 要求)
  delete body.stream; // streamRawPredict 隐式流式
  body.anthropic_version = VERTEX_ANTHROPIC_VERSION;
  return body;
}

/** 由 baseUrl + model 拼 streamRawPredict URL(导出供单测)。 */
export function buildVertexUrl(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(model)}:streamRawPredict`;
}

export const createVertexProvider: ProviderFactory = (opts: ProviderFactoryOpts): LLMProvider => {
  if (!opts.baseUrl) {
    throw new Error(
      'vertex-anthropic: baseUrl required, e.g. https://{region}-aiplatform.googleapis.com/v1/projects/{proj}/locations/{region}/publishers/anthropic/models',
    );
  }
  const baseUrl = opts.baseUrl;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
    ...(opts.headers ?? {}),
  };
  return {
    api: 'vertex-anthropic',
    async *stream(req: ProviderRequest, callOpts: ProviderCallOpts): AsyncIterable<ProviderStreamEvent> {
      const url = buildVertexUrl(baseUrl, req.model);
      const body = buildVertexBody(req);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: callOpts.signal,
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : '';
        throw new Error(`vertex-anthropic ${res.status}: ${text.slice(0, 500)}`);
      }
      const requestId = res.headers.get('x-request-id') ?? undefined;
      yield* normalizeAnthropicStream(parseSSE(res.body), { requestId, signal: callOpts.signal });
    },
  };
};
