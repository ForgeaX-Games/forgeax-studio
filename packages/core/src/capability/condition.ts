/**
 * Unified capability-pack condition evaluator (§3.4.9).
 *
 * Core-layer-spec §3.4.9 demands a single condition evaluator reused in three
 * places (loader pack admission / registry assembly gating / PERM pre-gate).
 * 对齐 cli `kits/base-loader.ts` 的 condition 包级准入语义 (fail-closed: 谓词
 * 抛错 → 整包跳过) —— 但 core 这里只做「纯求值 + fail-closed」,不负责发现/包装。
 *
 * Boundary: 仅 import C2 契约。无 node:、无 IO。
 */
import type { CapabilityCondition, ConditionContext } from './types';

/**
 * 求值一个包级 condition。
 *
 * 语义 (与 cli `wrapWithKitCondition` 对齐):
 *   - `cond` 缺省 (undefined) ⇒ 总激活 (return true)。
 *   - `cond(ctx)` 返回 truthy ⇒ 激活。
 *   - `cond(ctx)` 抛错 ⇒ **fail-closed** (return false),不让坏 condition 把
 *     整个加载流程带崩,也不让它误激活。
 *
 * 三处复用同一函数: loader 决定整包是否加载、registry 在装配时按 role/STATUS
 * 重新 gate、PERM 在把闸前确认包仍激活 —— 都调本函数,保证语义一致。
 */
export function evaluateCondition(
  cond: CapabilityCondition | undefined,
  ctx: ConditionContext,
): boolean {
  if (cond === undefined) return true;
  try {
    return cond(ctx) === true;
  } catch {
    return false; // fail-closed
  }
}
