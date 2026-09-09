import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, [BINARY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
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
      expect(result.output).toContain('zcode');
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

  test('init recognizes ZCode config and mounts its native project skill', () => {
    withDir((dir) => {
      const configDir = join(dir, 'home', '.zcode', 'cli');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({
          mcp: {
            servers: {
              forgeax: {
                command: 'npx',
                args: ['-y', '-p', '@forgeax/game', 'forgeax-game', 'mcp'],
              },
            },
          },
        }),
      );

      const result = run(['init', '--game', 'demo', '--ide', 'zcode'], dir);
      expect(result.status).toBe(0);
      expect(result.output).toContain('game development skills for: zcode');
      expect(existsSync(join(dir, '.zcode', 'skills', 'forgeax-game', 'SKILL.md'))).toBeTrue();
      expect(existsSync(join(dir, '.zcode', 'rules'))).toBeFalse();
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('ForgeaX game development');
    });
  });
});
