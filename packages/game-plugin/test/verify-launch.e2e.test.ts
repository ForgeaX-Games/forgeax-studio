import { beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyLaunch } from '../src/install/verify';

const root = resolve(import.meta.dir, '..');
const binary = resolve(root, 'dist', 'main.js');

describe('real self-binary MCP handshake', () => {
  beforeAll(() => {
    execFileSync('bun', ['build.mjs'], { cwd: root, stdio: 'pipe' });
  });

  test('executes dist/main.js through its Node shebang', async () => {
    expect(readFileSync(binary, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
    const result = await verifyLaunch({ command: binary, args: ['mcp'] }, 10_000);
    expect(result.serverName).toBe('forgeax');
    // Derived, not hardcoded: the handshake reports the package version, so pinning a
    // literal here makes every release bump look like a regression.
    const expectedVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
    expect(result.serverVersion).toBe(expectedVersion);
    expect(result.tools).toEqual(
      expect.arrayContaining(['forgeax_status_lite', 'forgeax_run_current_game']),
    );
    expect(result.resources).toContain('forgeax://status');
  });

  test('drains pipelined requests before exiting when stdin closes', () => {
    const input = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }),
      '',
    ].join('\n');
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-game-clean-exit-'));
    const crashLog = join(fixture, 'crash.log');
    try {
      const output = execFileSync(binary, ['mcp'], {
        cwd: root,
        input,
        encoding: 'utf8',
        env: { ...process.env, FORGEAX_GAME_CRASH_LOG: crashLog },
      });
      const responses = output.trim().split('\n').map((line) => JSON.parse(line));
      expect(responses.map((response) => response.id).sort()).toEqual([1, 2]);
      expect(existsSync(crashLog)).toBeFalse();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
