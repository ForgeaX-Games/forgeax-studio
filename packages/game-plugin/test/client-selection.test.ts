import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `--ide` semantics across the project-side commands.
 *
 * Omitting the flag means "hosts that are actually installed". Naming a host that is not
 * installed must say so rather than silently doing nothing, because mounting skills for a
 * host without an MCP entry hands the model instructions naming tools it cannot call.
 *
 * Driven as a subprocess so each case gets its own working directory: changing this
 * process's cwd would leak into every other test file.
 */
const BINARY = resolve(import.meta.dir, '..', 'dist', 'main.js');

function run(args: readonly string[], cwd: string) {
  const result = spawnSync(process.execPath, [BINARY, ...args], { cwd, encoding: 'utf8' });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-select-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('client selection', () => {
  test('rejects an unknown client id', () => {
    withDir((dir) => {
      const result = run(['init', '--ide', 'nosuchide'], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/unknown client/i);
    });
  });

  test('update refuses when no client is installed', () => {
    withDir((dir) => {
      const result = run(['update'], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no ForgeaX client configuration/i);
    });
  });

  test('update names the uninstalled client it was asked for', () => {
    withDir((dir) => {
      const result = run(['update', '--ide', 'claude'], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/none of the named clients is installed/i);
    });
  });

  test('init accepts --game with --ide and reports the uninstalled host', () => {
    withDir((dir) => {
      const result = run(['init', '--game', 'demo', '--ide', 'claude'], dir);
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/SKIPPED .*not installed yet/);
      // The project is still created; only the host mount is withheld.
      expect(result.output).toMatch(/Created and activated game demo/);
    });
  });
});
