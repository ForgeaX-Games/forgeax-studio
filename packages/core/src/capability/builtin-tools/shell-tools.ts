/**
 * Builtin shell tool (②) — `bash`.
 *
 *   - 非只读 + 非并发安全（buildTool 默认 fail-closed）——bash 的只读判定常靠
 *     一整套 readOnlyCommandValidation（git/gh/rg 白名单 + flag 解析），那套逻辑是
 *     host/平台相关的安全策略，**不**进 core ②；core 的 bash 保守为非只读、串行；
 *   - interruptBehavior='cancel'：abort 时取消本次执行（Bash 的
 *     错误/中断会取消兄弟工具，不是 block）。
 *
 * 执行经 host 注入的 `TerminalManager.run`（inject C3 §4.4）。命令字符串经
 * `sh -c <command>` 跑（让 shell 处理管道/重定向/引号）。core 自己不 spawn。
 *
 * Boundary: 仅 import core-local 契约 + node:。
 */
import type { TerminalManager, RunOpts } from '../../inject/types';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type ToolContext } from '../types';
import {
  requireShellRegistry,
  type BackgroundShellStatus,
} from './shell-registry';

// ─── 集成者约定：ctx 上的注入句柄 ────────────────────────────────────────────
//
// 与 file-tools 对称：host 把 inject 的 `TerminalManager` 挂在 ctx.terminal 上。

/** ToolContext 上 host 注入的 shell 句柄。 */
export interface ShellDeps {
  terminal?: TerminalManager;
}

/** 从 ctx 取 TerminalManager；缺失即 host 注入契约被违反 → loud throw。 */
export function requireTerminal(ctx: ToolContext): TerminalManager {
  const term = (ctx as ToolContext & ShellDeps).terminal;
  if (!term) {
    throw new Error(
      'shell-tools: ToolContext.terminal is missing — host must inject TerminalManager (inject C3 §4.4) onto the ToolContext before dispatch.',
    );
  }
  return term;
}

// ─── bash ────────────────────────────────────────────────────────────────────

export interface BashInput {
  command: string;
  /** 可选超时（ms）。 */
  timeout?: number;
  /** 工作目录。 */
  cwd?: string;
  /** 人类可读的命令描述（observability）。 */
  description?: string;
  /** 为 true 时:不阻塞,spawn 后立即返回 shell_id,输出后台累积
   *  （run_in_background）。后台进程经注入的 shellRegistry 起。 */
  run_in_background?: boolean;
}

export interface BashOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** abort 触发的取消。 */
  interrupted: boolean;
  /** run_in_background 时:后台进程标识(其余字段此时无意义)。 */
  shellId?: string;
  /** true = 本次为后台 spawn(立即返回,未阻塞)。 */
  background?: boolean;
}

export function bashTool(): AgentTool<BashInput, BashOutput> {
  return buildTool<BashInput, BashOutput>({
    name: 'bash',
    aliases: ['Bash'],
    searchHint: 'execute shell commands',
    inputJSONSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds',
        },
        cwd: { type: 'string', description: 'Working directory for the command' },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Run the command in the background and return a shell_id immediately; read output later via bash_output and stop it via kill_shell',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    // 30K chars — tool result persistence threshold。
    maxResultSizeChars: 30_000,
    // 非只读 / 非并发安全 → buildTool 默认 fail-closed（不 override）。
    // abort 时取消本次执行（不阻塞）：Bash 错误取消兄弟工具。
    interruptBehavior: () => 'cancel',
    async call(input, ctx): Promise<{ data: BashOutput }> {
      if (typeof input.command !== 'string' || input.command === '') {
        throw new Error('bash: command must be a non-empty string');
      }

      // ── 后台分支:经注入的 shellRegistry 非阻塞 spawn,立即返回 shell_id。 ──
      if (input.run_in_background) {
        const reg = requireShellRegistry(ctx);
        const bgOpts: RunOpts = {};
        if (input.cwd !== undefined) bgOpts.cwd = input.cwd;
        if (input.timeout !== undefined) bgOpts.timeoutMs = input.timeout;
        const shellId = reg.spawnBackground(input.command, bgOpts);
        return {
          data: {
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 0,
            interrupted: false,
            shellId,
            background: true,
          },
        };
      }

      const term = requireTerminal(ctx);
      const opts: RunOpts = { signal: ctx.signal };
      if (input.timeout !== undefined) opts.timeoutMs = input.timeout;
      if (input.cwd !== undefined) opts.cwd = input.cwd;

      try {
        const res = await term.run('sh', ['-c', input.command], opts);
        return {
          data: {
            exitCode: res.exitCode,
            stdout: res.stdout,
            stderr: res.stderr,
            durationMs: res.durationMs,
            interrupted: false,
          },
        };
      } catch (err) {
        // abort → interrupted（取消语义），其余错误向上抛。
        if (ctx.signal.aborted) {
          return {
            data: {
              exitCode: 130,
              stdout: '',
              stderr: errMessage(err),
              durationMs: 0,
              interrupted: true,
            },
          };
        }
        throw err;
      }
    },
    mapResult(output, toolUseId): CoreEvent {
      // 后台 spawn:非错误,携 shellId 供后续 bash_output/kill_shell 引用。
      if (output.background) {
        return {
          type: CoreEventType.ToolCallResult,
          payload: {
            toolUseId,
            isError: false,
            shellId: output.shellId,
            background: true,
          },
          ts: Date.now(),
        };
      }
      const isError = output.interrupted || output.exitCode !== 0;
      return {
        type: CoreEventType.ToolCallResult,
        payload: {
          toolUseId,
          isError,
          exitCode: output.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
          durationMs: output.durationMs,
          interrupted: output.interrupted,
        },
        ts: Date.now(),
      };
    },
    renderToolUseMessage: (input) =>
      (input.run_in_background ? '[bg] ' : '') + (input.description || input.command),
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── bash_output ───────────────────────────────────────────────────────────────

export interface BashOutputInput {
  /** bash(run_in_background) 返回的 shell_id。 */
  shell_id: string;
  /** 可选正则 filter:仅返回匹配该正则的输出行。 */
  filter?: string;
}

export interface BashOutputResult {
  shellId: string;
  status: BackgroundShellStatus;
  exitCode?: number;
  /** 自上次读取以来新增的 stdout(增量;经 filter 过滤后)。 */
  stdout: string;
  stderr: string;
}

/** 按 shell_id 增量读取后台进程的累积输出 + 当前状态。 */
export function bashOutputTool(): AgentTool<BashOutputInput, BashOutputResult> {
  return buildTool<BashOutputInput, BashOutputResult>({
    name: 'bash_output',
    aliases: ['BashOutput'],
    searchHint: 'read incremental output of a background shell',
    inputJSONSchema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'The shell_id returned by bash run_in_background' },
        filter: {
          type: 'string',
          description: 'Optional regex; only lines matching it are returned',
        },
      },
      required: ['shell_id'],
      additionalProperties: false,
    },
    maxResultSizeChars: 30_000,
    // 只读读取累积缓冲;不改文件系统/进程状态 → 只读 + 并发安全。
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx): Promise<{ data: BashOutputResult }> {
      if (typeof input.shell_id !== 'string' || input.shell_id === '') {
        throw new Error('bash_output: shell_id must be a non-empty string');
      }
      const reg = requireShellRegistry(ctx);
      const r = reg.read(input.shell_id, input.filter);
      const data: BashOutputResult = {
        shellId: r.shellId,
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
      };
      if (r.exitCode !== undefined) data.exitCode = r.exitCode;
      return { data };
    },
    mapResult(output, toolUseId): CoreEvent {
      return {
        type: CoreEventType.ToolCallResult,
        payload: {
          toolUseId,
          isError: output.status === 'exited' && (output.exitCode ?? 0) !== 0,
          shellId: output.shellId,
          status: output.status,
          exitCode: output.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
        },
        ts: Date.now(),
      };
    },
    renderToolUseMessage: (input) => `bash_output ${input.shell_id}`,
  });
}

// ─── kill_shell ──────────────────────────────────────────────────────────────

export interface KillShellInput {
  /** 要终止的后台进程 shell_id。 */
  shell_id: string;
}

export interface KillShellResult {
  shellId: string;
  /** 该 shell_id 是否存在(false = 未知 id)。 */
  found: boolean;
}

/** 按 shell_id 终止后台进程。 */
export function killShellTool(): AgentTool<KillShellInput, KillShellResult> {
  return buildTool<KillShellInput, KillShellResult>({
    name: 'kill_shell',
    aliases: ['KillShell', 'KillBash'],
    searchHint: 'terminate a background shell by shell_id',
    inputJSONSchema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'The shell_id of the background process to kill' },
      },
      required: ['shell_id'],
      additionalProperties: false,
    },
    maxResultSizeChars: 4_000,
    // 终止进程 = 有副作用 → 非只读 / 非并发安全(fail-closed,不 override 谓词)。
    async call(input, ctx): Promise<{ data: KillShellResult }> {
      if (typeof input.shell_id !== 'string' || input.shell_id === '') {
        throw new Error('kill_shell: shell_id must be a non-empty string');
      }
      const reg = requireShellRegistry(ctx);
      const found = reg.kill(input.shell_id);
      return { data: { shellId: input.shell_id, found } };
    },
    mapResult(output, toolUseId): CoreEvent {
      return {
        type: CoreEventType.ToolCallResult,
        payload: {
          toolUseId,
          isError: !output.found,
          shellId: output.shellId,
          found: output.found,
        },
        ts: Date.now(),
      };
    },
    renderToolUseMessage: (input) => `kill_shell ${input.shell_id}`,
  });
}
