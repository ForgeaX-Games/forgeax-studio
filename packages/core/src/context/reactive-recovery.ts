/**
 * Reactive recovery helpers (C7) — 纯函数判定 loop 在「截断 / 超长」边界时的反应式恢复。
 *
 * 两条反应式恢复路:
 *   - max_output_tokens 恢复(queryLoop):assistant 文本被 `max_tokens` 截断、且本轮
 *     **零 tool_use** 时,这是「话没说完就被切」——loop 不应判完成,而应自动续一条
 *     "Please continue from where you left off." 让模型接着写(`shouldContinueOnMaxTokens`
 *     + `buildContinuationMessage`)。若本轮已有 tool_use,则按正常 tool 循环走,不在此处续。
 *   - PROMPT_TOO_LONG 反应式压缩(autoCompact reactive 路):provider 抛
 *     content === PROMPT_TOO_LONG_MESSAGE 的错时,loop 据此触发 reactive compact 而非直接
 *     model_error(`isPromptTooLong`)。
 *   - blocking 硬上限(MANUAL_COMPACT_BUFFER 水位):token 触顶 blockingLimit 时阻断续发
 *     (`isOverBlockingLimit`,与 watermarks.ts 的三区水位配套)。
 *
 * 设计与本包其它 context 模块一致:纯函数、无副作用、无 IO,fail-closed
 * (判定不确定时倾向「不自动续 / 视为触限」的保守值)。Boundary: 仅 import core-local 类型。
 */
import type { ProviderMessage, StopReason } from '../provider/types';
import { PROMPT_TOO_LONG_MESSAGE } from '../provider/types';
import type { Watermarks } from './types';

/** 续跑提示文案(max_output_tokens 恢复注入的 user 续条)。 */
export const CONTINUATION_PROMPT = 'Please continue from where you left off.';

/**
 * 是否应在 `max_tokens` 截断时自动续跑(而非判完成)。
 *
 * true 当且仅当 `stopReason === 'max_tokens'` 且本轮 `toolUseCount === 0`:
 * 即模型在**纯文本**输出中被 max_output_tokens 切断、话没说完。此时 loop 续一条
 * continuation user 消息让其接着写。
 * 若本轮带了 tool_use(toolUseCount > 0),走正常 tool 循环,不在此处续(返回 false)。
 *
 * queryLoop 的 max_output_tokens 恢复分支。
 */
export function shouldContinueOnMaxTokens(stopReason: StopReason, toolUseCount: number): boolean {
  return stopReason === 'max_tokens' && toolUseCount === 0;
}

/** 构造续跑用的 user 消息(注入的 "Please continue..." 续条)。 */
export function buildContinuationMessage(): ProviderMessage {
  return { role: 'user', content: CONTINUATION_PROMPT };
}

/** 真实 provider 在「上下文窗口溢出」时露出的关键词(HTTP body / message 里)。
 *  覆盖 anthropic("prompt is too long")与 openai 系("context length exceeded"/
 *  "maximum context length"/"context_length_exceeded"/"too many tokens")。 */
const PTL_KEYWORDS = [
  'prompt is too long',
  'prompt too long',
  'context length exceeded',
  'maximum context length',
  'context_length_exceeded',
  'context window',
  'too many tokens',
];

/**
 * 是否为 PROMPT_TOO_LONG 错误(供 loop 触发 reactive compact,而非直接 model_error)。
 *
 * 判定(任一成立):
 *  1. `message` 以 `PROMPT_TOO_LONG_MESSAGE` 开头(core 中立形 / 已归一的串);
 *  2. **真实 provider 形状**:HTTP 400 且 message/body 含上下文溢出关键词 —— 真实
 *     anthropic provider 抛 `anthropic API error 400: …prompt is too long…`
 *     (provider/anthropic.ts:throwHttpError),并不走 (1)。gate 在 `400 + 关键词`,
 *     避免把别的 400(如 schema 错)误判为可压缩。
 *
 * 非 Error → false(fail-closed:交由上层走通用错误路)。
 */
export function isPromptTooLong(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.startsWith(PROMPT_TOO_LONG_MESSAGE)) return true;
  const e = err as { status?: number; statusCode?: number };
  const status = e.status ?? e.statusCode;
  if (status === 400) {
    const msg = err.message.toLowerCase();
    if (PTL_KEYWORDS.some((k) => msg.includes(k))) return true;
  }
  return false;
}

/**
 * token 是否已触/越硬阻断上限(MANUAL_COMPACT_BUFFER 水位:effective - 3k)。
 * `>=` 即视为触限(含恰好相等),与 watermarks.ts 的三区语义配套。
 */
export function isOverBlockingLimit(tokenCount: number, marks: Watermarks): boolean {
  return tokenCount >= marks.blockingLimit;
}
