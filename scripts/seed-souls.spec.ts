import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function root() {
  const value = mkdtempSync(join(tmpdir(), 'seed-souls-'));
  roots.push(value);
  return value;
}

async function run(games: string, souls: string) {
  return Bun.$`FORGEAX_GAMES_SRC=${games} FORGEAX_SOULS_DST=${souls} bun ${import.meta.dir}/seed-souls.ts`.quiet();
}

describe('seed-souls', () => {
  test('development startup projects Souls and injects the host package root', () => {
    const source = readFileSync(join(import.meta.dir, 'run.ts'), 'utf8');
    expect(source).toContain("join(npcClientRoot, 'build.ts')");
    expect(source).toContain("join(npcClientRoot, 'dist/index.js')");
    expect(source).toContain("join(ROOT, 'scripts/seed-souls.ts')");
    expect(source).toContain('FORGEAX_SOULS_DST: soulsRoot');
    expect(source).toContain('FORGEAX_HOST_PACKAGE_ROOT: ROOT');
  });

  test('projects tracked game Soul packs idempotently', async () => {
    const base = root();
    const games = join(base, 'games');
    const souls = join(base, 'runtime');
    const source = join(games, 'demo', 'souls', 'demo.guide');
    mkdirSync(join(source, 'persona'), { recursive: true });
    writeFileSync(join(source, 'persona/identity.md'), 'Guide');
    await run(games, souls);
    const target = join(souls, 'demo.guide');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(resolve(souls, readlinkSync(target))).toBe(source);
    await run(games, souls);
    expect(existsSync(join(target, 'persona/identity.md'))).toBe(true);
  });

  test('never replaces a user-owned real directory', async () => {
    const base = root();
    const games = join(base, 'games');
    const souls = join(base, 'runtime');
    mkdirSync(join(games, 'demo', 'souls', 'demo.guide'), { recursive: true });
    mkdirSync(join(souls, 'demo.guide'), { recursive: true });
    writeFileSync(join(souls, 'demo.guide', 'USER.md'), 'keep');
    await run(games, souls);
    expect(lstatSync(join(souls, 'demo.guide')).isDirectory()).toBe(true);
    expect(existsSync(join(souls, 'demo.guide', 'USER.md'))).toBe(true);
  });
});
