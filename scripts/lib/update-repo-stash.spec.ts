import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  didCreateUpdateRepoStash,
  findStashRefByOid,
  parseRecursiveSubmoduleStatusPaths,
  restoreUpdateRepoStashes,
  restoreCheckoutArgs,
  stashDirtyUpdateRepos,
} from './update-repo-stash.ts';

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('managed repository update stashes', () => {
  test('parses initialized recursive submodule paths', () => {
    expect(parseRecursiveSubmoduleStatusPaths([
      ' 0123456789012345678901234567890123456789 packages/one (heads/main)',
      '-abcdefabcdefabcdefabcdefabcdefabcdefabcd packages/two',
      '+1111111111111111111111111111111111111111 packages/three (remotes/origin/main)',
    ].join('\n'))).toEqual(['packages/one', 'packages/two', 'packages/three']);
  });

  test('selects branch or detached checkout restoration', () => {
    expect(restoreCheckoutArgs('main', 'abc')).toEqual(['switch', '--quiet', 'main']);
    expect(restoreCheckoutArgs('', 'abc')).toEqual(['checkout', '--quiet', '--detach', 'abc']);
  });

  test('never restores a pre-existing stash when no new stash was created', () => {
    expect(didCreateUpdateRepoStash('', 'new')).toBe(true);
    expect(didCreateUpdateRepoStash('old', 'new')).toBe(true);
    expect(didCreateUpdateRepoStash('old', 'old')).toBe(false);
    expect(didCreateUpdateRepoStash('old', '')).toBe(false);
  });

  test('finds the exact managed stash after a newer stash is inserted', () => {
    expect(findStashRefByOid([
      'newer\tstash@{0}',
      'managed\tstash@{1}',
      'older\tstash@{2}',
    ].join('\n'), 'managed')).toBe('stash@{1}');
    expect(findStashRefByOid('newer\tstash@{0}', 'managed')).toBeUndefined();
  });

  test('restores the exact managed stash and preserves a newer stash', () => {
    const root = mkdtempSync(join(tmpdir(), 'fx-update-stash-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    try {
      runGit(repo, 'init', '-q');
      runGit(repo, 'config', 'user.email', 'fx-update-test@forgeax.local');
      runGit(repo, 'config', 'user.name', 'fx update test');
      writeFileSync(join(repo, 'managed.txt'), 'base\n');
      runGit(repo, 'add', 'managed.txt');
      runGit(repo, 'commit', '-qm', 'base');

      writeFileSync(join(repo, 'managed.txt'), 'managed change\n');
      const moduleUrl = new URL('./update-repo-stash.ts', import.meta.url).href;
      const resultPath = join(root, 'result.json');
      const stashScript = [
        `import { stashDirtyUpdateRepos } from ${JSON.stringify(moduleUrl)};`,
        'import { writeFileSync } from "node:fs";',
        'const [stash] = stashDirtyUpdateRepos(process.argv[1], [{ path: "repo", repoType: "floating-repo" }], "test");',
        'writeFileSync(process.argv[2], JSON.stringify(stash));',
      ].join('\n');
      execFileSync(process.execPath, ['-e', stashScript, root, resultPath]);
      const managed = JSON.parse(readFileSync(resultPath, 'utf8'));
      expect(managed?.stashOid).toBeTruthy();

      writeFileSync(join(repo, 'newer.txt'), 'newer stash\n');
      runGit(repo, 'stash', 'push', '-u', '-m', 'newer unrelated stash');
      const inspectScript = [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], execFileSync("git", ["rev-parse", "refs/stash"], { cwd: process.argv[1], encoding: "utf8" }).trim());',
      ].join('\n');
      execFileSync(process.execPath, ['-e', inspectScript, repo, resultPath]);
      const newerOid = readFileSync(resultPath, 'utf8');

      const restoreScript = [
        `import { restoreUpdateRepoStashes } from ${JSON.stringify(moduleUrl)};`,
        'import { writeFileSync } from "node:fs";',
        'const results = restoreUpdateRepoStashes(process.argv[1], [JSON.parse(process.argv[2])]);',
        'writeFileSync(process.argv[3], JSON.stringify(results));',
      ].join('\n');
      execFileSync(process.execPath, ['-e', restoreScript, root, JSON.stringify(managed), resultPath]);
      const restored = JSON.parse(readFileSync(resultPath, 'utf8'));
      expect(restored).toEqual([
        expect.objectContaining({ ok: true }),
      ]);
      expect(readFileSync(join(repo, 'managed.txt'), 'utf8')).toBe('managed change\n');
      execFileSync(process.execPath, ['-e', inspectScript, repo, resultPath]);
      expect(readFileSync(resultPath, 'utf8')).toBe(newerOid);
      expect(newerOid).not.toBe(managed!.stashOid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when repository status cannot be inspected', () => {
    const root = mkdtempSync(join(tmpdir(), 'fx-update-stash-status-'));
    try {
      expect(() => stashDirtyUpdateRepos(root, [
        { path: 'missing', repoType: 'floating-repo' },
      ], 'test')).toThrow('missing: status failed:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
