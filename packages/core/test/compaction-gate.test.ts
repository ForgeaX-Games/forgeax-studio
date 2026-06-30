/**
 * Stream B 验收:触发闸 & 节流(#7/#9/#10/#3)。Cases B-U1..U11。
 * 见 docs/features/compaction-overhaul-verification.md §2。
 */
import { describe, test, expect } from 'bun:test';
import {
  evaluateGate,
  markCompactStart,
  markCompactSuccess,
  markCompactFailure,
  initialGateState,
  isRecursiveSource,
  triggerThresholdFor,
} from '../src/context/compaction-gate';
import {
  CompactType,
  DEFAULT_GATE_CONFIG,
  type CompactionGateInput,
  type CompactionGateState,
} from '../src/context/compaction-types';
import { computeWatermarksFromModel } from '../src/context/watermarks';

const marks = computeWatermarksFromModel({ contextWindow: 200_000, maxOutputTokens: 64_000 });
// effective=180k; preCompact=144k; emergency=165_600

function base(over: Partial<CompactionGateInput> = {}): CompactionGateInput {
  return {
    tokenCount: 170_000, // > emergency(165_600) → 越线
    marks,
    type: CompactType.EMERGENCY_AUTO,
    state: initialGateState(),
    now: 1_000_000,
    autoCompactEnabled: true,
    config: DEFAULT_GATE_CONFIG,
    ...over,
  };
}

describe('Stream B — compaction gate (#7/#9/#10/#3)', () => {
  test('B-U1 关闭 → disabled', () => {
    expect(evaluateGate(base({ autoCompactEnabled: false }))).toEqual({
      compact: false,
      reason: 'disabled',
    });
  });

  test('B-U2 忙 → busy', () => {
    const state: CompactionGateState = { isCompressing: true, consecutiveFailures: 0 };
    expect(evaluateGate(base({ state }))).toEqual({ compact: false, reason: 'busy' });
  });

  test('B-U3 冷却内 → cooldown', () => {
    const state: CompactionGateState = {
      isCompressing: false,
      consecutiveFailures: 0,
      lastCompactAt: 1_000_000 - 29_999,
    };
    expect(evaluateGate(base({ state }))).toEqual({ compact: false, reason: 'cooldown' });
  });

  test('B-U4 冷却边界 30_000ms → 放行', () => {
    const state: CompactionGateState = {
      isCompressing: false,
      consecutiveFailures: 0,
      lastCompactAt: 1_000_000 - 30_000,
    };
    expect(evaluateGate(base({ state }))).toEqual({ compact: true });
  });

  test('B-U5 熔断跳闸(failures=3)', () => {
    const state: CompactionGateState = { isCompressing: false, consecutiveFailures: 3 };
    expect(evaluateGate(base({ state }))).toEqual({ compact: false, reason: 'circuit-open' });
  });

  test('B-U6 熔断未到(failures=2)→ 放行', () => {
    const state: CompactionGateState = { isCompressing: false, consecutiveFailures: 2 };
    expect(evaluateGate(base({ state }))).toEqual({ compact: true });
  });

  test('B-U7 递归来源 → recursive;普通来源放行', () => {
    expect(evaluateGate(base({ querySource: 'summary' }))).toEqual({
      compact: false,
      reason: 'recursive',
    });
    expect(evaluateGate(base({ querySource: 'subagent-internal' }))).toEqual({
      compact: false,
      reason: 'recursive',
    });
    expect(evaluateGate(base({ querySource: 'normal' }))).toEqual({ compact: true });
    expect(isRecursiveSource(undefined)).toBe(false);
  });

  test('B-U8 阈值:未越线 below-threshold;越线 compact', () => {
    expect(evaluateGate(base({ tokenCount: 165_599 }))).toEqual({
      compact: false,
      reason: 'below-threshold',
    });
    expect(evaluateGate(base({ tokenCount: 165_600 }))).toEqual({ compact: true }); // >= 即过
    // pre-message 用 preCompactThreshold(144k)
    expect(
      evaluateGate(base({ type: CompactType.PRE_MESSAGE_AUTO, tokenCount: 143_999 })),
    ).toEqual({ compact: false, reason: 'below-threshold' });
    expect(
      evaluateGate(base({ type: CompactType.PRE_MESSAGE_AUTO, tokenCount: 144_000 })),
    ).toEqual({ compact: true });
  });

  test('B-U9 短路顺序:disabled 先于 busy 先于越线', () => {
    const state: CompactionGateState = { isCompressing: true, consecutiveFailures: 0 };
    // disabled + busy 同时 → disabled 最先
    expect(evaluateGate(base({ autoCompactEnabled: false, state }))).toEqual({
      compact: false,
      reason: 'disabled',
    });
    // busy + cooldown 同时 → busy 先
    const busyCooldown: CompactionGateState = {
      isCompressing: true,
      consecutiveFailures: 0,
      lastCompactAt: 1_000_000 - 1,
    };
    expect(evaluateGate(base({ state: busyCooldown }))).toEqual({ compact: false, reason: 'busy' });
  });

  test('B-U9b manual(/compact)绕过 disabled/cooldown/阈值,仅受 busy', () => {
    const cold: CompactionGateState = {
      isCompressing: false,
      consecutiveFailures: 5, // 即便熔断
      lastCompactAt: 1_000_000 - 1, // 即便冷却内
    };
    expect(
      evaluateGate(
        base({
          type: CompactType.USER_COMMAND,
          autoCompactEnabled: false, // 即便自动压关
          tokenCount: 0, // 即便未越线
          state: cold,
        }),
      ),
    ).toEqual({ compact: true });
    // 但 busy 仍拦
    expect(
      evaluateGate(
        base({ type: CompactType.USER_COMMAND, state: { isCompressing: true, consecutiveFailures: 0 } }),
      ),
    ).toEqual({ compact: false, reason: 'busy' });
  });

  test('B-U10 状态转移', () => {
    const s0 = initialGateState();
    expect(s0).toEqual({ isCompressing: false, consecutiveFailures: 0 });
    const started = markCompactStart(s0);
    expect(started.isCompressing).toBe(true);
    const ok = markCompactSuccess(started, 12_345);
    expect(ok).toEqual({ isCompressing: false, consecutiveFailures: 0, lastCompactAt: 12_345 });
    const failed = markCompactFailure(markCompactStart({ isCompressing: false, consecutiveFailures: 2 }));
    expect(failed).toEqual({ isCompressing: false, consecutiveFailures: 3 });
  });

  test('B-U11 纯函数:同 input 多次同结果;不改入参', () => {
    const input = base();
    const a = evaluateGate(input);
    const b = evaluateGate(input);
    expect(a).toEqual(b);
    const s = initialGateState();
    markCompactStart(s);
    expect(s).toEqual({ isCompressing: false, consecutiveFailures: 0 }); // 入参未被改
    expect(triggerThresholdFor(CompactType.USER_COMMAND, marks)).toBe(0);
  });
});
