/**
 * Compaction trigger gate (Stream B / #7·#9·#10·#3) — 纯函数触发闸 + 节流状态机。
 *
 * `evaluateGate` 有序短路决定「该不该压」;`markCompactStart/Success/Failure` 是纯状态转移
 * (host 持有 `CompactionGateState`,跨压缩更新)。全部纯函数、now 注入、无 IO。
 *
 * 顺序(auto 类型):disabled → busy → cooldown → circuit-open → recursive → below-threshold。
 * **manual(`/compact`)= 用户强制**:绕过 disabled/cooldown/circuit/recursive/threshold,
 * 仅受 `busy` 约束(不能与正在跑的压缩并发)。
 *
 * 阈值按类型选:EMERGENCY_AUTO → emergencyThreshold;PRE_MESSAGE_AUTO → preCompactThreshold。
 *
 * Boundary: 仅 import core-local 类型。
 */
import {
  CompactType,
  type CompactionGateInput,
  type CompactionGateState,
  type GateDecision,
} from './compaction-types';
import type { Watermarks } from './types';

/** 会触发递归自压死锁的来源(摘要 agent / subagent 内部),应被拦(#3)。 */
const RECURSIVE_SOURCES = new Set(['summary', 'subagent-internal']);

export function isRecursiveSource(querySource?: string): boolean {
  return querySource !== undefined && RECURSIVE_SOURCES.has(querySource);
}

/** 按压缩类型选触发阈值(manual 不走阈值)。 */
export function triggerThresholdFor(type: CompactType, marks: Watermarks): number {
  switch (type) {
    case CompactType.EMERGENCY_AUTO:
      return marks.emergencyThreshold;
    case CompactType.PRE_MESSAGE_AUTO:
      return marks.preCompactThreshold;
    case CompactType.USER_COMMAND:
      return 0; // 未用(manual 绕过阈值);0 表示恒过
  }
}

/**
 * 评估是否应压缩。有序短路返回首个命中的拒绝原因,全过 → `{compact:true}`。
 */
export function evaluateGate(input: CompactionGateInput): GateDecision {
  const { type, state, config, now } = input;
  const manual = type === CompactType.USER_COMMAND;

  // 1. disabled(仅 auto;manual 绕过 —— autoCompactEnabled 只管自动压)
  if (!manual && !input.autoCompactEnabled) return { compact: false, reason: 'disabled' };

  // 2. busy(所有类型 —— 不能与正在跑的压缩并发)
  if (state.isCompressing) return { compact: false, reason: 'busy' };

  if (!manual) {
    // 3. cooldown
    if (state.lastCompactAt !== undefined && now - state.lastCompactAt < config.cooldownMs) {
      return { compact: false, reason: 'cooldown' };
    }
    // 4. circuit-open(连续失败熔断)
    if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
      return { compact: false, reason: 'circuit-open' };
    }
    // 5. recursive(摘要/subagent 内部来源防死锁)
    if (isRecursiveSource(input.querySource)) return { compact: false, reason: 'recursive' };
    // 6. below-threshold
    if (input.tokenCount < triggerThresholdFor(type, input.marks)) {
      return { compact: false, reason: 'below-threshold' };
    }
  }

  return { compact: true };
}

// ─── 状态转移(纯函数;返回新对象,不改入参)──────────────────────────────────

/** 压缩开始:置 isCompressing。 */
export function markCompactStart(state: CompactionGateState): CompactionGateState {
  return { ...state, isCompressing: true };
}

/** 压缩成功:清 isCompressing + 记冷却戳(now)+ 清熔断计数。 */
export function markCompactSuccess(state: CompactionGateState, now: number): CompactionGateState {
  return { ...state, isCompressing: false, lastCompactAt: now, consecutiveFailures: 0 };
}

/** 压缩失败:清 isCompressing + 熔断计数 +1(不记冷却戳)。 */
export function markCompactFailure(state: CompactionGateState): CompactionGateState {
  return { ...state, isCompressing: false, consecutiveFailures: state.consecutiveFailures + 1 };
}

/** 初始 gate 状态。 */
export function initialGateState(): CompactionGateState {
  return { isCompressing: false, consecutiveFailures: 0 };
}
