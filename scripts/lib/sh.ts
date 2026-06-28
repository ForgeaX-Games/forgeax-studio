// scripts/lib/sh.ts — tiny shared shell helpers for the setup/build scripts.

import { spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

/** True if `cmd` resolves on PATH (cross-platform `command -v`). */
export function has(cmd: string): boolean {
  const probe = IS_WIN ? spawnSync('where', [cmd], { stdio: 'ignore' }) : spawnSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });
  return probe.status === 0;
}

/** Run a command inheriting stdio; return true on exit 0. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN, cwd: opts.cwd, env: opts.env ?? process.env });
  return r.status === 0;
}
