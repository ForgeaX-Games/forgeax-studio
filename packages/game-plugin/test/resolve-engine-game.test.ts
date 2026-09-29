import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProject } from '../src/project/locate';
import { resolveSlug } from '../src/run/run-game';

const roots: string[] = [];

function game(slug = 'demo'): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-game-resolve-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'forge.json'), `${JSON.stringify({ id: slug, entry: 'src/main.ts' })}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ dependencies: { '@forgeax/engine': 'fixture' } })}\n`);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('released Engine game resolution', () => {
  test('walks upward within one external game and selects its manifest id', () => {
    const root = game('alpha');
    const nested = join(root, 'src', 'systems');
    mkdirSync(nested, { recursive: true });
    expect(resolveProject(nested).root).toBe(root);
    expect(resolveSlug(root)).toEqual({ slug: 'alpha', dir: realpathSync(root) });
  });

  test('rejects a requested id other than this root manifest id', () => {
    const root = game('alpha');
    expect(resolveSlug(root, 'beta')).toEqual({
      error: 'error: game "beta" not found. Available: alpha.',
    });
  });

  test('does not bind an old Studio-style .forgeax/games wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-old-wrapper-'));
    roots.push(root);
    mkdirSync(join(root, '.forgeax', 'games', 'demo'), { recursive: true });
    expect(resolveProject(root).root).toBeUndefined();
  });

  test('rejects traversal and malformed ids before filesystem lookup', () => {
    const root = game();
    expect(resolveSlug(root, '../../outside')).toEqual({ error: 'error: invalid game slug: "../../outside".' });
    expect(resolveSlug(root, 'UPPER')).toEqual({ error: 'error: invalid game slug: "UPPER".' });
  });
});
