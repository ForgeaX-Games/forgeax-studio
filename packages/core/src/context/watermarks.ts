/**
 * Context-window watermarks (C7) — token thresholds that drive auto-compact,
 * UI warnings and the hard blocking limit.
 *
 * 两套并存(向后兼容):
 *  - **绝对 buffer**(`computeWatermarks(windowSize)`,既有测试依赖,**行为不变**):
 *      effectiveWindow = window - 20k;autoCompact = effective - 13k;
 *      warning = effective - 20k;blocking = effective - 3k。
 *  - **比例 + per-model**(`computeWatermarksFromModel(modelInfo, config?)`,改造后主用 #1):
 *      reserveForSummary = min(maxOutputTokens, 20k);effective = window - reserve;
 *      preCompact = effective × pct.preCompact(默认 0.80);
 *      emergency  = effective × pct.emergency (默认 0.92);
 *      warning    = effective × pct.warning  (默认 0.60);
 *      blocking   = effective - 3k(硬兜底)。
 *    env override:`FORGEAX_COMPACT_PCT_OVERRIDE`(覆写 preCompact 百分比,取值 1-100)/
 *      `FORGEAX_COMPACT_WINDOW`(把 window 钳到该上限)。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import type { Watermarks } from './types';
import type { ModelContextInfo, WatermarkConfig } from './compaction-types';

/** Tokens reserved for the compaction summary output. */
export const RESERVED_FOR_SUMMARY_TOKENS = 20_000;
/** auto-compact fires this far below the effective window. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** UI warning starts this far below the effective window. */
export const WARNING_BUFFER_TOKENS = 20_000;
/** hard blocking limit sits this far below the effective window. */
export const BLOCKING_BUFFER_TOKENS = 3_000;

/** 默认比例(决策 #1)。 */
export const DEFAULT_PRECOMPACT_PCT = 0.8;
export const DEFAULT_EMERGENCY_PCT = 0.92;
export const DEFAULT_WARNING_PCT = 0.6;

/** 非负钳制(极小窗口下不出负阈值,见 A-U8)。 */
function clamp0(n: number): number {
  return n > 0 ? n : 0;
}

/**
 * 旧版:按绝对 buffer 计算水位(`computeWatermarks(windowSize)`)。**行为不变**(既有测试依赖)。
 * 比例字段 `preCompactThreshold`/`emergencyThreshold` 取 `autoCompactThreshold`(旧只有一个自动压点)。
 *
 * @param windowSize 模型上下文窗口 token 数。
 * @param _model     预留 per-model hook(此函数不用;比例版见 computeWatermarksFromModel)。
 */
export function computeWatermarks(windowSize: number, _model?: string): Watermarks {
  const effectiveWindow = windowSize - RESERVED_FOR_SUMMARY_TOKENS;
  const autoCompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
  return {
    effectiveWindow,
    preCompactThreshold: autoCompactThreshold,
    emergencyThreshold: autoCompactThreshold,
    autoCompactThreshold,
    warningThreshold: effectiveWindow - WARNING_BUFFER_TOKENS,
    blockingLimit: effectiveWindow - BLOCKING_BUFFER_TOKENS,
  };
}

/** 读 env 比例 override(`FORGEAX_COMPACT_PCT_OVERRIDE`,取值 1-100 → 0.01-1.0);非法/缺省 → undefined。 */
export function readPctOverride(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.FORGEAX_COMPACT_PCT_OVERRIDE;
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return undefined;
  return parsed / 100;
}

/** 读 env 窗口上限(`FORGEAX_COMPACT_WINDOW`);非法/缺省 → undefined。 */
export function readWindowOverride(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.FORGEAX_COMPACT_WINDOW;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * 新版:按**比例 + per-model** 计算水位(改造后主用,决策 #1)。
 *
 * @param modelInfo 模型上下文信息(contextWindow + 可选 maxOutputTokens)。
 * @param config    比例覆写 + env source(测试可注入)。
 */
export function computeWatermarksFromModel(
  modelInfo: ModelContextInfo,
  config?: WatermarkConfig,
): Watermarks {
  const env = config?.env ?? process.env;
  const windowCap = readWindowOverride(env);
  const rawWindow = modelInfo.contextWindow;
  const window = windowCap !== undefined ? Math.min(rawWindow, windowCap) : rawWindow;

  const reserve = Math.min(
    modelInfo.maxOutputTokens ?? RESERVED_FOR_SUMMARY_TOKENS,
    RESERVED_FOR_SUMMARY_TOKENS,
  );
  const effectiveWindow = clamp0(window - reserve);

  const pctOverride = readPctOverride(env);
  const preCompactPct = pctOverride ?? config?.preCompactPct ?? DEFAULT_PRECOMPACT_PCT;
  const emergencyPct = config?.emergencyPct ?? DEFAULT_EMERGENCY_PCT;
  const warningPct = config?.warningPct ?? DEFAULT_WARNING_PCT;

  // Math.round(而非 floor):避开浮点尾差(如 180000×0.7=125999.999→126000),阈值取整更直觉。
  const preCompactThreshold = clamp0(Math.round(effectiveWindow * preCompactPct));
  const emergencyThreshold = clamp0(Math.round(effectiveWindow * emergencyPct));
  const warningThreshold = clamp0(Math.round(effectiveWindow * warningPct));
  const blockingLimit = clamp0(effectiveWindow - BLOCKING_BUFFER_TOKENS);

  return {
    effectiveWindow,
    preCompactThreshold,
    emergencyThreshold,
    autoCompactThreshold: emergencyThreshold, // 旧 strategy 复用 = 紧急点
    warningThreshold,
    blockingLimit,
  };
}
