/**
 * 后台进程注册表(②) —— 后台 bash 三件套(`bash run_in_background` /
 * `bash_output` / `kill_shell`)的共享状态。
 *
 * 设计:core 自己不 spawn。host 经一个**非阻塞 spawn 接缝**(`BackgroundSpawnFn`,
 * inject)起进程并把 stdout/stderr/exit chunk 回调进来;注册表只负责
 * `shell_id → {缓冲输出, status, exitCode}` 的状态管理 + 增量读取游标。
 *
 * 三个工具(bash 的 run_in_background 分支 / bash_output / kill_shell)经 `ToolContext`
 * 上 host 注入的同一个 `BackgroundShellRegistry` 实例共享(对齐 terminal/sandboxFs
 * 经开放 host 能力字段挂载,types.ts:31)。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { Chunk, RunOpts, TaskHandle } from '../../inject/types';

/** host 注入的非阻塞 spawn 接缝。
 *
 * core 调用它起一个后台进程:host 立即返回 `BackgroundProcess` 句柄,并经
 * `onChunk` 把输出/退出事件异步回调进来(stdout/stderr/exit;`exit` 的 `data`
 * 为退出码字符串,对齐 inject 的 `Chunk`)。core 不打真 IO。 */
export type BackgroundSpawnFn = (
  cmd: string,
  args: string[],
  opts: RunOpts | undefined,
  onChunk: (chunk: Chunk) => void,
) => BackgroundProcess;

/** host 起出的后台进程句柄(最小面)。 */
export interface BackgroundProcess {
  /** 进程标识(pid 或 host 内部 id),用于 observability。 */
  readonly pid?: number;
  /** 终止该进程(host 实现;core 仅触发)。 */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export type BackgroundShellStatus = 'running' | 'exited' | 'killed';

/** 单个后台 shell 的运行时记录。 */
export interface BackgroundShellEntry {
  readonly shellId: string;
  readonly command: string;
  readonly startedAt: number;
  status: BackgroundShellStatus;
  /** 进程退出码(running 时为 undefined)。 */
  exitCode?: number;
  /** 累积 stdout(全量;增量游标见 stdoutCursor)。 */
  stdout: string;
  /** 累积 stderr。 */
  stderr: string;
  /** 已被 bash_output 读取过的 stdout 长度(增量游标)。 */
  stdoutCursor: number;
  stderrCursor: number;
  /** host 进程句柄(kill 用)。 */
  readonly proc: BackgroundProcess;
}

/** 一次 bash_output 增量读取结果。 */
export interface BackgroundReadResult {
  shellId: string;
  status: BackgroundShellStatus;
  exitCode?: number;
  /** 自上次读取以来的新增 stdout(经 filter 过滤后)。 */
  stdout: string;
  /** 自上次读取以来的新增 stderr(经 filter 过滤后)。 */
  stderr: string;
}

/**
 * 后台进程注册表。host 注入一个 `BackgroundSpawnFn`,注册表用它起进程并管理状态。
 *
 * 经 `ToolContext` 上的开放 host 能力字段共享给三个工具(约定字段名
 * `shellRegistry`,见 shell-tools.ts)。
 */
export class BackgroundShellRegistry {
  private readonly entries = new Map<string, BackgroundShellEntry>();
  private seq = 0;

  constructor(private readonly spawn: BackgroundSpawnFn) {}

  /** 起一个后台进程,返回 shell_id。输出经 onChunk 异步累积。 */
  spawnBackground(command: string, opts?: RunOpts): string {
    const shellId = `bash_${++this.seq}_${Date.now()}`;
    // 占位 entry(proc 起出后回填);先建以接住可能的同步 chunk。
    const entry: BackgroundShellEntry = {
      shellId,
      command,
      startedAt: Date.now(),
      status: 'running',
      stdout: '',
      stderr: '',
      stdoutCursor: 0,
      stderrCursor: 0,
      // proc 紧接着回填(spawn 同步返回)。
      proc: { kill: () => {} },
    };
    this.entries.set(shellId, entry);

    const proc = this.spawn('sh', ['-c', command], opts, (chunk) => {
      const e = this.entries.get(shellId);
      if (!e) return; // 已被 remove(killed + 清理)
      if (chunk.stream === 'stdout') e.stdout += chunk.data;
      else if (chunk.stream === 'stderr') e.stderr += chunk.data;
      else if (chunk.stream === 'exit') {
        // 仅 running → exited(killed 已是终态,不被 exit 覆盖)。
        if (e.status === 'running') {
          e.status = 'exited';
          const code = Number(chunk.data);
          e.exitCode = Number.isFinite(code) ? code : 0;
        }
      }
    });
    // 回填真句柄(替换占位)。
    (entry as { proc: BackgroundProcess }).proc = proc;
    return shellId;
  }

  /** 增量读取某 shell 的新增输出 + 当前状态;可选 filter(正则,逐行匹配)。 */
  read(shellId: string, filter?: string): BackgroundReadResult {
    const e = this.entries.get(shellId);
    if (!e) throw new Error(`bash_output: unknown shell_id "${shellId}"`);
    const newStdout = e.stdout.slice(e.stdoutCursor);
    const newStderr = e.stderr.slice(e.stderrCursor);
    e.stdoutCursor = e.stdout.length;
    e.stderrCursor = e.stderr.length;
    const result: BackgroundReadResult = {
      shellId,
      status: e.status,
      stdout: applyFilter(newStdout, filter),
      stderr: applyFilter(newStderr, filter),
    };
    if (e.exitCode !== undefined) result.exitCode = e.exitCode;
    return result;
  }

  /** 终止某 shell。返回该 shell 是否存在。 */
  kill(shellId: string, signal?: 'SIGTERM' | 'SIGKILL'): boolean {
    const e = this.entries.get(shellId);
    if (!e) return false;
    if (e.status === 'running') {
      e.proc.kill(signal);
      e.status = 'killed';
    }
    return true;
  }

  /** 当前所有(含已退出未清理的)记录,observability 用。 */
  list(): BackgroundShellEntry[] {
    return [...this.entries.values()];
  }

  /** 退出/abort 时:kill 所有仍 running 的后台进程并清空注册表(防残留)。 */
  killAll(signal?: 'SIGTERM' | 'SIGKILL'): void {
    for (const e of this.entries.values()) {
      if (e.status === 'running') {
        try {
          e.proc.kill(signal);
        } catch {
          // host kill 抛错不阻断其余清理。
        }
        e.status = 'killed';
      }
    }
    this.entries.clear();
  }
}

/** 把文本按行过滤(保留匹配 filter 正则的行);无 filter 原样返回。 */
function applyFilter(text: string, filter?: string): string {
  if (!filter || text === '') return text;
  let re: RegExp;
  try {
    re = new RegExp(filter);
  } catch (err) {
    throw new Error(`bash_output: invalid filter regex — ${err instanceof Error ? err.message : String(err)}`);
  }
  return text
    .split('\n')
    .filter((line) => re.test(line))
    .join('\n');
}

/** ToolContext 上 host 注入的后台注册表句柄(开放字段约定)。 */
export interface BackgroundShellDeps {
  shellRegistry?: BackgroundShellRegistry;
}

/** 从 ctx 取注册表;缺失即 host 注入契约被违反 → loud throw。 */
export function requireShellRegistry(ctx: { [key: string]: unknown }): BackgroundShellRegistry {
  const reg = (ctx as BackgroundShellDeps).shellRegistry;
  if (!reg) {
    throw new Error(
      'shell-registry: ToolContext.shellRegistry is missing — host must inject a BackgroundShellRegistry onto the ToolContext before dispatch (background bash trio).',
    );
  }
  return reg;
}

/** TaskHandle 重导出(host 注入实现可复用 inject 的句柄形状)。 */
export type { TaskHandle };
