/**
 * KernelProcess(规格 §2.3,T3.1)—— 把内核 spawn 成**独立进程组 leader**,支持整组杀。
 *
 * posix:`spawn({ detached:true })` → 子进程 setsid 成新 pgroup(pgid==pid),其工具子进程
 * (Bash 等)继承同组 → `process.kill(-pid, sig)` 一杀全组(连 `nohup … &` 逃兵)。
 * 同构 `packages/server/src/terminal/manager.ts:436/547` 已验证的整组杀。不接 PTY
 * (内核走 stdout JSONL/stream-json,非 TTY)。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface KernelProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** spawn 失败(ENOENT/cwd 缺)等可诊断错误(R3-12);正常退出为空。 */
  error?: string;
}

export interface KernelProcess {
  readonly pid: number;
  /** 进程组 id(== pid;detached leader)。 */
  readonly pgid: number;
  onData(cb: (chunk: Buffer, stream: 'stdout' | 'stderr') => void): { dispose(): void };
  onExit(cb: (e: KernelProcessExit) => void): { dispose(): void };
  write(data: string | Buffer): void;
  /** 整组发信号(默认 SIGTERM)。 */
  kill(signal?: NodeJS.Signals): void;
  /** SIGTERM → 宽限 graceMs → SIGKILL,整组。返回退出 promise。 */
  terminate(graceMs?: number): Promise<void>;
  readonly exited: Promise<KernelProcessExit>;
}

export interface CreateKernelProcessOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function createKernelProcess(opts: CreateKernelProcessOpts): KernelProcess {
  let child: ChildProcessWithoutNullStreams;
  const dataCbs = new Set<(c: Buffer, s: 'stdout' | 'stderr') => void>();
  const exitCbs = new Set<(e: KernelProcessExit) => void>();
  let settled = false;
  let resolveExited!: (e: KernelProcessExit) => void;
  const exited = new Promise<KernelProcessExit>((r) => { resolveExited = r; });

  const settle = (e: KernelProcessExit) => {
    if (settled) return;
    settled = true;
    resolveExited(e);
    for (const cb of exitCbs) { try { cb(e); } catch { /* ignore */ } }
  };

  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      // posix:新进程组 → 整组可杀(setsid)。windows:无此语义,且 detached=DETACHED_PROCESS
      //   会每次 spawn 新开控制台窗口 → 仅 posix detached,windows 用 windowsHide 抑制窗口。
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch (e) {
    // 同步 spawn 异常(极少;多数 spawn 错误走异步 'error' 事件)。
    const err: KernelProcessExit = { exitCode: -1, signal: null, error: `spawn failed: ${(e as Error).message}` };
    return {
      pid: -1, pgid: -1,
      onData: () => ({ dispose() {} }),
      onExit: (cb) => { cb(err); return { dispose() {} }; },
      write: () => {},
      kill: () => {},
      terminate: async () => {},
      exited: Promise.resolve(err),
    };
  }

  child.stdout.on('data', (c: Buffer) => { for (const cb of dataCbs) { try { cb(c, 'stdout'); } catch { /* ignore */ } } });
  child.stderr.on('data', (c: Buffer) => { for (const cb of dataCbs) { try { cb(c, 'stderr'); } catch { /* ignore */ } } });
  // 异步 spawn 失败(ENOENT / cwd 不存在 / 权限)→ 可诊断(R3-12)。
  child.on('error', (e) => settle({ exitCode: -1, signal: null, error: `${(e as NodeJS.ErrnoException).code ?? 'SPAWN_ERROR'}: ${e.message}` }));
  child.on('exit', (code, signal) => settle({ exitCode: code, signal }));

  const pid = child.pid ?? -1;

  /** 整组发信号:`process.kill(-pid, sig)`;失败回退单进程(组可能已不存在)。 */
  const groupKill = (signal: NodeJS.Signals): void => {
    if (pid <= 0) return;
    try {
      process.kill(-pid, signal); // 负 pid = 整组
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };

  return {
    pid,
    pgid: pid,
    onData(cb) { dataCbs.add(cb); return { dispose: () => dataCbs.delete(cb) }; },
    onExit(cb) {
      if (settled) { void exited.then(cb); return { dispose() {} }; }
      exitCbs.add(cb);
      return { dispose: () => exitCbs.delete(cb) };
    },
    write(data) { try { child.stdin.write(data); } catch { /* closed */ } },
    kill(signal = 'SIGTERM') { groupKill(signal); },
    async terminate(graceMs = 2000) {
      if (settled) return;
      groupKill('SIGTERM');
      const killer = setTimeout(() => groupKill('SIGKILL'), graceMs);
      try { await exited; } finally { clearTimeout(killer); }
    },
    exited,
  };
}
