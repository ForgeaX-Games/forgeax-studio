/**
 * 后台任务登记处(Task 的 run_in_background)。
 *
 * 一个 `BackgroundTasks` = 一个**进程内**的轻量登记处:`start(label, promise)` 把一个
 * 跑着的子 loop promise 收进来,立即返回一个**单调递增**的 id(不依赖随机/时间——
 * core boundary 禁 Date.now / Math.random 派 id),并在该 promise settle 时(成功或失败)
 * 回调可选的 `onDone(id, result|error)`。
 *
 * 设计取舍:
 *   - **无定时器、无时间戳**:id 由闭包内单调计数器派生(`bg#1` / `bg#2` …),
 *     满足 boundary(只用 core-local + node:,且不碰 Date/timer)。
 *   - **不吞 reject**:挂一个 `.then/.catch` 把结果/错误喂给 `onDone`,但**不**改变
 *     原 promise 的 settle 语义——调用方若另持该 promise,仍能照常 await。
 *   - **零回归**:不提供 `onDone` 时,本类只做登记 + 在 settle 时把任务从 running 集合
 *     里摘除,别无副作用。
 *
 * Boundary: 仅 core 相对 import + node builtins(此文件无任何 import)。
 */

/** 后台任务 settle 时的回调入参:成功携 `result`,失败携 `error`。 */
export interface BackgroundDone<T = unknown> {
  /** 本任务 id(`start` 返回的同一个)。 */
  id: string;
  /** 渲染用短标签(`start` 传入)。 */
  label?: string;
  /** 任务成功时的结果(失败时缺省)。 */
  result?: T;
  /** 任务失败时的错误(成功时缺省)。 */
  error?: unknown;
}

/** 构造 `BackgroundTasks` 的可选项。 */
export interface BackgroundTasksOptions<T = unknown> {
  /**
   * 可选:每个后台任务 settle(成功/失败)时回调。缺省 ⇒ 仅做登记/摘除,无副作用。
   * 回调中抛错会被吞掉(不污染后台任务自身的 settle 语义)。
   */
  onDone?: (done: BackgroundDone<T>) => void;
  /** 可选:id 前缀(默认 `bg`),便于 host 区分多个登记处。 */
  idPrefix?: string;
}

/**
 * 进程内后台任务登记处。
 *
 * - `start(label, promise)`:登记一个跑着的 promise,立即返回单调 id;promise settle
 *   时回调 `onDone` 并把任务从 running 集合摘除。
 * - `running()`:当前仍在跑的任务 id 列表(快照)。
 * - `size`:当前在跑的任务数。
 *
 * **不**等待、**不**取消任何任务——纯登记 + settle 通知。取消由调用方经
 * AbortSignal 自理(子 loop 的 signal 仍来自父 ctx)。
 */
export class BackgroundTasks<T = unknown> {
  private readonly opts: BackgroundTasksOptions<T>;
  /** 单调计数器:派 id 用,绝不回退,不依赖时间/随机(boundary)。 */
  private counter = 0;
  /** 当前仍在跑的任务 id → label。 */
  private readonly inflight = new Map<string, string | undefined>();

  constructor(opts?: BackgroundTasksOptions<T>) {
    this.opts = opts ?? {};
  }

  /**
   * 登记一个后台 promise,立即返回其 id(同步)。
   *
   * promise settle 后:先从 running 集合摘除,再回调 `onDone`(成功/失败各带 result/error)。
   * 不改变原 promise 的 settle 行为——挂的是旁路 `.then`,调用方另持的引用照常 await。
   */
  start(label: string | undefined, promise: Promise<T>): string {
    const id = `${this.opts.idPrefix ?? 'bg'}#${++this.counter}`;
    this.inflight.set(id, label);
    // 旁路监听:吞掉对 onDone 的影响,不动原 promise 语义。
    promise.then(
      (result) => this.settle({ id, label, result }),
      (error) => this.settle({ id, label, error }),
    );
    return id;
  }

  /** settle 收尾:摘除 + 回调 onDone(回调抛错被吞,不外溢)。 */
  private settle(done: BackgroundDone<T>): void {
    this.inflight.delete(done.id);
    if (!this.opts.onDone) return;
    try {
      this.opts.onDone(done);
    } catch {
      // onDone 抛错不影响后台任务自身的 settle 语义(零回归)。
    }
  }

  /** 当前仍在跑的任务 id 快照(顺序为登记序)。 */
  running(): string[] {
    return [...this.inflight.keys()];
  }

  /** 当前在跑的任务数。 */
  get size(): number {
    return this.inflight.size;
  }
}

/** 工厂:等价于 `new BackgroundTasks(opts)`,便于函数式注入。 */
export function createBackgroundTasks<T = unknown>(
  opts?: BackgroundTasksOptions<T>,
): BackgroundTasks<T> {
  return new BackgroundTasks<T>(opts);
}
