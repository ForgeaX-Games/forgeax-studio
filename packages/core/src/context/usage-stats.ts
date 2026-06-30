/**
 * Usage / context stats (A 层 · 015 /context + /cost) — 两个**纯计算**函数:
 *   - `summarizeUsage(usage, model)`:把累计 `Usage`(input/output/cache token)
 *     折算成可读汇总 + 估算费用(per-model 单价 × 百万 token)。
 *   - `contextStats(tokensOrHistory, model)`:当前 token、占模型窗口百分比、
 *     距下一道压缩水位(preCompact)还有多少 token。
 *
 * 背景:`provider/types.ts` 的 `Usage` 已有累计语义(`mergeUsage`),
 * `context/model-window.ts` / `model-context-table.ts` 有 per-model 窗口。
 * 但**无展示层**。本文件只补「纯计算」,不持有任何状态(累计 Usage 由谁持有
 * 见文末 notes,集成方接线)。
 *
 * 与水位的关系:`contextStats` 复用 `computeWatermarksFromModel`(比例制)算出
 * preCompact/emergency/blocking,使「距压缩水位」与真实自动压触发点一致。
 *
 * 全部纯函数、无 IO、无 Date.now。Boundary: 仅 import core-local 类型。
 */
import type { Usage } from '../provider/types';
import { EMPTY_USAGE } from '../provider/types';
import type { ModelContextInfo } from './compaction-types';
import { lookupModelContext } from './model-context-table';
import { computeWatermarksFromModel } from './watermarks';
import { estimateTokens } from './deterministic-compact';

// ─── 费用估算(per-model 单价)──────────────────────────────────────────────

/**
 * per-model 单价(USD / 百万 token),与窗口表分开:窗口表只关心容量,这里关心计费。
 *
 * 这是**保守内置默认**,会过期 —— host 可经 `overrides` 注入覆写,别当唯一真相。
 * 匹配用**前缀/包含**(model id 常带日期/版本后缀),先匹配更长/更专的 key。
 *
 * cacheWrite 一般 = input × 1.25(创建 5m cache 的溢价);cacheRead 一般 = input × 0.1
 * (命中 cache 的折扣)。各家计费略有差异,内置表按 anthropic 公开价的近似登记。
 */
export interface ModelPricing {
  /** 普通输入 token 单价(USD / 1M)。 */
  inputPerMillion: number;
  /** 输出 token 单价(USD / 1M)。 */
  outputPerMillion: number;
  /** cache 写入(创建)单价(USD / 1M);缺省按 input × 1.25。 */
  cacheWritePerMillion?: number;
  /** cache 读取(命中)单价(USD / 1M);缺省按 input × 0.1。 */
  cacheReadPerMillion?: number;
}

/** 未知模型兜底(0 单价 → 估费为 0,只展示 token,不误导用户)。 */
export const FALLBACK_PRICING: ModelPricing = {
  inputPerMillion: 0,
  outputPerMillion: 0,
};

/** 内置单价表:key 为 model id 子串(小写匹配)。先登记更长/更专的 key。 */
const PRICING_TABLE: Array<{ match: string; pricing: ModelPricing }> = [
  // Anthropic Claude(单位 USD / 1M token;近似公开价)
  { match: 'claude-opus', pricing: { inputPerMillion: 15, outputPerMillion: 75 } },
  { match: 'claude-sonnet-4', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { match: 'claude-sonnet', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { match: 'claude-haiku-4', pricing: { inputPerMillion: 1, outputPerMillion: 5 } },
  { match: 'claude-3-5-sonnet', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { match: 'claude-3-5-haiku', pricing: { inputPerMillion: 0.8, outputPerMillion: 4 } },
  { match: 'claude-3-haiku', pricing: { inputPerMillion: 0.25, outputPerMillion: 1.25 } },
  { match: 'claude', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  // OpenAI GPT
  { match: 'gpt-4o-mini', pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 } },
  { match: 'gpt-4o', pricing: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  { match: 'gpt-4.1', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
  { match: 'o3', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
  { match: 'gpt-', pricing: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  // Google Gemini
  { match: 'gemini-2', pricing: { inputPerMillion: 1.25, outputPerMillion: 5 } },
  { match: 'gemini-1.5-pro', pricing: { inputPerMillion: 1.25, outputPerMillion: 5 } },
  { match: 'gemini', pricing: { inputPerMillion: 1.25, outputPerMillion: 5 } },
  // DeepSeek
  { match: 'deepseek', pricing: { inputPerMillion: 0.27, outputPerMillion: 1.1 } },
];

/**
 * 查 model 的单价。匹配顺序:overrides(精确) → 内置表(子串,首个命中) → fallback。
 *
 * @param model     model id(可带日期/版本后缀)。
 * @param overrides host 注入的覆写(精确 key);优先级最高。
 */
export function lookupModelPricing(
  model: string | undefined,
  overrides?: Record<string, ModelPricing>,
): ModelPricing {
  if (!model) return FALLBACK_PRICING;
  if (overrides && overrides[model]) return overrides[model];
  const id = model.toLowerCase();
  for (const entry of PRICING_TABLE) {
    if (id.includes(entry.match)) return entry.pricing;
  }
  return FALLBACK_PRICING;
}

/** cacheWrite/cacheRead 单价缺省推导(write=input×1.25,read=input×0.1)。 */
function resolvePricing(p: ModelPricing): Required<Pick<ModelPricing, 'cacheWritePerMillion' | 'cacheReadPerMillion'>> & ModelPricing {
  return {
    ...p,
    cacheWritePerMillion: p.cacheWritePerMillion ?? p.inputPerMillion * 1.25,
    cacheReadPerMillion: p.cacheReadPerMillion ?? p.inputPerMillion * 0.1,
  };
}

/** 费用拆解(USD)。 */
export interface CostBreakdown {
  /** 普通 input token 费用。 */
  inputUsd: number;
  /** output token 费用。 */
  outputUsd: number;
  /** cache 写入(创建)费用。 */
  cacheWriteUsd: number;
  /** cache 读取(命中)费用。 */
  cacheReadUsd: number;
  /** 合计。 */
  totalUsd: number;
}

/** `summarizeUsage` 入参选项。 */
export interface SummarizeUsageOptions {
  /** host 注入的单价覆写(精确 model key)。 */
  pricingOverrides?: Record<string, ModelPricing>;
}

/** `summarizeUsage` 结果:token 汇总 + 费用拆解 + 用到的单价(供展示「按 X 计价」)。 */
export interface UsageSummary {
  model?: string;
  /** 原始累计 token 数。 */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** 计费维度的总 input(普通 + cache 写 + cache 读),便于展示「读了多少上下文」。 */
  totalInputTokens: number;
  /** 全口径 token(totalInput + output)。 */
  totalTokens: number;
  /** 费用拆解(USD);单价未知时各项为 0。 */
  cost: CostBreakdown;
  /** 实际套用的单价(已补全 cacheWrite/cacheRead 缺省)。 */
  pricing: ModelPricing;
  /** 单价是否未知(fallback,估费为 0);UI 据此提示「该模型无内置单价」。 */
  pricingKnown: boolean;
}

/**
 * 汇总累计 `Usage` → token 总览 + 估算费用(`/cost` 用)。
 *
 * 费用 = Σ(token 数 / 1e6 × 对应单价)。单价未知(fallback)时费用为 0,
 * `pricingKnown=false`,UI 应只展示 token 用量。
 *
 * @param usage 累计 usage(`mergeUsage` 维护;缺省取 EMPTY_USAGE)。
 * @param model 当前 model id(决定单价)。
 * @param opts  单价覆写。
 */
export function summarizeUsage(
  usage: Usage | undefined,
  model?: string,
  opts?: SummarizeUsageOptions,
): UsageSummary {
  const u = usage ?? EMPTY_USAGE;
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  const cacheCreationInputTokens = u.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = u.cacheReadInputTokens ?? 0;

  const raw = lookupModelPricing(model, opts?.pricingOverrides);
  const pricingKnown = raw !== FALLBACK_PRICING;
  const pricing = resolvePricing(raw);

  const inputUsd = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputUsd = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheWriteUsd = (cacheCreationInputTokens / 1_000_000) * pricing.cacheWritePerMillion;
  const cacheReadUsd = (cacheReadInputTokens / 1_000_000) * pricing.cacheReadPerMillion;
  const totalUsd = inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd;

  const totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

  return {
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalInputTokens,
    totalTokens: totalInputTokens + outputTokens,
    cost: { inputUsd, outputUsd, cacheWriteUsd, cacheReadUsd, totalUsd },
    pricing,
    pricingKnown,
  };
}

// ─── 上下文占用统计 ───────────────────────────────────────────────────────────

/** `contextStats` 入参选项。 */
export interface ContextStatsOptions {
  /** host 注入的 per-model 窗口覆写(精确 key);转交 model-context-table。 */
  modelOverrides?: Record<string, ModelContextInfo>;
}

/** `contextStats` 结果:当前占用 + 窗口 + 距各水位余量(`/context` 用)。 */
export interface ContextStats {
  model?: string;
  /** 当前上下文 token 数。 */
  tokens: number;
  /** 完整上下文窗口(token)。 */
  contextWindow: number;
  /** 扣除摘要预留后的有效窗口。 */
  effectiveWindow: number;
  /** 占**完整窗口**的百分比(0-100,可 >100 表示已溢出)。 */
  percentUsed: number;
  /** 占**有效窗口**的百分比(0-100;水位按有效窗口算,这个更贴近触发感受)。 */
  percentOfEffective: number;
  /** 主动预压水位(token);自动压在此触发。 */
  preCompactThreshold: number;
  /** 紧急压水位(token)。 */
  emergencyThreshold: number;
  /** 硬阻断上限(token)。 */
  blockingLimit: number;
  /** 距主动预压水位还剩多少 token(已越过则为负)。 */
  tokensToPreCompact: number;
  /** 距硬阻断上限还剩多少 token(已越过则为负)。 */
  tokensToBlocking: number;
}

/** 取入参的 token 数:数字直接用;消息数组用 `estimateTokens` 粗估(~4 char/token)。 */
function resolveTokens(tokensOrHistory: number | readonly unknown[]): number {
  return typeof tokensOrHistory === 'number' ? tokensOrHistory : estimateTokens(tokensOrHistory);
}

/**
 * 统计当前上下文占用(`/context` 用)。
 *
 * @param tokensOrHistory 当前 token 数(已知更精确,优先传)或消息历史(回退到 estimateTokens 粗估)。
 * @param model           当前 model id(决定窗口 + 水位)。
 * @param opts            窗口覆写。
 */
export function contextStats(
  tokensOrHistory: number | readonly unknown[],
  model?: string,
  opts?: ContextStatsOptions,
): ContextStats {
  const tokens = resolveTokens(tokensOrHistory);
  const modelInfo = lookupModelContext(model, opts?.modelOverrides);
  const marks = computeWatermarksFromModel(modelInfo);

  const contextWindow = modelInfo.contextWindow;
  const effectiveWindow = marks.effectiveWindow;

  const percentUsed = contextWindow > 0 ? (tokens / contextWindow) * 100 : 0;
  const percentOfEffective = effectiveWindow > 0 ? (tokens / effectiveWindow) * 100 : 0;

  return {
    model,
    tokens,
    contextWindow,
    effectiveWindow,
    percentUsed,
    percentOfEffective,
    preCompactThreshold: marks.preCompactThreshold,
    emergencyThreshold: marks.emergencyThreshold,
    blockingLimit: marks.blockingLimit,
    tokensToPreCompact: marks.preCompactThreshold - tokens,
    tokensToBlocking: marks.blockingLimit - tokens,
  };
}
