import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gameFileTools } from '../src/mcp/game-files';
import { initLocalGame } from '../src/project/locate';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-game-files-'));
  roots.push(root);
  const game = initLocalGame(root, 'demo');
  const tools = new Map(gameFileTools<{ cwd: string }>().map((tool) => [tool.name, tool]));
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.run(args, { cwd: root });
  return { root, game, call };
}

describe('remote game authoring tools', () => {
  test('lists, reads, and atomically replaces an active-game file', async () => {
    const { game, call } = fixture();
    const listed = await call('forgeax_game_list_files', {}) as any;
    expect(listed.files.some((file: any) => file.path === 'main.ts')).toBe(true);

    const before = await call('forgeax_game_read_file', { path: 'main.ts' }) as any;
    expect(before.sha256).toMatch(/^[a-f0-9]{64}$/);
    const written = await call('forgeax_game_write_file', {
      path: 'main.ts', content: 'export const changed = true;\n', expected_sha256: before.sha256,
    }) as any;
    expect(written.created).toBe(false);
    expect(readFileSync(join(game.gameRoot, 'main.ts'), 'utf8')).toBe('export const changed = true;\n');
  });

  test('requires optimistic concurrency and rejects path escapes', async () => {
    const { call } = fixture();
    expect(() => call('forgeax_game_write_file', { path: 'main.ts', content: 'unsafe' })).toThrow(
      'expected_sha256 is required',
    );
    expect(() => call('forgeax_game_read_file', { path: '../project.json' })).toThrow('unsafe segment');
    expect(() => call('forgeax_game_write_file', { path: '.env', content: 'secret' })).toThrow(
      'hidden or dependency-owned',
    );
  });

  test('reads only a bounded tail from the project Runtime log', async () => {
    const { root, call } = fixture();
    const logDir = join(root, '.forgeax/runtime');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'stack.log'), 'first\nsecond\nthird\n');

    const result = await call('forgeax_game_read_logs', { lines: 2 }) as any;
    expect(result.available).toBe(true);
    expect(result.content).toBe('second\nthird');
    expect(result.path).toBe('.forgeax/runtime/stack.log');
  });

  test('creates a new nested text file without accepting a stale expectation', async () => {
    const { game, call } = fixture();
    const created = await call('forgeax_game_write_file', {
      path: 'src/player.ts', content: 'export class Player {}\n',
    }) as any;
    expect(created.created).toBe(true);
    expect(readFileSync(join(game.gameRoot, 'src/player.ts'), 'utf8')).toContain('Player');
    expect(() => call('forgeax_game_write_file', {
      path: 'src/other.ts', content: 'x', expected_sha256: '0'.repeat(64),
    })).toThrow('must be omitted');
  });
});
