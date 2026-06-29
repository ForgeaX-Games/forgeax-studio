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

/**
 * Resolve a *working* Python interpreter as `[cmd, ...prefixArgs]`, or null.
 * Probes by actually running `--version` — NOT just name-on-PATH — so the
 * Windows Store `python3.exe` App-Execution-Alias stub (exists on PATH but
 * exits non-zero without running Python) is correctly rejected. Order: the
 * `py -3` launcher (Windows-canonical), then `python3`, then `python`.
 */
export function resolvePython(): string[] | null {
  const candidates: string[][] = IS_WIN
    ? [['py', '-3'], ['python3'], ['python']]
    : [['python3'], ['python']];
  for (const [cmd, ...prefix] of candidates) {
    const probe = spawnSync(cmd, [...prefix, '--version'], { stdio: 'pipe', shell: IS_WIN, encoding: 'utf8' });
    if (probe.status === 0 && /Python \d/.test(`${probe.stdout}${probe.stderr}`)) return [cmd, ...prefix];
  }
  return null;
}
