/**
 * CLI reference host — concrete node IO impls of the inject interfaces (C3).
 *
 * 这是 forgeax-core 的「最小自带 host」:给 CLI 形态提供真实 SandboxFs(node:fs)+
 * TerminalManager(node:child_process)。**依赖方向 cli→core**,core/src 的机制层仍只
 * 用 inject 接口,不依赖本文件(干净律不破)。node: 内置在 boundary allow 列。
 * 运行时 + CLI + 真实 IO 同包。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  statSync,
  readdirSync,
  createReadStream,
  createWriteStream,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import type { SandboxFs, DirEnt, StatResult, TerminalManager, RunOpts, RunResult, Chunk, TaskHandle } from '../inject/types';
import type { BackgroundSpawnFn } from '../capability/builtin-tools/shell-registry';

export class NodeSandboxFs implements SandboxFs {
  readTextSync(p: string): string {
    return readFileSync(p, 'utf8');
  }
  writeTextSync(p: string, c: string): void {
    writeFileSync(p, c, 'utf8');
  }
  mkdirSync(p: string, opts?: { recursive?: boolean }): void {
    mkdirSync(p, { recursive: opts?.recursive ?? false });
  }
  existsSync(p: string): boolean {
    return existsSync(p);
  }
  unlinkSync(p: string): void {
    unlinkSync(p);
  }
  renameSync(from: string, to: string): void {
    renameSync(from, to);
  }
  statSync(p: string): StatResult {
    const s = statSync(p);
    return { isFile: s.isFile(), isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
  }
  readdirSync(p: string, opts?: { withFileTypes?: boolean }): string[] | DirEnt[] {
    if (opts?.withFileTypes) {
      return readdirSync(p, { withFileTypes: true }).map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDir: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
      }));
    }
    return readdirSync(p);
  }
  async readText(p: string): Promise<string> {
    return readFile(p, 'utf8');
  }
  async writeText(p: string, c: string): Promise<void> {
    await writeFile(p, c, 'utf8');
  }
  async readBytes(p: string, offset?: number, limit?: number): Promise<Uint8Array> {
    const buf = await readFile(p);
    if (offset == null && limit == null) return new Uint8Array(buf);
    const start = offset ?? 0;
    return new Uint8Array(buf.subarray(start, limit != null ? start + limit : undefined));
  }
  async writeBytes(p: string, data: Uint8Array): Promise<void> {
    await writeFile(p, data);
  }
  readStream(p: string): ReadableStream<Uint8Array> {
    // node Readable → Web ReadableStream(Node 17+ / bun)。
    return Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
  }
  writeStream(p: string): WritableStream<Uint8Array> {
    return Writable.toWeb(createWriteStream(p)) as WritableStream<Uint8Array>;
  }
}

export class NodeTerminal implements TerminalManager {
  async run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult> {
    const started = Date.now();
    return await new Promise<RunResult>((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        signal: opts?.signal,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      if (opts?.stdin) child.stdin?.end(opts.stdin);
      child.on('error', (err) => {
        resolve({ exitCode: 1, stdout, stderr: stderr + String(err), durationMs: Date.now() - started });
      });
      child.on('close', (code) => {
        resolve({ exitCode: code ?? 0, stdout, stderr, durationMs: Date.now() - started });
      });
    });
  }
  /** 实时流式:边跑边吐 stdout/stderr chunk,结束吐一条 exit。 */
  async *stream(cmd: string, args: string[], opts?: RunOpts): AsyncIterable<Chunk> {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      signal: opts?.signal,
    });
    if (opts?.stdin) child.stdin?.end(opts.stdin);
    const queue: Chunk[] = [];
    let resolveNext: (() => void) | null = null;
    let ended = false;
    const push = (c: Chunk) => {
      queue.push(c);
      resolveNext?.();
      resolveNext = null;
    };
    child.stdout?.on('data', (d) => push({ stream: 'stdout', data: d.toString() }));
    child.stderr?.on('data', (d) => push({ stream: 'stderr', data: d.toString() }));
    child.on('error', (err) => {
      push({ stream: 'stderr', data: String(err) });
      push({ stream: 'exit', data: '1' });
      ended = true;
      resolveNext?.();
    });
    child.on('close', (code) => {
      push({ stream: 'exit', data: String(code ?? 0) });
      ended = true;
      resolveNext?.();
    });
    while (true) {
      if (queue.length > 0) {
        const c = queue.shift()!;
        yield c;
        if (c.stream === 'exit') return;
        continue;
      }
      if (ended) return;
      await new Promise<void>((r) => (resolveNext = r));
    }
  }

  // ── 后台任务(tracked)──────────────────────────────────────────────────────
  private readonly tasks = new Map<string, { handle: TaskHandle; child: ChildProcess }>();
  private seq = 0;

  async runBackground(cmd: string, args: string[], opts?: RunOpts): Promise<TaskHandle> {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      detached: false,
    });
    if (opts?.stdin) child.stdin?.end(opts.stdin);
    const id = `task-${++this.seq}-${Date.now()}`;
    const handle: TaskHandle = {
      id,
      agentId: 'cli',
      cmd: [cmd, ...args].join(' '),
      startedAt: Date.now(),
      pid: child.pid,
    };
    this.tasks.set(id, { handle, child });
    child.on('close', () => this.tasks.delete(id));
    child.on('error', () => this.tasks.delete(id));
    return handle;
  }
  list(agentId: string): TaskHandle[] {
    return [...this.tasks.values()].filter((t) => t.handle.agentId === agentId).map((t) => t.handle);
  }
  async kill(taskId: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    const t = this.tasks.get(taskId);
    if (t) {
      t.child.kill(signal);
      this.tasks.delete(taskId);
    }
  }
  async killAll(agentId: string): Promise<void> {
    for (const [id, t] of this.tasks) {
      if (t.handle.agentId === agentId) {
        t.child.kill('SIGTERM');
        this.tasks.delete(id);
      }
    }
  }
}

/**
 * 007 后台 bash 三件套的 host IO 接缝:返回一个 `BackgroundSpawnFn`。
 *
 * core 的 `BackgroundShellRegistry` 经它非阻塞起进程,host 把 stdout/stderr/exit
 * 经 `onChunk` 回调进去(core 不打真 IO,只攒缓冲)。返回 `BackgroundProcess`(kill)。
 */
export function makeNodeBackgroundSpawn(): BackgroundSpawnFn {
  return (cmd, args, opts, onChunk) => {
    const child: ChildProcess = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      detached: false,
    });
    if (opts?.stdin) child.stdin?.end(opts.stdin);
    child.stdout?.on('data', (d: Buffer) => onChunk({ stream: 'stdout', data: d.toString() }));
    child.stderr?.on('data', (d: Buffer) => onChunk({ stream: 'stderr', data: d.toString() }));
    child.on('error', (err) => {
      onChunk({ stream: 'stderr', data: String(err) });
      onChunk({ stream: 'exit', data: '1' });
    });
    child.on('close', (code) => onChunk({ stream: 'exit', data: String(code ?? 0) }));
    // 可选超时:到点 SIGTERM(对齐前台 run 的 timeoutMs 语义)。
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
      child.on('close', () => clearTimeout(timer));
    }
    return {
      pid: child.pid,
      kill: (signal?: 'SIGTERM' | 'SIGKILL') => {
        child.kill(signal ?? 'SIGTERM');
      },
    };
  };
}
