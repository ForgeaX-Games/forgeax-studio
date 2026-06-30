/**
 * error-stats 诊断聚合单测(移植 agentic_os 03.E.1 五类错误的诊断侧)。
 */
import { test, expect, describe } from 'bun:test';
import { aggregateErrorCategories, summarizeErrorStats } from '../src/diagnostics/error-stats';

describe('aggregateErrorCategories', () => {
  test('按类计数', () => {
    const stats = aggregateErrorCategories([
      { errorCategory: 'timeout' },
      { errorCategory: 'timeout' },
      { errorCategory: 'validation' },
    ]);
    expect(stats).toEqual({ timeout: 2, validation: 1 });
  });

  test('undefined / 缺字段 一律跳过(不计入)', () => {
    const stats = aggregateErrorCategories([
      { errorCategory: 'runtime_error' },
      { errorCategory: undefined },
      {},
      { errorCategory: 'runtime_error' },
    ]);
    expect(stats).toEqual({ runtime_error: 2 });
  });

  test('空数组 → 空 Record', () => {
    expect(aggregateErrorCategories([])).toEqual({});
  });

  test('全是非错误 → 空 Record', () => {
    expect(aggregateErrorCategories([{}, { errorCategory: undefined }])).toEqual({});
  });

  test('纯函数:不改入参', () => {
    const items = [{ errorCategory: 'timeout' }];
    const snapshot = JSON.stringify(items);
    aggregateErrorCategories(items);
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  test('五类全覆盖', () => {
    const stats = aggregateErrorCategories([
      { errorCategory: 'validation' },
      { errorCategory: 'unknown_tool' },
      { errorCategory: 'permission_denied' },
      { errorCategory: 'timeout' },
      { errorCategory: 'runtime_error' },
    ]);
    expect(stats).toEqual({
      validation: 1,
      unknown_tool: 1,
      permission_denied: 1,
      timeout: 1,
      runtime_error: 1,
    });
  });
});

describe('summarizeErrorStats', () => {
  test('空 → no errors', () => {
    expect(summarizeErrorStats({})).toBe('no errors');
  });

  test('全 0 计数 → no errors(过滤掉 0)', () => {
    expect(summarizeErrorStats({ timeout: 0 })).toBe('no errors');
  });

  test('按次数降序渲染 + 总数', () => {
    const s = summarizeErrorStats({ validation: 1, timeout: 2 });
    expect(s).toBe('3 error(s): timeout=2, validation=1');
  });

  test('同次数按名升序(确定顺序 → 逐字稳定)', () => {
    const s = summarizeErrorStats({ timeout: 1, validation: 1, runtime_error: 1 });
    // 三者同为 1 → 按名升序:runtime_error < timeout < validation
    expect(s).toBe('3 error(s): runtime_error=1, timeout=1, validation=1');
  });

  test('单类', () => {
    expect(summarizeErrorStats({ timeout: 5 })).toBe('5 error(s): timeout=5');
  });

  test('与 aggregate 串联端到端', () => {
    const stats = aggregateErrorCategories([
      { errorCategory: 'timeout' },
      { errorCategory: 'timeout' },
      { errorCategory: 'validation' },
      {},
    ]);
    expect(summarizeErrorStats(stats)).toBe('3 error(s): timeout=2, validation=1');
  });
});
