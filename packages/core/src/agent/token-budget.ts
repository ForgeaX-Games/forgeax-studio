/**
 * Token-budget gate (LOOP completion check) — 纯函数判定「按 token 预算是否该停/续」。
 *
 * `taskBudget` + 续轮 ContinueReason `token_budget_continuation`:
 * 当 host 给本任务设了 token 总预算(`AgentLoopConfig.taskBudget.total`),loop 在
 * 收尾点对照已花 token 决定 —— 还有预算且要继续做事时,以
 * `token_budget_continuation` 续轮;预算耗尽则该停(集成者据此收口)。
 * 本 gate 只出两条纯判定,不持有 loop 状态、不发事件、不 IO —— 编排留给集成者。
 *
 * 设计取舍:
 *   - **无预算即无界**:`taskBudget` 缺省(undefined)→ `isBudgetExhausted` 恒
 *     `false`、`shouldContinueForBudget` 恒 `false`(没设预算 → 不靠预算逼续轮,
 *     也永不因预算判耗尽)。这是「未声明预算 = 不参与本判定」的零回归默认。
 *   - **耗尽用 ≥**:`spent >= total` 即耗尽(达额即停,不等超额),fail-closed
 *     地保护 token 上限。
 *   - 两个谓词互斥且不重叠:exhausted ⟺ 不该 continue(有预算时);无预算时两者皆 false。
 *
 * 纯函数,无副作用、无 IO、无 import —— 便于单测,Boundary 自然满足。
 */

/** 任务 token 预算(taskBudget;total=本任务可花的 token 上限)。 */
export interface TaskBudget {
  total: number;
}

/**
 * 预算是否耗尽。无预算(undefined)→ `false`(无界,永不耗尽)。
 * 有预算 → `spentTokens >= total` 即耗尽(达额即停)。
 */
export function isBudgetExhausted(spentTokens: number, taskBudget?: TaskBudget): boolean {
  if (!taskBudget) return false;
  return spentTokens >= taskBudget.total;
}

/**
 * 是否应「因尚有 token 预算」而续轮(对齐 ContinueReason token_budget_continuation)。
 * 无预算(undefined)→ `false`(不靠预算逼续轮)。有预算且未耗尽 → `true`。
 * 与 isBudgetExhausted 互补:有预算时恒为其取反。
 */
export function shouldContinueForBudget(spentTokens: number, taskBudget?: TaskBudget): boolean {
  if (!taskBudget) return false;
  return !isBudgetExhausted(spentTokens, taskBudget);
}
