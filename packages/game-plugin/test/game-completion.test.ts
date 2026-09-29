import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGameAuthoringComplete, ensureAuthoringBaseline } from '../src/project/completion';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-game-completion-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'forge.json'), `${JSON.stringify({ id: 'template-empty', name: 'Empty', entry: 'src/main.ts' })}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@forgeax/template-game-empty' })}\n`);
  writeFileSync(join(root, 'README.md'), '# ForgeaX Empty Game\n');
  writeFileSync(join(root, 'src', 'main.ts'), 'export const empty = true;\n');
  ensureAuthoringBaseline(root);
  return root;
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('game authoring completion', () => {
  test('allows the untouched template to preview', () => {
    const root = fixture();
    expect(() => assertGameAuthoringComplete(root)).not.toThrow();
  });

  test('rejects changed gameplay while Empty template identity remains', () => {
    const root = fixture();
    writeFileSync(join(root, 'src', 'main.ts'), 'export const snake = true;\n');
    expect(() => assertGameAuthoringComplete(root)).toThrow(/game_completion_incomplete.*forge.json id.*README title/);
  });

  test('accepts a coherently finalized game identity', () => {
    const root = fixture();
    mkdirSync(join(root, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.ts'), [
      'export const advanceSnake = (head: number) => head + 1;',
      'export const snake = true;',
      'const host = document.querySelector("#game-ui") ?? document.body;',
      'host.append(document.createElement("canvas"));',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'src', '__tests__', 'snake.test.ts'), [
      'import { advanceSnake } from "../main.js";',
      'import { describe, expect, test } from "vitest";',
      'describe("snake movement", () => {',
      '  test("advances the head", () => expect(advanceSnake(2)).toBe(3));',
      '});',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'forge.json'), `${JSON.stringify({ id: 'snake', name: 'Snake', entry: 'src/main.ts' })}\n`);
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@forgeax/game-snake' })}\n`);
    writeFileSync(join(root, 'README.md'), '# Snake\n\nUse arrow keys.\n');
    expect(() => assertGameAuthoringComplete(root)).not.toThrow();
  });

  test('rejects stale template tests, duplicate README headings, and empty package output', () => {
    const root = fixture();
    mkdirSync(join(root, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.ts'), 'export const snake = true;\n');
    writeFileSync(join(root, 'src', '__tests__', 'starter.test.ts'), 'describe("empty game starter", () => {});\n');
    writeFileSync(join(root, 'forge.json'), `${JSON.stringify({ id: 'snake', name: 'Snake', entry: 'src/main.ts' })}\n`);
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@forgeax/game-snake' })}\n`);
    writeFileSync(join(root, 'README.md'), '# Snake\n# Snake\nrelease/forgeax-empty-game-web.zip\n');
    expect(() => assertGameAuthoringComplete(root)).toThrow(/README package output.*README top-level headings.*template test marker/);
  });

  test('rejects direct body mounting and a gameplay test that only renames the template suite', () => {
    const root = fixture();
    mkdirSync(join(root, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(root, 'src', 'main.ts'), [
      'export default function mount() {',
      '  document.body.append(document.createElement("canvas"));',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'src', '__tests__', 'starter.test.ts'), [
      'import gameplay from "../main.js";',
      'import { expect, test } from "vitest";',
      'test("snake game", () => expect(gameplay).toBeDefined());',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'forge.json'), `${JSON.stringify({ id: 'snake', name: 'Snake', entry: 'src/main.ts' })}\n`);
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: '@forgeax/game-snake' })}\n`);
    writeFileSync(join(root, 'README.md'), '# Snake\n\nUse arrow keys.\n');
    expect(() => assertGameAuthoringComplete(root)).toThrow(
      /Engine Host UI mount.*gameplay behavior tests/,
    );
  });
});
