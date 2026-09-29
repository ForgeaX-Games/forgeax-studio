import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { branchUsedByWorktreeList, packageGitEnvironment, packageRemoteUrl, syncPackages } from './package-sync.ts';

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
  const hooks = join(root, 'empty-hooks');
  mkdirSync(hooks);
  git(seed, ['config', 'core.hooksPath', hooks]);
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
  test('never treats an ordinary child directory as its parent Git checkout', () => {
    const { root, remote } = fixture();
    git(root, ['init', '-q']);
    const parentRemote = 'https://example.invalid/parent.git';
    git(root, ['remote', 'add', 'origin', parentRemote]);
    const target = join(root, 'packages/sample');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), '{"name":"local-source"}');
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/sample', url: remote, branch: 'main' },
    ]));
    const result = syncPackages({ root, mode: 'ensure' });
    expect(result.exitCode).toBe(1);
    expect(result.results[0]?.detail).toBe('target exists but is not a git checkout');
    expect(git(root, ['remote', 'get-url', 'origin'])).toBe(parentRemote);
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe('{"name":"local-source"}');
  });

  test('clones an empty child directory without reconfiguring its parent repository', () => {
    const { root, remote } = fixture();
    git(root, ['init', '-q']);
    const parentRemote = 'https://example.invalid/parent.git';
    git(root, ['remote', 'add', 'origin', parentRemote]);
    mkdirSync(join(root, 'packages/sample'), { recursive: true });
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/sample', url: remote, branch: 'main' },
    ]));
    const result = syncPackages({ root, mode: 'ensure' });
    expect(result.exitCode).toBe(0);
    expect(result.results[0]?.action).toBe('cloned');
    expect(git(root, ['remote', 'get-url', 'origin'])).toBe(parentRemote);
    expect(git(join(root, 'packages/sample'), ['config', '--get', 'remote.origin.url'])).toBe(remote);
  });

  test('derives package remotes from the parent checkout transport', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-packages-parent-'));
    roots.push(root);
    git(root, ['init', '-q']);
    git(root, ['remote', 'add', 'origin', 'git@github.com:ForgeaX-Games/forgeax-studio.git']);

    expect(packageRemoteUrl(root, 'https://github.com/ForgeaX-Games/forgeax-ide.git'))
      .toBe('git@github.com:ForgeaX-Games/forgeax-ide.git');
    const env = packageGitEnvironment(root, {});
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  test('records the derived SSH origin after cloning a canonical HTTPS package', () => {
    const { root, remote } = fixture();
    git(root, ['init', '-q']);
    git(root, ['remote', 'add', 'origin', 'git@github.com:ForgeaX-Games/forgeax-studio.git']);
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/sample', url: 'https://github.com/ForgeaX-Games/sample.git', branch: 'main' },
    ]));
    const env = {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@github.com:ForgeaX-Games/sample.git',
    };

    expect(syncPackages({ root, mode: 'ensure', env }).exitCode).toBe(0);
    expect(git(join(root, 'packages/sample'), ['config', '--get', 'remote.origin.url']))
      .toBe('git@github.com:ForgeaX-Games/sample.git');
  });

  test('migrates an existing canonical HTTPS checkout to the parent SSH transport', () => {
    const { root, remote } = fixture();
    git(root, ['init', '-q']);
    git(root, ['remote', 'add', 'origin', 'git@github.com:ForgeaX-Games/forgeax-studio.git']);
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/sample', url: 'https://github.com/ForgeaX-Games/sample.git', branch: 'main' },
    ]));
    git(root, ['clone', '-q', remote, 'packages/sample']);

    expect(syncPackages({ root, mode: 'ensure' }).exitCode).toBe(0);
    expect(git(join(root, 'packages/sample'), ['config', '--get', 'remote.origin.url']))
      .toBe('git@github.com:ForgeaX-Games/sample.git');
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

  test('fallback clone reuses an existing default branch', () => {
    const { root, remote } = fixture();
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/sample', url: remote, branch: 'main' },
    ]));
    const bin = join(root, 'bin');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    git(root, ['init', '-q']);
    mkdirSync(bin);
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" clone --quiet --branch main "*) exit 128 ;;\nesac\nexec "${realGit}" "$@"\n`);
    chmodSync(wrapper, 0o755);

    const result = syncPackages({ root, mode: 'ensure', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result).toMatchObject({ exitCode: 0, results: [{ path: 'packages/sample', action: 'cloned' }] });
    expect(git(join(root, 'packages/sample'), ['branch', '--show-current'])).toBe('main');
  });

  test('public installs use the selected snapshot tag and reject a missing tag', () => {
    const { root, seed, remote } = fixture();
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(seed, ['tag', 'v1.0.0-oss.test']);
    git(seed, ['push', '-q', 'origin', 'v1.0.0-oss.test']);
    advance(seed);
    writeFileSync(join(root, '.forgeax-public-distribution'), '');
    writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/pinned', url: remote, branch: 'v1.0.0-oss.test' },
      { path: 'packages/missing', url: remote, branch: 'v1.0.0-oss.missing' },
    ]));
    const result = syncPackages({ root, mode: 'ensure' });
    expect(result.exitCode).toBe(1);
    expect(result.results.map(({ action }) => action), JSON.stringify(result)).toEqual(['cloned', 'failed']);
    expect(readFileSync(join(root, 'packages/pinned/value.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(root, 'packages/missing'))).toBe(false);
  });

  test('public updates follow the next snapshot and reject a deleted tag despite a local branch', () => {
    const { root, seed, remote } = fixture();
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(seed, ['tag', 'v1.0.0-oss.first']);
    git(seed, ['push', '-q', 'origin', 'v1.0.0-oss.first']);
    writeFileSync(join(root, '.forgeax-public-distribution'), '');
    const select = (branch: string) => writeFileSync(join(root, '.packages'), JSON.stringify([
      { path: 'packages/pinned', url: remote, branch },
    ]));
    select('v1.0.0-oss.first');
    const installed = syncPackages({ root, mode: 'ensure' });
    expect(installed.exitCode, JSON.stringify(installed)).toBe(0);
    advance(seed);
    git(seed, ['tag', 'v1.0.0-oss.next']);
    git(seed, ['push', '-q', 'origin', 'v1.0.0-oss.next']);
    select('v1.0.0-oss.next');
    expect(syncPackages({ root, mode: 'update' }).results[0]?.action).toBe('updated');
    const checkout = join(root, 'packages/pinned');
    expect(readFileSync(join(checkout, 'value.txt'), 'utf8')).toBe('two\n');
    expect(git(checkout, ['branch', '--show-current'])).toBe('');
    git(checkout, ['branch', 'v1.0.0-oss.next']);
    git(seed, ['push', '-q', 'origin', ':refs/tags/v1.0.0-oss.next']);
    expect(syncPackages({ root, mode: 'update' })).toMatchObject({
      exitCode: 1, results: [{ action: 'failed' }],
    });
    expect(readFileSync(join(checkout, 'value.txt'), 'utf8')).toBe('two\n');
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
