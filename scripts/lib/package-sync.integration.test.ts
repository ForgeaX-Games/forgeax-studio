import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { branchUsedByWorktreeList, packageGitEnvironment, syncPackages } from './package-sync.ts';

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(): { root: string; seed: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-packages-'));
  roots.push(root);
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  git(root, ['init', '-q', '--bare', remote]);
  git(root, ['init', '-q', seed]);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  git(seed, ['switch', '-q', '-c', 'main']);
  writeFileSync(join(seed, 'value.txt'), 'one\n');
  writeFileSync(join(seed, 'ignored.txt'), 'ignored\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'one']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-qu', 'origin', 'main']);
  return { root, seed, remote };
}

function advance(seed: string): void {
  writeFileSync(join(seed, 'value.txt'), 'two\n');
  git(seed, ['add', 'value.txt']);
  git(seed, ['commit', '-qm', 'two']);
  git(seed, ['push', '-q', 'origin', 'main']);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('.packages checkout sync', () => {
  test('rewrites canonical HTTPS package URLs even when the parent uses SSH', () => {
    const env = packageGitEnvironment('/unused', {}, () => true);
    expect(env.GIT_CONFIG_KEY_0).toBe('url.git@github.com:.insteadOf');
    expect(env.GIT_CONFIG_VALUE_0).toBe('https://github.com/');
  });

  test('ensure clones once, preserves an existing checkout, and update advances it', () => {
    const { root, seed, remote } = fixture();
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/sample', url: remote, branch: 'main' },
    ]));

    expect(syncPackages({ root, mode: 'ensure' }).exitCode).toBe(0);
    expect(readFileSync(join(root, 'packages/sample/value.txt'), 'utf8')).toBe('one\n');

    advance(seed);
    expect(syncPackages({ root, mode: 'ensure' }).results[0]?.action).toBe('preserved');
    expect(readFileSync(join(root, 'packages/sample/value.txt'), 'utf8')).toBe('one\n');

    expect(syncPackages({ root, mode: 'update' }).exitCode).toBe(0);
    expect(readFileSync(join(root, 'packages/sample/value.txt'), 'utf8')).toBe('two\n');
  });

  test('focus updates only paths explicitly named by .packages.local', () => {
    const first = fixture();
    const second = fixture();
    const root = mkdtempSync(join(tmpdir(), 'forgeax-packages-focus-'));
    roots.push(root);
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/first', url: first.remote, branch: 'main' },
      { path: 'packages/second', url: second.remote, branch: 'main' },
    ]));
    writeFileSync(join(root, '.packages.local'), JSON.stringify({
      assign: [{ path: 'packages/first', url: first.remote, branch: 'main' }],
    }));

    expect(syncPackages({ root, mode: 'sync' }).exitCode).toBe(0);
    advance(first.seed);
    advance(second.seed);
    expect(syncPackages({ root, mode: 'update', focus: true }).exitCode).toBe(0);
    expect(readFileSync(join(root, 'packages/first/value.txt'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(root, 'packages/second/value.txt'), 'utf8')).toBe('one\n');
  });

  test('refuses to update a dirty checkout', () => {
    const { root, seed, remote } = fixture();
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/sample', url: remote, branch: 'main' },
    ]));
    syncPackages({ root, mode: 'ensure' });
    advance(seed);
    writeFileSync(join(root, 'packages/sample/local.txt'), 'mine\n');

    const result = syncPackages({ root, mode: 'update' });
    expect(result.exitCode).toBe(1);
    expect(result.results[0]?.action).toBe('refused-dirty');
    expect(readFileSync(join(root, 'packages/sample/value.txt'), 'utf8')).toBe('one\n');
  });

  test('detects a target branch owned by another worktree without path comparisons', () => {
    const list = [
      'worktree /private/var/current',
      'branch refs/heads/feature/local',
      '',
      'worktree /private/var/main',
      'branch refs/heads/main',
      '',
    ].join('\n');
    expect(branchUsedByWorktreeList('feature/local', list, 'main')).toBe(true);
    expect(branchUsedByWorktreeList('main', list, 'main')).toBe(false);
  });

  test('applies sparse checkout and package-to-project links after clone', () => {
    const { root, remote } = fixture();
    const project = mkdtempSync(join(tmpdir(), 'forgeax-packages-sparse-'));
    roots.push(project);
    writeFileSync(join(project, '.packages'), JSON.stringify([
      {
        path: 'packages/sample',
        url: remote,
        branch: 'main',
        sparse: ['value.txt'],
        links: { 'value.txt': '.agents/sample-value.txt' },
      },
    ]));

    expect(syncPackages({ root: project, mode: 'ensure' }).exitCode).toBe(0);
    expect(existsSync(join(project, 'packages/sample/value.txt'))).toBe(true);
    expect(existsSync(join(project, 'packages/sample/ignored.txt'))).toBe(false);
    expect(readFileSync(join(project, '.agents/sample-value.txt'), 'utf8')).toBe('one\n');
  });
});
