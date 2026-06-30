/**
 * Per-model context-window table (C7) — maps a model id to its real context
 * window so watermarks recompute when the model SWITCHES mid-session.
 *
 * 背景:之前 facade / CLI 把 contextWindow 硬编码成 flat 200_000(见
 * kernel-facade / cli/main),与 `req.model` 无关。后果:
 *   - 切到 1M 长上下文模型(项目用 `[1m]` 标记)→ 仍在 167k 就过早压缩,白白浪费窗口;
 *   - 切到 <200k 的小窗口模型 → 水位高估容量 → provider 真实 400 才暴露。
 * 本表按 model id 推导窗口,facade/CLI 每轮用当前 model 重算水位。未知 id 取保守
 * 默认 200k;即便误判,reactive PROMPT_TOO_LONG 恢复仍兜底(reactive-recovery.ts)。
 *
 * Boundary: 纯函数,无 import。
 */

/** 保守默认窗口(未知模型 / 未指定)。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** 1M-token 长上下文窗口(opus/sonnet 的 `[1m]` 变体)。 */
export const LONG_CONTEXT_WINDOW = 1_000_000;

/**
 * 由 model id 推导真实上下文窗口(token)。
 *
 * 识别规则:
 *  - id 含独立的 `1m` 段(`[1m]` / `-1m` / 结尾 `1m` 等,词边界匹配,不误中 `100m`)
 *    → 1_000_000;
 *  - 其余 → DEFAULT_CONTEXT_WINDOW(200k,Claude 家族标准窗口)。
 *
 * 表保持小而保守:新增已知小窗口模型时在此登记即可,无需改 loop。
 */
export function contextWindowForModel(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const m = model.toLowerCase();
  if (/(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(m)) return LONG_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}
