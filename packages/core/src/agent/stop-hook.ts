/**
 * Stop-hook gate (LOOP completion check) — 纯函数判定「Stop hook 是否要求继续跑」。
 *
 * Stop hook(`stop_hook`):loop 在认为可以结束(end_turn / 无
 * tool_use)时,先把结果交给 Stop hook;hook 返回 `preventStop===true` 表示
 * 「别停,继续跑」(翻成续轮 ContinueReason `stop_hook_blocking` /
 * 终态 `stop_hook_prevented`)。本 gate 只做这一条纯判定,不持有 loop 状态、
 * 不发事件、不 IO —— 编排(续轮 vs 终止、发什么事件)留给集成者。
 *
 * 设计取舍:
 *   - hook 结果同时携带 `blocked`(阻断本次工具/动作)与 `preventStop`
 *     (阻止收尾)两路信号;本 gate 只关心收尾路 —— `prevented` 当且仅当
 *     `preventStop===true`。`blocked` 单独透出(诊断/集成者另行处理),**不**
 *     等价于 prevented(语义不同:block 是拦动作,preventStop 是拦收尾)。
 *   - fail-open?不。缺省(undefined / 非 true)一律 `prevented:false`(放行收尾),
 *     即「hook 没明说要继续 → 就停」,符合「不主动制造无限循环」的安全默认。
 *
 * 纯函数,无副作用、无 IO、无 import —— 便于单测,Boundary 自然满足。
 */

/** Stop hook 发布后的归一结果(EventBus publish 回执的相关子集)。 */
export interface StopHookPublishResult {
  /** hook 是否阻断了本次动作(诊断透出;与 prevented 语义不同,不参与 prevented 判定)。 */
  blocked?: boolean;
  /** hook 是否要求「别停、继续跑」—— 唯一决定 prevented 的字段。 */
  preventStop?: boolean;
  /** hook 给出的原因(LLM-visible / 日志用;原样透传)。 */
  reason?: string;
}

/** Stop-hook gate 判定结果。 */
export interface StopHookDecision {
  /** 是否阻止收尾(continue loop)。当且仅当 publishResult.preventStop===true。 */
  prevented: boolean;
  /** 透传 hook 的 reason(prevented 时尤其有用,可作 system-reminder 喂回模型)。 */
  reason?: string;
}

/**
 * 评估 Stop hook:`prevented` iff `preventStop===true`(hook 明确要求继续)。
 * 其余一切情形(undefined / false / 仅 blocked)→ `prevented:false`(放行收尾)。
 * reason 原样透传,便于集成者注回上下文 / 落日志。
 */
export function evaluateStopHook(publishResult: StopHookPublishResult): StopHookDecision {
  const prevented = publishResult?.preventStop === true;
  return prevented ? { prevented: true, reason: publishResult.reason } : { prevented: false };
}
