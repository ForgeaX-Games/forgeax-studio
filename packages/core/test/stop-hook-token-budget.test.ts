/**
 * Stop-hook gate + token-budget gate (WORKSTREAM 2) 单测。
 * 覆盖:evaluateStopHook(prevented iff preventStop===true) +
 *       isBudgetExhausted / shouldContinueForBudget(无预算无界、≥ 耗尽、互补)。
 */
import { test, expect, describe } from 'bun:test';
import { evaluateStopHook } from '../src/agent/stop-hook';
import { isBudgetExhausted, shouldContinueForBudget } from '../src/agent/token-budget';

describe('evaluateStopHook — prevented iff preventStop===true', () => {
  test('preventStop=true → prevented, 透传 reason', () => {
    const d = evaluateStopHook({ preventStop: true, reason: 'keep going' });
    expect(d.prevented).toBe(true);
    expect(d.reason).toBe('keep going');
  });

  test('preventStop=true 无 reason → prevented, reason undefined', () => {
    const d = evaluateStopHook({ preventStop: true });
    expect(d.prevented).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  test('preventStop 缺省 → 放行收尾(prevented=false)', () => {
    expect(evaluateStopHook({}).prevented).toBe(false);
  });

  test('preventStop=false → 放行收尾', () => {
    const d = evaluateStopHook({ preventStop: false, reason: 'ignored' });
    expect(d.prevented).toBe(false);
    // 非 prevented 路不透传 reason(语义:没拦收尾就不带原因)。
    expect(d.reason).toBeUndefined();
  });

  test('仅 blocked=true(无 preventStop)→ 不等价 prevented(语义不同)', () => {
    expect(evaluateStopHook({ blocked: true }).prevented).toBe(false);
  });

  test('blocked=true 且 preventStop=true → prevented(preventStop 主导)', () => {
    expect(evaluateStopHook({ blocked: true, preventStop: true }).prevented).toBe(true);
  });
});

describe('isBudgetExhausted — 无预算无界 + ≥ 耗尽', () => {
  test('无 taskBudget → 永不耗尽(false)', () => {
    expect(isBudgetExhausted(0)).toBe(false);
    expect(isBudgetExhausted(1_000_000)).toBe(false);
    expect(isBudgetExhausted(50, undefined)).toBe(false);
  });

  test('spent < total → 未耗尽', () => {
    expect(isBudgetExhausted(99, { total: 100 })).toBe(false);
  });

  test('spent == total → 耗尽(达额即停)', () => {
    expect(isBudgetExhausted(100, { total: 100 })).toBe(true);
  });

  test('spent > total → 耗尽', () => {
    expect(isBudgetExhausted(101, { total: 100 })).toBe(true);
  });

  test('total=0 → spent>=0 恒耗尽', () => {
    expect(isBudgetExhausted(0, { total: 0 })).toBe(true);
  });
});

describe('shouldContinueForBudget — 无预算不逼续轮 + 与 exhausted 互补', () => {
  test('无 taskBudget → 不靠预算续轮(false)', () => {
    expect(shouldContinueForBudget(0)).toBe(false);
    expect(shouldContinueForBudget(123, undefined)).toBe(false);
  });

  test('有预算且未耗尽 → 续轮(true)', () => {
    expect(shouldContinueForBudget(99, { total: 100 })).toBe(true);
  });

  test('有预算且耗尽 → 不续轮(false)', () => {
    expect(shouldContinueForBudget(100, { total: 100 })).toBe(false);
    expect(shouldContinueForBudget(200, { total: 100 })).toBe(false);
  });

  test('有预算时 shouldContinue === !isExhausted(互补)', () => {
    const budget = { total: 100 };
    for (const spent of [0, 50, 99, 100, 101]) {
      expect(shouldContinueForBudget(spent, budget)).toBe(!isBudgetExhausted(spent, budget));
    }
  });
});
