/**
 * Provider 注册表 (C4) — backend(api) → factory 映射 + 解析。
 *
 * core-layer-spec §3.3：provider 两正交轴（backend / model 代际），不 fork。
 * backend 用 `api` 字符串标识（如 'anthropic-messages'）；同 backend 不同模型代际
 * 走 per-model hook / api_base，不另注册。
 *
 * Boundary：只 import C4 契约 + 本子目录 anthropic 工厂。
 */

import { createAnthropicProvider } from './anthropic';
import { createOpenAICompatProvider } from './openai-compat';
import { createOpenAIResponseProvider } from './openai-response';
import { createGeminiProvider } from './gemini';
import { createDeepSeekProvider } from './deepseek';
import { createBedrockProvider } from './bedrock';
import { createVertexProvider } from './vertex';
import type { LLMProvider, ProviderFactory, ProviderFactoryOpts } from './types';
import { wireModel } from './model-id';

const registry = new Map<string, ProviderFactory>();

/** 注册一个 backend 工厂。重复注册同 api 覆盖（后者赢）。 */
export function registerProvider(api: string, factory: ProviderFactory): void {
  registry.set(api, factory);
}

/** 解析并实例化 provider；未注册的 api 抛错。 */
export function resolveProvider(api: string, opts: ProviderFactoryOpts): LLMProvider {
  const factory = registry.get(api);
  if (!factory) {
    throw new Error(
      `unknown provider api: '${api}'. registered: ${[...registry.keys()].join(', ') || '(none)'}`,
    );
  }
  return withWireModelNormalization(factory(opts));
}

/**
 * 在 provider 边界统一规整 wire 模型名(剥掉 `[1m]` 这类内部标记后缀)——所有 provider、
 * 所有调用方(主轮/子 agent/压缩/auto-memory)的唯一收口。防御泄漏的 `ANTHROPIC_MODEL`
 * (如 cc 的 `claude-opus-4-8[1m]`)被原样发出导致 401。见 ./model-id。
 */
function withWireModelNormalization(provider: LLMProvider): LLMProvider {
  return {
    api: provider.api,
    stream(req, callOpts) {
      const model = wireModel(req.model);
      return provider.stream(model === req.model ? req : { ...req, model }, callOpts);
    },
  };
}

/** 列出已注册 backend。 */
export function listProviders(): string[] {
  return [...registry.keys()];
}

// ─── 内置注册 ──────────────────────────────────────────────────────────────

registerProvider('anthropic-messages', createAnthropicProvider);
registerProvider('openai-compat', createOpenAICompatProvider);
registerProvider('openai-responses', createOpenAIResponseProvider);
registerProvider('gemini', createGeminiProvider);
registerProvider('deepseek-v4', createDeepSeekProvider);
// 云网关 backend(Anthropic via 云):复用 normalizeAnthropicStream,仅换请求构造 + 鉴权。
//   vertex = SSE 直接复用 parseSSE;bedrock = SigV4 + event-stream 帧 decoder。
registerProvider('bedrock-anthropic', createBedrockProvider);
registerProvider('vertex-anthropic', createVertexProvider);
