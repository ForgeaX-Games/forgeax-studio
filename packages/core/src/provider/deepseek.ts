/**
 * DeepSeek provider (C4) — OpenAI Chat Completions 兼容变体，api='deepseek-v4'。
 *
 * 复用 openai-compat 的请求构造 + SSE 流规范化，仅追加 DeepSeek 特有的
 * `thinking: {type:"enabled"|"disabled"}` 顶层开关：
 *   - req.thinking 非 disabled → `{type:"enabled"}`，并开 reasoning_content 抽取(→ thinking 块)；
 *   - 否则 `{type:"disabled"}`，避免默认开启模型的意外推理计费。
 *
 * 对齐参考(只读)：cli `src/llm/deepseek-v4.ts`。去掉 cli 内部依赖——只 import C4 契约
 * 与同子目录 openai-compat 范式。
 *
 * Boundary：只 import core-local；走 fetch，不引外部 SDK。
 */

import {
  buildOpenAIRequestBody,
  createOpenAICompatLikeProvider,
} from './openai-compat';
import type {
  LLMProvider,
  ProviderFactory,
  ProviderFactoryOpts,
  ProviderRequest,
} from './types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek 请求体 = openai-compat body + `thinking` 顶层开关。 */
export function buildDeepSeekRequestBody(req: ProviderRequest): Record<string, unknown> {
  const thinkingEnabled = req.thinking != null && req.thinking.type !== 'disabled';
  return buildOpenAIRequestBody(req, {
    extraBody: { thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' } },
  });
}

export const createDeepSeekProvider: ProviderFactory = (
  opts: ProviderFactoryOpts,
): LLMProvider =>
  createOpenAICompatLikeProvider(opts, {
    api: 'deepseek-v4',
    defaultBaseUrl: DEFAULT_BASE_URL,
    name: 'deepseek-v4',
    buildBody: buildDeepSeekRequestBody,
    extractReasoning: true,
  });
