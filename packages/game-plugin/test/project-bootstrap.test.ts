import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeGame, ensureLocalProject, initLocalGame, resolveProject } from '../src/project/locate';

describe('package-local project bootstrap', () => {
  test('creates metadata, a minimal game scaffold, and active-game binding offline', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-bootstrap-'));
    try {
      const result = initLocalGame(root, 'hello-world');
      expect(result.projectCreated).toBeTrue();
      expect(resolveProject(root).root).toBe(root);
      expect(existsSync(join(root, '.forgeax', 'project.json'))).toBeTrue();
      expect(existsSync(join(root, '.forgeax', 'games', 'hello-world', 'main.ts'))).toBeTrue();
      expect(JSON.parse(readFileSync(join(root, '.forgeax', 'games', 'hello-world', 'tsconfig.json'), 'utf8'))).toMatchObject({
        extends: '../../engine-sdk/tsconfig.json',
      });
      expect(JSON.parse(readFileSync(join(root, '.forgeax', 'games', 'hello-world', 'forge.json'), 'utf8'))).toMatchObject({
        id: 'hello-world',
        entry: 'main.ts',
      });
      expect(activeGame(root)).toBe('hello-world');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not replace existing instance metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-bootstrap-existing-'));
    try {
      initLocalGame(root, 'first');
      const metadataPath = join(root, '.forgeax', 'project.json');
      const metadata = readFileSync(metadataPath, 'utf8');
      initLocalGame(root, 'second');
      expect(readFileSync(metadataPath, 'utf8')).toBe(metadata);
      expect(activeGame(root)).toBe('second');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('project root resolution', () => {
  test('a bare .forgeax directory is not a project', () => {
    // `~/.forgeax/` is this plugin's own user-level state (runtime cache, sockets) and
    // exists on any machine that has run ForgeaX. Treating it as a project marker made
    // every directory under $HOME resolve its root to $HOME.
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-bare-forgeax-'));
    try {
      mkdirSync(join(fixture, '.forgeax', 'runtimes'), { recursive: true });
      const nested = join(fixture, 'some-project');
      mkdirSync(nested, { recursive: true });
      expect(resolveProject(nested).root).toBeUndefined();

      // Once init has written project metadata, it resolves.
      ensureLocalProject(nested);
      // Compare through realpath: macOS resolves /tmp via a /private symlink.
      expect(realpathSync(resolveProject(nested).root!)).toBe(realpathSync(nested));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('never binds the home directory itself', () => {
    expect(resolveProject(homedir()).root).toBeUndefined();
  });
});
