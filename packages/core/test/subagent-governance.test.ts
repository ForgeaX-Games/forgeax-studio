/**
 * subagent 治理单测:并发上限(峰值不超 max / 结果全留 / 抛错释放槽位)、
 * 深度护栏(depthOf / withIncrementedDepth / assertDepth)、预算分摊(splitBudget)。
 */
import { test, expect, describe } from 'bun:test';
import {
  ConcurrencyLimiter,
  SUBAGENT_DEPTH_KEY,
  depthOf,
  withIncrementedDepth,
  assertDepth,
  splitBudget,
} from '../src/agent/subagent-governance';

/** 受控延迟:返回一个 promise + 手动 resolve(用于精确卡住并发槽位)。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ConcurrencyLimiter', () => {
  test('峰值并发不超过 max,且所有结果都保留', async () => {
    const max = 3;
    const limiter = new ConcurrencyLimiter(max);
    let cur = 0;
    let peak = 0;
    const total = 12;

    const tasks = Array.from({ length: total }, (_, i) =>
      limiter.run(async () => {
        cur++;
        peak = Math.max(peak, cur);
        // 给调度器机会同时排满槽位
        await new Promise((r) => setTimeout(r, 5));
        cur--;
        return i;
      }),
    );

    const results = await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(max);
    expect(peak).toBe(max); // 任务足够多,应真正打满
    expect(results).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  test('max<=0 视为无限:全部立即并发', async () => {
    const limiter = new ConcurrencyLimiter(0);
    let cur = 0;
    let peak = 0;
    const total = 8;
    const tasks = Array.from({ length: total }, () =>
      limiter.run(async () => {
        cur++;
        peak = Math.max(peak, cur);
        await new Promise((r) => setTimeout(r, 5));
        cur--;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(total);
  });

  test('FIFO:满载后空出的槽位按入队顺序放行', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const t0 = limiter.run(async () => {
      order.push(0);
      await gates[0].promise;
    });
    // 1、2 入队(FIFO)
    const t1 = limiter.run(async () => {
      order.push(1);
      await gates[1].promise;
    });
    const t2 = limiter.run(async () => {
      order.push(2);
      await gates[2].promise;
    });

    // 此刻只有 0 在跑,1、2 排队
    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.active).toBe(1);
    expect(limiter.queued).toBe(2);
    expect(order).toEqual([0]);

    gates[0].resolve(undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([0, 1]); // 1 先于 2

    gates[1].resolve(undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([0, 1, 2]);

    gates[2].resolve(undefined);
    await Promise.all([t0, t1, t2]);
    expect(limiter.active).toBe(0);
  });

  test('fn 抛错也释放槽位,不卡死后续', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);

    // 后续任务仍能正常拿到槽位
    const ok = await limiter.run(async () => 42);
    expect(ok).toBe(42);
  });

  test('抛错释放后,排队的后继被唤醒', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const gate = deferred();
    const ran: string[] = [];

    const first = limiter.run(async () => {
      ran.push('first');
      await gate.promise;
      throw new Error('fail');
    });
    const second = limiter.run(async () => {
      ran.push('second');
      return 'second-done';
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toEqual(['first']); // second 在排队
    expect(limiter.queued).toBe(1);

    gate.resolve(undefined);
    await expect(first).rejects.toThrow('fail');
    await expect(second).resolves.toBe('second-done');
    expect(ran).toEqual(['first', 'second']);
  });
});

describe('depth guard', () => {
  test('depthOf:缺省 / undefined / 非数字 → 0,有值 → 读出', () => {
    expect(depthOf(undefined)).toBe(0);
    expect(depthOf({})).toBe(0);
    expect(depthOf({ [SUBAGENT_DEPTH_KEY]: 3 })).toBe(3);
    expect(depthOf({ [SUBAGENT_DEPTH_KEY]: 'x' })).toBe(0);
    expect(depthOf({ [SUBAGENT_DEPTH_KEY]: NaN })).toBe(0);
  });

  test('withIncrementedDepth:浅拷贝 + 深度 +1,不改父', () => {
    const parent = { foo: 'bar' } as Record<string, unknown>;
    const child = withIncrementedDepth(parent);
    expect(child[SUBAGENT_DEPTH_KEY]).toBe(1);
    expect(child.foo).toBe('bar');
    expect(parent[SUBAGENT_DEPTH_KEY]).toBeUndefined(); // 父未被改

    const grand = withIncrementedDepth(child);
    expect(grand[SUBAGENT_DEPTH_KEY]).toBe(2);
  });

  test('assertDepth:超限抛(含上限),达限 ok,maxDepth<=0 永不抛', () => {
    expect(() => assertDepth(3, 2)).toThrow('2'); // 信息含上限
    expect(() => assertDepth(2, 2)).not.toThrow(); // 达限不抛
    expect(() => assertDepth(0, 2)).not.toThrow();
    expect(() => assertDepth(100, 0)).not.toThrow(); // 关闭
    expect(() => assertDepth(100, -1)).not.toThrow();
  });
});

describe('splitBudget', () => {
  test('undefined 透传', () => {
    expect(splitBudget(undefined)).toBeUndefined();
  });

  test('默认 0.5 + floor', () => {
    expect(splitBudget({ total: 100 })).toEqual({ total: 50 });
    expect(splitBudget({ total: 101 })).toEqual({ total: 50 }); // floor(50.5)
  });

  test('自定义 fraction + floor', () => {
    expect(splitBudget({ total: 100 }, 0.3)).toEqual({ total: 30 });
    expect(splitBudget({ total: 10 }, 0.33)).toEqual({ total: 3 }); // floor(3.3)
  });

  test('父有预算时子至少留 1', () => {
    expect(splitBudget({ total: 1 }, 0.1)).toEqual({ total: 1 }); // floor(0.1)=0 → 1
    expect(splitBudget({ total: 3 }, 0.1)).toEqual({ total: 1 }); // floor(0.3)=0 → 1
  });

  test('父预算为 0 → 子 0(不强行抬到 1)', () => {
    expect(splitBudget({ total: 0 }, 0.5)).toEqual({ total: 0 });
  });
});
