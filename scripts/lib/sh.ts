// scripts/lib/sh.ts — tiny shared shell helpers for the setup/build scripts.

import { spawnSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

/** True if `cmd` resolves on PATH (cross-platform `command -v`). */
export function has(cmd: string): boolean {
  const probe = IS_WIN
    ? spawnSync('where', [cmd], { stdio: 'ignore', windowsHide: true })
    : spawnSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });
  return probe.status === 0;
}

/** Run a command inheriting stdio; return true on exit 0. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const childEnv = opts.env ?? process.env;
  const trace = childEnv.FORGEAX_COMMAND_TRACE === '1';
  const cwd = opts.cwd ?? process.cwd();
  const started = performance.now();
  if (trace) {
    const secrets = Object.entries(childEnv)
      .filter(([key, value]) => /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key) && (value?.length ?? 0) >= 4)
      .map(([, value]) => value!)
      .sort((a, b) => b.length - a.length);
    const redact = (value: string): string => secrets.reduce(
      (out, secret) => out.replaceAll(secret, '***'),
      value,
    );
    const rendered = [redact(cmd), ...args.map((arg) => JSON.stringify(redact(arg)))].join(' ');
    console.log(`[command:start] cwd=${cwd} command=${rendered}`);
  }
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN, cwd: opts.cwd, env: childEnv, windowsHide: true });
  if (trace) {
    const duration = Math.round(performance.now() - started);
    const outcome = r.status === null
      ? `exit=spawn-error${r.error ? ` error=${JSON.stringify(r.error.message)}` : ''}`
      : `exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}`;
    console.log(`[command:end] ${outcome} duration_ms=${duration} command=${cmd}`);
  }
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
    const probe = spawnSync(cmd, [...prefix, '--version'], { stdio: 'pipe', shell: IS_WIN, encoding: 'utf8', windowsHide: true });
    if (probe.status === 0 && /Python \d/.test(`${probe.stdout}${probe.stderr}`)) return [cmd, ...prefix];
  }
  return null;
}
