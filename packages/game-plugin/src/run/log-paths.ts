/**
 * Where runtime observation lands on disk.
 *
 * Runtime logs are deliberately not an MCP tool. A tool call is a synchronous request
 * and response, which is a poor fit for a stream that arrives over minutes: the model
 * pays a round trip per poll and cannot grep or tail. Writing to a file instead lets
 * the host CLI use its own file tools, which it is already good at, and keeps the MCP
 * surface small.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RuntimeLogPaths {
  readonly dir: string;
  /** Append-only log the agent reads. */
  readonly logFile: string;
  /** Watcher heartbeat, so "no new logs" can be told apart from "watcher died". */
  readonly stateFile: string;
  /** Atomic lock preventing concurrent cold-start requests. */
  readonly startLockFile: string;
}

export function runtimeLogPaths(root: string): RuntimeLogPaths {
  const dir = join(root, '.forgeax', 'logs', 'runtime');
  return {
    dir,
    logFile: join(dir, 'runtime.log'),
    stateFile: join(dir, 'state.json'),
    startLockFile: join(dir, 'start.lock'),
  };
}

export interface WatcherState {
  /** Slug the watcher was started for. */
  readonly game?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly lastPollAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastWrittenLines?: number;
  readonly consecutiveFailures?: number;
  readonly lastError?: string;
  readonly stoppedAt?: string;
  readonly stopReason?: string;
}

export function readWatcherState(root: string): WatcherState | undefined {
  try {
    return JSON.parse(readFileSync(runtimeLogPaths(root).stateFile, 'utf8')) as WatcherState;
  } catch {
    return undefined;
  }
}

/** Merge a partial update into the heartbeat file. Best-effort; never throws. */
export function updateWatcherState(root: string, patch: WatcherState): void {
  try {
    const paths = runtimeLogPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    const current = readWatcherState(root) ?? {};
    writeFileSync(paths.stateFile, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
  } catch {
    /* heartbeat is diagnostic only */
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StartLock {
  readonly acquired: boolean;
  release(): void;
}

/** Atomically elect one cold-start request; stale locks are reclaimed once. */
export function acquireStartLock(root: string): StartLock {
  const path = runtimeLogPaths(root).startLockFile;
  mkdirSync(runtimeLogPaths(root).dir, { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${token}\n`, { flag: 'wx' });
      return {
        acquired: true,
        release() {
          try {
            if (readFileSync(path, 'utf8').trim() === token) unlinkSync(path);
          } catch {
            /* lock cleanup is best-effort */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = Number.parseInt(readFileSync(path, 'utf8').split(':')[0]!, 10);
        if (Number.isFinite(owner) && processAlive(owner)) {
          return { acquired: false, release() {} };
        }
        unlinkSync(path);
      } catch {
        return { acquired: false, release() {} };
      }
    }
  }
  return { acquired: false, release() {} };
}

export function runtimeLogIsLive(root: string): boolean {
  const state = readWatcherState(root);
  return typeof state?.pid === 'number' && processAlive(state.pid);
}
