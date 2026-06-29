// scripts/lib/startlock.ts — atomic start lock (cross-platform).
//
// F3: run.ts has no concurrency guard. Two starts race the TOCTOU window between
// port preflight and the actual vite bind; every vite uses strictPort:true, so
// the loser dies EADDRINUSE with half the stack already up. We use a `mkdir`
// lock — mkdir is atomic / fails if the dir exists on every platform. A stale
// lock whose owner is dead is reclaimed automatically. See perf doc 08 §StartLock.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive } from './proc.ts';

export class StartLock {
  private readonly lockDir: string;
  private held = false;

  constructor(root: string) {
    this.lockDir = join(root, '.forgeax', 'run.lock');
  }

  /** Acquire or throw with a friendly message. Caller folds release() into its cleanup. */
  acquire(): void {
    mkdirSync(join(this.lockDir, '..'), { recursive: true });
    if (!this.tryMkdir()) {
      let pid = 0;
      const pidFile = join(this.lockDir, 'pid');
      if (existsSync(pidFile)) pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10) || 0;

      if (pid && isAlive(pid)) {
        console.error(`  ✗ another run is already starting the stack (pid ${pid}).`);
        console.error('    Refusing to start a second time — that would crash half the stack');
        console.error('    on strictPort EADDRINUSE. Wait for it, or: bun run stop --force');
        process.exit(1);
      }
      // Stale lock — previous holder is gone. Reclaim it.
      console.error(`  · reclaiming stale start lock (holder pid ${pid || '?'} is dead)`);
      rmSync(this.lockDir, { recursive: true, force: true });
      if (!this.tryMkdir()) {
        console.error(`  ✗ could not acquire start lock at ${this.lockDir}`);
        process.exit(1);
      }
    }
    writeFileSync(join(this.lockDir, 'pid'), String(process.pid));
    this.held = true;
  }

  release(): void {
    if (!this.held) return;
    rmSync(this.lockDir, { recursive: true, force: true });
    this.held = false;
  }

  private tryMkdir(): boolean {
    try {
      mkdirSync(this.lockDir); // throws EEXIST if held — the atomicity we rely on
      return true;
    } catch {
      return false;
    }
  }
}
