/**
 * TOOLS tests — 后台 bash 三件套(007)。
 *
 * 用一个可控的 stub `BackgroundSpawnFn`(不打真 IO):它把回调句柄存下来,测试
 * 手动喂 stdout/stderr/exit chunk,断言:
 *   - bash(run_in_background) 非阻塞返回 shell_id;
 *   - bash_output 读到增量(读过即清游标)+ filter 正则 + status/exitCode;
 *   - kill_shell 触发 host kill 并把 status 置 killed;
 *   - registry.killAll(cleanup)kill 所有残留并清空。
 * 风格对齐 test/builtin-tools.test.ts。
 */
import { test, expect, describe } from 'bun:test';
import type { Chunk, RunOpts } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import { CoreEventType } from '../src/events/events';
import {
  bashTool,
  bashOutputTool,
  killShellTool,
} from '../src/capability/builtin-tools/shell-tools';
import {
  BackgroundShellRegistry,
  type BackgroundSpawnFn,
  type BackgroundProcess,
} from '../src/capability/builtin-tools/shell-registry';

// ─── 可控 stub spawn ─────────────────────────────────────────────────────────

interface FakeProc extends BackgroundProcess {
  killed: boolean;
  killSignal?: 'SIGTERM' | 'SIGKILL';
  emit(chunk: Chunk): void;
}

/** 建一个 spawn fn + 暴露所有起出的进程(供测试手动喂 chunk / 断言 kill)。 */
function makeStubSpawn() {
  const procs: FakeProc[] = [];
  const calls: Array<{ cmd: string; args: string[]; opts?: RunOpts }> = [];
  const spawn: BackgroundSpawnFn = (cmd, args, opts, onChunk) => {
    calls.push({ cmd, args, opts });
    const proc: FakeProc = {
      killed: false,
      pid: 1000 + procs.length,
      kill(signal) {
        this.killed = true;
        this.killSignal = signal;
      },
      emit(chunk) {
        onChunk(chunk);
      },
    };
    procs.push(proc);
    return proc;
  };
  return { spawn, procs, calls };
}

function ctxWith(extra: Record<string, unknown>, signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, ...extra };
}

// ─── bash run_in_background ──────────────────────────────────────────────────

describe('bash run_in_background', () => {
  test('schema advertises run_in_background', () => {
    const t = bashTool();
    const props = (t.inputJSONSchema as { properties: Record<string, unknown> }).properties;
    expect(props.run_in_background).toBeDefined();
  });

  test('non-blocking: returns shell_id immediately, sh -c <command> spawned', async () => {
    const { spawn, procs, calls } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const t = bashTool();
    const { data } = await t.call(
      { command: 'while true; do echo hi; done', run_in_background: true, cwd: '/work', timeout: 5000 },
      ctxWith({ shellRegistry: reg }),
    );
    expect(data.background).toBe(true);
    expect(typeof data.shellId).toBe('string');
    expect(procs).toHaveLength(1);
    expect(calls[0].cmd).toBe('sh');
    expect(calls[0].args).toEqual(['-c', 'while true; do echo hi; done']);
    expect(calls[0].opts?.cwd).toBe('/work');
    expect(calls[0].opts?.timeoutMs).toBe(5000);
  });

  test('mapResult for background → non-error, carries shellId', async () => {
    const { spawn } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const t = bashTool();
    const { data } = await t.call(
      { command: 'sleep 100', run_in_background: true },
      ctxWith({ shellRegistry: reg }),
    );
    const ev = t.mapResult(data, 'tu_bg');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    const p = ev.payload as Record<string, unknown>;
    expect(p.isError).toBe(false);
    expect(p.background).toBe(true);
    expect(p.shellId).toBe(data.shellId);
  });

  test('throws loud when shellRegistry missing for background bash', async () => {
    const t = bashTool();
    await expect(
      t.call({ command: 'x', run_in_background: true }, ctxWith({})),
    ).rejects.toThrow(/shellRegistry is missing/);
  });

  test('foreground bash unaffected (still uses terminal)', () => {
    // 前台分支不取 shellRegistry —— 缺它也不应 throw（由 requireTerminal 把关）。
    const t = bashTool();
    expect(t.isReadOnly({ command: 'ls' })).toBe(false);
  });
});

// ─── bash_output ─────────────────────────────────────────────────────────────

describe('bash_output', () => {
  test('predicates: read-only + concurrency-safe', () => {
    const t = bashOutputTool();
    expect(t.isReadOnly({ shell_id: 'x' })).toBe(true);
    expect(t.isConcurrencySafe({ shell_id: 'x' })).toBe(true);
  });

  test('reads incremental stdout (cursor advances per read)', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    const out = bashOutputTool();
    const { data: bg } = await bash.call(
      { command: 'echo loop', run_in_background: true },
      ctxWith({ shellRegistry: reg }),
    );
    const shellId = bg.shellId as string;

    procs[0].emit({ stream: 'stdout', data: 'line1\n' });
    const first = await out.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    expect(first.data.stdout).toBe('line1\n');
    expect(first.data.status).toBe('running');

    // 第二次读:只拿新增(游标已前移)。
    procs[0].emit({ stream: 'stdout', data: 'line2\n' });
    const second = await out.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    expect(second.data.stdout).toBe('line2\n');

    // 无新增 → 空。
    const third = await out.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    expect(third.data.stdout).toBe('');
  });

  test('captures stderr separately + exit code flips status to exited', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    const out = bashOutputTool();
    const { data: bg } = await bash.call(
      { command: 'false', run_in_background: true },
      ctxWith({ shellRegistry: reg }),
    );
    const shellId = bg.shellId as string;
    procs[0].emit({ stream: 'stderr', data: 'boom\n' });
    procs[0].emit({ stream: 'exit', data: '3' });
    const r = await out.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    expect(r.data.stderr).toBe('boom\n');
    expect(r.data.status).toBe('exited');
    expect(r.data.exitCode).toBe(3);
    // exited 非零 → mapResult isError true。
    const ev = out.mapResult(r.data, 'tu_o');
    expect((ev.payload as Record<string, unknown>).isError).toBe(true);
  });

  test('filter regex keeps only matching lines', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    const out = bashOutputTool();
    const { data: bg } = await bash.call(
      { command: 'noisy', run_in_background: true },
      ctxWith({ shellRegistry: reg }),
    );
    const shellId = bg.shellId as string;
    procs[0].emit({ stream: 'stdout', data: 'INFO ok\nERROR boom\nINFO fine\nERROR bad\n' });
    const r = await out.call({ shell_id: shellId, filter: 'ERROR' }, ctxWith({ shellRegistry: reg }));
    expect(r.data.stdout).toBe('ERROR boom\nERROR bad');
  });

  test('unknown shell_id throws', async () => {
    const { spawn } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const out = bashOutputTool();
    await expect(
      out.call({ shell_id: 'nope' }, ctxWith({ shellRegistry: reg })),
    ).rejects.toThrow(/unknown shell_id/);
  });

  test('invalid filter regex throws', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    const out = bashOutputTool();
    const { data: bg } = await bash.call(
      { command: 'x', run_in_background: true },
      ctxWith({ shellRegistry: reg }),
    );
    procs[0].emit({ stream: 'stdout', data: 'data\n' });
    await expect(
      out.call({ shell_id: bg.shellId as string, filter: '(' }, ctxWith({ shellRegistry: reg })),
    ).rejects.toThrow(/invalid filter regex/);
  });
});

// ─── kill_shell ──────────────────────────────────────────────────────────────

describe('kill_shell', () => {
  test('predicates: NOT read-only / NOT concurrency-safe (fail-closed)', () => {
    const t = killShellTool();
    expect(t.isReadOnly({ shell_id: 'x' })).toBe(false);
    expect(t.isConcurrencySafe({ shell_id: 'x' })).toBe(false);
  });

  test('kills the running process and flips status to killed', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    const kill = killShellTool();
    const out = bashOutputTool();
    const { data: bg } = await bash.call(
      { command: 'sleep 999', run_in_background: true },
      ctxWith({ shellRegistry: reg }),
    );
    const shellId = bg.shellId as string;
    const { data } = await kill.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    expect(data.found).toBe(true);
    expect(procs[0].killed).toBe(true);
    const r = await out.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    expect(r.data.status).toBe('killed');
  });

  test('unknown shell_id → found:false + isError', async () => {
    const { spawn } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const kill = killShellTool();
    const { data } = await kill.call({ shell_id: 'ghost' }, ctxWith({ shellRegistry: reg }));
    expect(data.found).toBe(false);
    const ev = kill.mapResult(data, 'tu_k');
    expect((ev.payload as Record<string, unknown>).isError).toBe(true);
  });

  test('killed shell ignores a late exit chunk (terminal state stays killed)', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    const kill = killShellTool();
    const out = bashOutputTool();
    const { data: bg } = await bash.call(
      { command: 'x', run_in_background: true },
      ctxWith({ shellRegistry: reg }),
    );
    const shellId = bg.shellId as string;
    await kill.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    procs[0].emit({ stream: 'exit', data: '0' }); // late exit after kill
    const r = await out.call({ shell_id: shellId }, ctxWith({ shellRegistry: reg }));
    expect(r.data.status).toBe('killed');
  });
});

// ─── registry cleanup (assemble disposer) ────────────────────────────────────

describe('BackgroundShellRegistry.killAll (cleanup)', () => {
  test('kills all running procs and clears the registry (no residue)', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    await bash.call({ command: 'a', run_in_background: true }, ctxWith({ shellRegistry: reg }));
    await bash.call({ command: 'b', run_in_background: true }, ctxWith({ shellRegistry: reg }));
    // 一个先自然退出。
    procs[0].emit({ stream: 'exit', data: '0' });

    expect(reg.list()).toHaveLength(2);
    reg.killAll('SIGKILL');

    // 仍 running 的(procs[1])被 kill;已退出的不再 kill。
    expect(procs[1].killed).toBe(true);
    expect(procs[1].killSignal).toBe('SIGKILL');
    expect(procs[0].killed).toBe(false);
    // 注册表清空 → 无残留。
    expect(reg.list()).toHaveLength(0);
  });

  test('chunks arriving after killAll/clear are dropped safely', async () => {
    const { spawn, procs } = makeStubSpawn();
    const reg = new BackgroundShellRegistry(spawn);
    const bash = bashTool();
    await bash.call({ command: 'a', run_in_background: true }, ctxWith({ shellRegistry: reg }));
    reg.killAll();
    // entry 已清,迟到 chunk 不应抛。
    expect(() => procs[0].emit({ stream: 'stdout', data: 'late\n' })).not.toThrow();
  });
});
