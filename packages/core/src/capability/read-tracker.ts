/**
 * Same-file read tracker (C7 extra) — 同一文件重复读次数的进程内计数器。
 *
 * `same_file_read_limit`:
 * 模型在长 loop 里反复读同一路径(空转)是常见浪费;LOOP 在执行 read 类工具前用本
 * tracker 累加该 path 的读次数,`over(path, K)` 越线后由 integrator 决定降级
 * (system-reminder 提示「你已读过 N 次」/ 退化为缓存命中),避免烧 maxTurns。
 *
 * 上游在 Read 工具侧记 readFileState、对重复读做提示;本 tracker 是
 * 把「计数」这件纯逻辑从工具实现剥到 core 的一处,工具/loop 共用同一口径。
 *
 * fail-OPEN:tracker 只计数 + 判越线,从不阻断;是否处置由调用方决定(工程只观测)。
 * in-memory、per-instance(一个 run 一个 tracker;无跨进程持久化,Boundary 自然满足)。
 *
 * 纯结构(Map),无 IO、无 import。
 */

/** `same_file_read_limit` 默认 K(对齐 agentic_os 配置默认 20)。 */
export const DEFAULT_SAME_FILE_READ_LIMIT = 20;

export class ReadTracker {
  /** path → 累计读次数。 */
  private readonly counts = new Map<string, number>();

  /** 记一次读,返回该 path 累加后的新次数(便于调用方就地取用)。 */
  record(path: string): number {
    const n = (this.counts.get(path) ?? 0) + 1;
    this.counts.set(path, n);
    return n;
  }

  /** 当前累计读次数(未读过 → 0)。 */
  count(path: string): number {
    return this.counts.get(path) ?? 0;
  }

  /**
   * 是否已越线(累计次数 > limit)。limit 缺省 = DEFAULT_SAME_FILE_READ_LIMIT。
   * 用「>」语义:K=20 时,第 21 次读才算 over(允许恰好读满 K 次)。
   * limit ≤ 0 或非有限 → 永不越线(fail-open,等价关闭该限制)。
   */
  over(path: string, limit: number = DEFAULT_SAME_FILE_READ_LIMIT): boolean {
    if (!Number.isFinite(limit) || limit <= 0) return false;
    return this.count(path) > limit;
  }

  /** 清空(测试 / run 复用时重置)。 */
  reset(): void {
    this.counts.clear();
  }
}
