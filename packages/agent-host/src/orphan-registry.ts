/**
 * orphan-registry —— 硬杀恢复:sidecar 被 SIGKILL(无优雅关停)时,它 detached 出去的内核
 * 进程组会成孤儿存活(macOS 无 PR_SET_PDEATHSIG)。我们把每个活会话的 pgid 落一个标记文件;
 * **下次 sidecar 启动**(单例接管/重启)先 sweep:对仍存活的记录 pgid 整组 SIGKILL,杜绝孤儿堆积。
 *
 * 用「目录 + 每 pgid 一个文件」而非单文件 append/rewrite —— 无并发改写竞态:record=写文件、
 * forget=删文件、sweep=遍历杀+删。优雅退出会 forget 掉,故 sweep 只命中硬杀残留。
 *
 * 已知取舍:boot 时若某记录 pgid 已被无关进程复用,sweep 会误杀该组(同所有 pid-file 回收器
 * 的固有风险)。窗口仅在启动一瞬、概率极低,可接受;真正强隔离留 Linux cgroup/netns。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 记录一个活会话的进程组(pgid 必 > 0)。 */
export function recordOrphan(dir: string, pgid: number, sessionId: string): void {
  if (pgid <= 0) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, String(pgid)), sessionId);
  } catch { /* 注册失败不反噬主流程 */ }
}

/** 会话优雅结束 → 抹掉记录(否则下次 boot 会误 sweep)。 */
export function forgetOrphan(dir: string, pgid: number): void {
  if (pgid <= 0) return;
  try { rmSync(join(dir, String(pgid)), { force: true }); } catch { /* ignore */ }
}

/** 启动期收割上一条命留下的孤儿组。返回收割条数。 */
export function sweepOrphans(dir: string): number {
  let reaped = 0;
  let entries: string[];
  try {
    if (!existsSync(dir)) return 0;
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const pgid = Number(name);
    if (Number.isInteger(pgid) && pgid > 0) {
      try { process.kill(-pgid, 'SIGKILL'); reaped++; } catch { /* 组已不存在 */ }
    }
    try { rmSync(join(dir, name), { force: true }); } catch { /* ignore */ }
  }
  return reaped;
}
