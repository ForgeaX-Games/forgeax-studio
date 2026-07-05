// scripts/lib/proc.ts — cross-platform process spawn / teardown / discovery.
//
// Replaces the bash trio lib/process-group.sh + the lsof/netstat port-owner
// discovery scattered across run.sh / stop.sh. The bash version carried a large
// MSYS tax (mapping MSYS pids → WINPIDs, `taskkill //PID` quoting, `ps` column
// parsing) because it ran *inside* Git-Bash. Running natively under Bun/Node on
// Windows, `child.pid` already IS the native Windows pid, so that whole layer
// disappears — the only real platform fork left is "POSIX process-group kill"
// vs "taskkill /T /F", plus "lsof" vs "netstat -ano" for port-owner lookup.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const IS_WIN = process.platform === 'win32';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── pidfile bookkeeping ─────────────────────────────────────────────────────
// .forgeax/run/<name>.pid holds "<pid> <pgid>" on one line. Mirrors the bash
// fx_pg_record/reap so an early crash still leaves an enumerable teardown clue.

export function runDir(root: string): string {
  return join(root, '.forgeax', 'run');
}

/** Record a backgrounded service's pid atomically (write-temp + rename). */
export function recordPid(root: string, name: string, pid: number | undefined): void {
  if (!pid) return;
  const dir = runDir(root);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.pid.${process.pid}`);
  // On POSIX the leader's pgid == pid (each service spawned detached); on Windows
  // there are no process groups, so pid doubles as the group key for taskkill /T.
  writeFileSync(tmp, `${pid} ${pid}\n`);
  renameSync(tmp, join(dir, `${name}.pid`));
}

/** Signal every recorded service's whole tree. `force` → SIGKILL / taskkill /F. */
export function reapPidfiles(root: string, force: boolean): void {
  const dir = runDir(root);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.pid')) continue;
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(join(dir, f), 'utf8').trim().split(/\s+/)[0] ?? '', 10);
    } catch {
      continue;
    }
    if (pid) killTree(pid, force);
  }
}

/** Drop all pidfiles after a confirmed-clean teardown. */
export function clearPidfiles(root: string): void {
  rmSync(runDir(root), { recursive: true, force: true });
}

// ── kill / liveness ─────────────────────────────────────────────────────────

/**
 * Terminate a pid AND its whole child tree, the single kill primitive both
 * run.ts's cleanup and stop.ts route through. Idempotent.
 *
 * - Windows: `taskkill /PID <pid> /T /F` — /T = tree, /F = force. Node/Bun
 *   console apps ignore graceful WM_CLOSE when deadlocked (Vite 6), so force is
 *   the floor, exactly as the bash version concluded.
 * - POSIX: kill the negative pgid (the service is its own group leader via
 *   detached spawn) to reap pnpm → vite / tsx --watch grandchildren, then the
 *   bare pid as fallback.
 */
export function killTree(pid: number, force: boolean): void {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  const sig: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig); // negative = the process group
  } catch {
    // not a group leader / already gone
  }
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

/**
 * Map of pid → parent pid for every live process (one OS call). Windows uses a
 * single CIM query; POSIX shells out to `ps`. Empty map on failure.
 */
function parentMap(): Map<number, number> {
  const map = new Map<number, number>();
  const ingest = (out: string): void => {
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = Number.parseInt(parts[0] ?? '', 10);
      const ppid = Number.parseInt(parts[1] ?? '', 10);
      if (pid > 0 && Number.isFinite(ppid)) map.set(pid, ppid);
    }
  };
  if (IS_WIN) {
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    ingest(r.stdout ?? '');
    return map;
  }
  const r = spawnSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  ingest(r.stdout ?? '');
  return map;
}

/**
 * The pid chain from `pid` (default: this process) up to the OS root, inclusive.
 *
 * stop.ts uses this to never reap the very command that launched it: when
 * `bun fx start app` runs, the parent `app.ts` (and its bun ancestors) carry the
 * repo's absolute path on their command line, so stop's signature scan would
 * otherwise match and SIGKILL them — killing the launcher mid-reap (the stack
 * services it should target are spawned detached as *children*, never ancestors).
 */
export function selfAndAncestors(pid: number = process.pid): Set<number> {
  const chain = new Set<number>();
  const parents = parentMap();
  let cur: number | undefined = pid;
  while (cur && cur > 0 && !chain.has(cur)) {
    chain.add(cur);
    cur = parents.get(cur);
  }
  return chain;
}

/** True if the process is still alive. */
export function isAlive(pid: number): boolean {
  if (!pid) return false;
  if (IS_WIN) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return (r.stdout ?? '').includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── port-owner discovery ────────────────────────────────────────────────────

/** PIDs LISTENing on `port`. POSIX: lsof; Windows: netstat -ano. */
export function listenPids(port: number): number[] {
  if (IS_WIN) {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    if (!r.stdout) return [];
    const pids = new Set<number>();
    for (const line of r.stdout.split('\n')) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? '';
      if (local.endsWith(`:${port}`)) {
        const pid = Number.parseInt(cols[cols.length - 1] ?? '', 10);
        if (pid > 0) pids.add(pid);
      }
    }
    return [...pids];
  }
  // POSIX: lsof -ti gives bare PIDs; exits non-zero when nothing listens.
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (!r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((p) => p > 0);
}

/** True if anything currently LISTENs on `port`. */
export function isPortBusy(port: number): boolean {
  return listenPids(port).length > 0;
}

// ── spawn ───────────────────────────────────────────────────────────────────

export interface SpawnOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Background/detached: child outlives this process (mirrors `nohup … &`). */
  detach?: boolean;
  /** fd to redirect stdout+stderr into (detached background logging). */
  logFd?: number;
}

/**
 * Resolve a bare command name to an absolute executable path so we can spawn
 * WITHOUT shell:true. shell:true on Windows makes child.pid the cmd.exe wrapper
 * (which exits immediately after launching the real exe) — so pidfiles record a
 * dead pid and the cleanup signal never reaches the real service. Resolving the
 * binary ourselves keeps child.pid == the real process.
 *
 * `bun` resolves to process.execPath (this very Bun runtime). Others go through
 * `where`/`which`. On Windows we prefer the .exe/.cmd shim.
 */
function resolveCmd(cmd: string): string {
  if (cmd === 'bun') return process.execPath;
  const probe = IS_WIN
    ? spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true })
    : spawnSync('which', [cmd], { encoding: 'utf8' });
  const matches = (probe.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (IS_WIN) {
    // `where` lists EVERY match, and the npm-global bin dir ships both an
    // extensionless POSIX shim (e.g. ...\npm\pnpm) AND the real Windows shim
    // (...\npm\pnpm.cmd), with the extensionless one first. spawn (no shell:true)
    // can't execute the extensionless file -> ENOENT, so prefer a PATHEXT-style
    // executable (.cmd/.exe/.bat/.com). Bun spawns .cmd directly (verified) so
    // we still avoid shell:true and keep child.pid == the real process.
    const exec = matches.find((m) => /\.(cmd|exe|bat|com)$/i.test(m));
    return exec || matches[0] || cmd;
  }
  return matches[0] || cmd; // fall back to the bare name (spawn will error loudly)
}

/**
 * Spawn a long-lived service. Foreground (default): inherit stdio, own process
 * group on POSIX so killTree can reap the tree. Background (`detach`): fully
 * detached + unref'd so it survives this process on every platform.
 *
 * Never uses shell:true — the command is resolved to an absolute path so
 * child.pid is the real process on every platform (see resolveCmd).
 */
export function spawnService(cmd: string, args: string[], opts: SpawnOpts = {}): ChildProcess {
  const child = spawn(resolveCmd(cmd), args, {
    stdio: opts.detach ? ['ignore', opts.logFd ?? 'ignore', opts.logFd ?? 'ignore'] : 'inherit',
    detached: opts.detach || !IS_WIN, // bg: detach everywhere; fg POSIX: own group
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    windowsHide: true,
  });
  if (opts.detach) child.unref();
  return child;
}

/** Wait until `port` is accepting connections, or false after `timeoutMs`. */
export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const { createConnection } = await import('node:net');
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}
