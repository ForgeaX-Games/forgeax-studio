/** kernel-process 单测:整组 reap 逃兵(R3-07)+ spawn 失败可诊断(R3-12)。 */
import { describe, expect, test } from 'bun:test';
import { createKernelProcess } from '../src/kernel-process';

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('createKernelProcess', () => {
  test('整组 reap:后台逃兵(nohup sleep &)随组被杀(R3-07)', async () => {
    // 子进程起一个后台逃兵,把它的 pid 打到 stdout,然后自己 sleep 占住前台。
    const proc = createKernelProcess({
      command: 'bash',
      // nohup 逃兵留在 bash 的进程组里(不 setsid 脱组)→ 整组杀应连它一起收割。
      args: ['-c', 'nohup sleep 999 >/dev/null 2>&1 & echo "FUGITIVE:$!"; sleep 30'],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
    expect(proc.pid).toBeGreaterThan(0);

    // 抓逃兵 pid
    const fugitivePid = await new Promise<number>((resolve) => {
      const d = proc.onData((c, s) => {
        if (s !== 'stdout') return;
        const m = c.toString().match(/FUGITIVE:(\d+)/);
        if (m) { d.dispose(); resolve(Number(m[1])); }
      });
    });
    expect(pidAlive(fugitivePid)).toBe(true);

    // 整组杀 → 逃兵也应消失
    await proc.terminate(1500);
    // 给内核一点时间收割
    await new Promise((r) => setTimeout(r, 300));
    expect(pidAlive(fugitivePid)).toBe(false);
  }, 15000);

  test('spawn 失败(ENOENT)→ 可诊断 error,非 generic(R3-12)', async () => {
    const proc = createKernelProcess({
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
    const exit = await proc.exited;
    expect(exit.error).toBeTruthy();
    expect(exit.error).toMatch(/ENOENT|spawn/i);
  }, 8000);

  test('正常退出 → exited 带 exitCode,无 error', async () => {
    const proc = createKernelProcess({
      command: 'bash', args: ['-c', 'exit 0'], cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
    const exit = await proc.exited;
    expect(exit.exitCode).toBe(0);
    expect(exit.error).toBeUndefined();
  }, 8000);
});
