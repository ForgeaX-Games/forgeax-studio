import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, 'packages.ts');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('bun fx packages CLI', () => {
  test('syncs a package then records and switches a matching feature branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-packages-cli-'));
    try {
      const remote = join(root, 'remote.git');
      const seed = join(root, 'seed');
      git(root, ['init', '-q', '--bare', remote]);
      git(root, ['init', '-q', seed]);
      git(seed, ['config', 'user.email', 'test@example.com']);
      git(seed, ['config', 'user.name', 'Test']);
      git(seed, ['switch', '-q', '-c', 'main']);
      writeFileSync(join(seed, 'value.txt'), 'one\n');
      git(seed, ['add', '.']);
      git(seed, ['commit', '-qm', 'one']);
      git(seed, ['remote', 'add', 'origin', remote]);
      git(seed, ['push', '-qu', 'origin', 'main']);
      writeFileSync(join(root, '.packages'), JSON.stringify([
        { path: 'packages/sample', url: remote, branch: 'main' },
      ]));

      const sync = spawnSync(process.execPath, [SCRIPT, 'sync'], { cwd: root, encoding: 'utf8' });
      expect(sync.status).toBe(0);
      const branch = spawnSync(process.execPath, [SCRIPT, 'branch', 'feat/cli', '--only', 'sample'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(branch.status).toBe(0);
      expect(git(join(root, 'packages/sample'), ['branch', '--show-current'])).toBe('feat/cli');
      expect(JSON.parse(readFileSync(join(root, '.packages.local'), 'utf8'))).toEqual({
        assign: [{ path: 'packages/sample', url: remote, branch: 'feat/cli' }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
