/**
 * Subagent 治理(Task 并发上限 / 递归深度护栏 / token 预算分摊)。
 *
 * 三块互不耦合的纯治理原语,集成者(subagent.ts / dispatch.ts)按需组合:
 *   1. **并发上限**(`ConcurrencyLimiter`):同一时刻最多 `max` 个子 loop 在跑,
 *      超出的 FIFO 排队,有空位即按序放行 —— 给 Task fan-out 设的并发闸,
 *      防一次派太多子 agent 把 provider / token 打爆。
 *   2. **深度护栏**(`depthOf` / `withIncrementedDepth` / `assertDepth`):用 toolContext
 *      里的 `__subagentDepth` 计数,子派子时 +1,超过 `maxDepth` 即抛 —— 防 Task 套
 *      Task 无限递归(即便工具集没去掉 Task 也兜得住)。
 *   3. **预算分摊**(`splitBudget`):父的 token 预算按 `fraction` 切给子,floor 取整、
 *      父有预算时子至少留 1 —— subagent 继承一部分 taskBudget 的取舍。
 *
 * 全部纯逻辑 / 无 IO / 无副作用、仅 core 相对 import(此处零 import)→ Boundary 自然满足。
 */

/**
 * 并发上限闸:同一时刻最多 `max` 个 `run()` body 在执行,超出的按 FIFO 入队,
 * 有空位即按入队顺序放行。
 *
 * - `max <= 0` 视为**无限**(不限流,所有 run() 立即执行)。
 * - `run(fn)` 返回 `fn()` 的 promise;`fn` 抛错时**也释放槽位**(finally),不卡死后续。
 * - 排队顺序严格 FIFO(先入队先放行)。
 */
export class ConcurrencyLimiter {
  private readonly max: number;
  private running = 0;
  /** FIFO 等待队列:每项是「拿到槽位时」要 resolve 的回调。 */
  private readonly waiters: Array<() => void> = [];

  /** @param max 最大并发数;`<=0` 表示无限。 */
  constructor(max: number) {
    this.max = max;
  }

  /** 当前正在执行的 run() body 数。 */
  get active(): number {
    return this.running;
  }

  /** 当前因满载在排队等待的 run() 数。 */
  get queued(): number {
    return this.waiters.length;
  }

  /** 无限或仍有空位时可立即放行。 */
  private get unlimited(): boolean {
    return this.max <= 0;
  }

  /**
   * 在并发闸内执行 `fn`。满载则排队,有空位按 FIFO 放行;`fn` 无论 resolve/throw
   * 都会释放槽位并唤醒下一个排队者。
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** 拿槽位:有空位立即返回,否则入队等待被唤醒。 */
  private acquire(): Promise<void> {
    if (this.unlimited || this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    // 入队:被唤醒时槽位是「直接交接」过来的(running 不变),故 waiter 不再自增。
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 释放槽位:有排队者则按 FIFO 交接给它(running 不变),否则 running 减 1。 */
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // 槽位交接,running 保持不变
    } else {
      this.running--;
    }
  }
}

/** toolContext 里记录「当前子 agent 递归深度」的键(根为 0,每下一层 +1)。 */
export const SUBAGENT_DEPTH_KEY = '__subagentDepth';

/**
 * 从 toolContext 读取当前递归深度。缺省 / 非数字 → `0`(根层)。
 * @param ctx 工具上下文(任意 record);`undefined` 视为根层。
 */
export function depthOf(ctx: Record<string, unknown> | undefined): number {
  if (!ctx) return 0;
  const v = ctx[SUBAGENT_DEPTH_KEY];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 返回 `ctx` 的浅拷贝,深度 +1 —— 派子 agent 前给子传递的 toolContext 用,
 * 不改父对象(additive)。
 * @param ctx 父工具上下文。
 */
export function withIncrementedDepth<C extends Record<string, unknown>>(ctx: C): C {
  return { ...ctx, [SUBAGENT_DEPTH_KEY]: depthOf(ctx) + 1 };
}

/**
 * 深度护栏:`depth > maxDepth` 抛错(错误信息含上限),防 Task 无限递归。
 * `maxDepth <= 0` 视为**关闭**(永不抛)。
 * @param depth 当前深度(通常来自 `depthOf`)。
 * @param maxDepth 允许的最大深度;`<=0` 关闭护栏。
 */
export function assertDepth(depth: number, maxDepth: number): void {
  if (maxDepth <= 0) return;
  if (depth > maxDepth) {
    throw new Error(
      `subagent depth ${depth} exceeds max depth ${maxDepth} (Task recursion guard)`,
    );
  }
}

/**
 * 把父 token 预算按 `fraction` 切给子。
 * - `parent` 为 `undefined` → `undefined`(父无预算 → 子也不参与预算)。
 * - 默认 `fraction = 0.5`;结果 `floor` 取整。
 * - 父 `total > 0` 时子至少留 `1`(避免切成 0 让子立刻判耗尽)。
 * @param parent 父预算(`{ total }`)或 `undefined`。
 * @param fraction 分摊比例,默认 0.5。
 */
export function splitBudget(
  parent: { total: number } | undefined,
  fraction = 0.5,
): { total: number } | undefined {
  if (!parent) return undefined;
  let child = Math.floor(parent.total * fraction);
  if (parent.total > 0 && child < 1) child = 1;
  return { total: child };
}
