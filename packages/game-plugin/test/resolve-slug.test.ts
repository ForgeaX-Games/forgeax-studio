import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSlug } from '../src/run/run-game';

const roots: string[] = [];

function project(games: readonly string[], active?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-game-slug-'));
  roots.push(root);
  for (const slug of games) mkdirSync(join(root, '.forgeax', 'games', slug), { recursive: true });
  if (active) {
    writeFileSync(
      join(root, '.forgeax', 'active-game.json'),
      `${JSON.stringify({ version: 1, slug: active }, null, 2)}\n`,
    );
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveSlug', () => {
  test('reports an empty project', () => {
    expect(resolveSlug(project([]))).toEqual({
      error: 'error: this project has no games. Run `forgeax-game init --game <slug>` to scaffold one.',
    });
  });

  test('selects requested, active, and sole games in precedence order', () => {
    const root = project(['alpha', 'beta'], 'beta');
    expect(resolveSlug(root, 'alpha')).toMatchObject({ slug: 'alpha' });
    expect(resolveSlug(root)).toMatchObject({ slug: 'beta' });
    expect(resolveSlug(project(['only']))).toMatchObject({ slug: 'only' });
  });

  test('requires a choice for multiple unbound games and rejects missing requests', () => {
    expect(resolveSlug(project(['alpha', 'beta']))).toMatchObject({
      error: expect.stringContaining('no active game selected'),
    });
    expect(resolveSlug(project(['alpha']), 'missing')).toMatchObject({
      error: expect.stringContaining('game "missing" not found'),
    });
  });

  test('recognizes games mounted through directory symlinks', () => {
    const root = project([]);
    const target = join(root, 'external-game');
    mkdirSync(target);
    mkdirSync(join(root, '.forgeax', 'games'), { recursive: true });
    symlinkSync(target, join(root, '.forgeax', 'games', 'linked-game'), 'dir');
    expect(resolveSlug(root)).toMatchObject({ slug: 'linked-game', dir: expect.any(String) });
  });

  test('rejects a game symlink that escapes the project root', () => {
    const root = project([]);
    const target = mkdtempSync(join(tmpdir(), 'forgeax-game-outside-'));
    roots.push(target);
    mkdirSync(join(root, '.forgeax', 'games'), { recursive: true });
    symlinkSync(target, join(root, '.forgeax', 'games', 'outside-game'), 'dir');
    expect(resolveSlug(root)).toMatchObject({
      error: expect.stringContaining('this project has no games'),
    });
  });

  test('rejects traversal and malformed requested slugs', () => {
    const root = project(['demo']);
    expect(resolveSlug(root, '../../outside')).toEqual({
      error: 'error: invalid game slug: "../../outside".',
    });
    expect(resolveSlug(root, 'UPPER')).toEqual({
      error: 'error: invalid game slug: "UPPER".',
    });
  });
});
