/**
 * Per-model context-window table (Stream A / #1) — model id → {contextWindow, maxOutputTokens}.
 *
 * 改造后水位走比例制(`computeWatermarksFromModel`),需要每个模型的真实窗口/最大输出。
 * 本表是**保守内置默认**:覆盖常用 anthropic/openai/gemini/deepseek 系;未知 model
 * 走 `FALLBACK_MODEL_CONTEXT`(200k 窗口)。表会过期 —— host 可经 `overrides` 注入覆写,
 * 别把它当唯一真相。匹配用**前缀/包含**(model id 常带日期/版本后缀)。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import type { ModelContextInfo } from './compaction-types';

/** 未知模型兜底(保守 200k 窗口 / 不声明 maxOutput → 预留按 20k)。 */
export const FALLBACK_MODEL_CONTEXT: ModelContextInfo = { contextWindow: 200_000 };

/** 内置表:key 为 model id 子串(小写匹配)。先匹配更长/更专的 key。 */
const TABLE: Array<{ match: string; info: ModelContextInfo }> = [
  // Anthropic Claude(200k 窗口;1M context 变体单列)
  { match: 'claude-opus-4-8[1m]', info: { contextWindow: 1_000_000, maxOutputTokens: 128_000 } },
  { match: 'claude-opus-4', info: { contextWindow: 200_000, maxOutputTokens: 128_000 } },
  { match: 'claude-sonnet-4', info: { contextWindow: 200_000, maxOutputTokens: 64_000 } },
  { match: 'claude-haiku-4', info: { contextWindow: 200_000, maxOutputTokens: 32_000 } },
  { match: 'claude-3-5-sonnet', info: { contextWindow: 200_000, maxOutputTokens: 8_192 } },
  { match: 'claude', info: { contextWindow: 200_000, maxOutputTokens: 32_000 } },
  // OpenAI GPT
  { match: 'gpt-4o', info: { contextWindow: 128_000, maxOutputTokens: 16_384 } },
  { match: 'gpt-4.1', info: { contextWindow: 1_000_000, maxOutputTokens: 32_768 } },
  { match: 'o3', info: { contextWindow: 200_000, maxOutputTokens: 100_000 } },
  { match: 'gpt-4', info: { contextWindow: 128_000, maxOutputTokens: 8_192 } },
  { match: 'gpt-', info: { contextWindow: 128_000, maxOutputTokens: 16_384 } },
  // Google Gemini
  { match: 'gemini-2', info: { contextWindow: 1_000_000, maxOutputTokens: 65_536 } },
  { match: 'gemini-1.5-pro', info: { contextWindow: 2_000_000, maxOutputTokens: 8_192 } },
  { match: 'gemini', info: { contextWindow: 1_000_000, maxOutputTokens: 8_192 } },
  // DeepSeek
  { match: 'deepseek', info: { contextWindow: 128_000, maxOutputTokens: 8_192 } },
];

/**
 * 查 model 的上下文信息。匹配顺序:overrides(精确) → 内置表(子串,首个命中) → fallback。
 *
 * @param model     model id(可带日期/版本后缀)。
 * @param overrides host 注入的覆写(精确 key);优先级最高。
 */
export function lookupModelContext(
  model: string | undefined,
  overrides?: Record<string, ModelContextInfo>,
): ModelContextInfo {
  if (!model) return FALLBACK_MODEL_CONTEXT;
  if (overrides && overrides[model]) return overrides[model];
  const id = model.toLowerCase();
  for (const entry of TABLE) {
    if (id.includes(entry.match)) return entry.info;
  }
  return FALLBACK_MODEL_CONTEXT;
}
