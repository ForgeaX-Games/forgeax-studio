import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { relative, resolve } from 'node:path';

export type ManagedUpdateRepo = {
  readonly path: string;
  readonly repoType: 'submodule' | 'floating-repo';
};

export type UpdateRepoStash = ManagedUpdateRepo & {
  readonly head: string;
  readonly branch: string;
  readonly stashOid: string;
};

export type UpdateRepoRestoreResult = ManagedUpdateRepo & {
  readonly ok: boolean;
  readonly detail: string;
};

type GitResult = SpawnSyncReturns<string>;

function git(root: string, path: string, args: readonly string[]): GitResult {
  const cwd = resolve(root, path);
  const rel = relative(root, cwd);
  if (rel.startsWith('..') || rel === '') throw new Error(`unsafe managed update repository: ${path}`);
  return spawnSync('git', [...args], { cwd, encoding: 'utf8' });
}

function output(result: GitResult): string {
  return `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() || `git exited ${result.status ?? 1}`;
}

export function parseRecursiveSubmoduleStatusPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    const match = line.match(/^[ +\-U][0-9a-f]{40}\s+(.+?)(?:\s+\(.+\))?$/i);
    if (match?.[1]) paths.push(match[1]);
  }
  return paths;
}

export function restoreCheckoutArgs(branch: string, head: string): string[] {
  return branch ? ['switch', '--quiet', branch] : ['checkout', '--quiet', '--detach', head];
}

export function didCreateUpdateRepoStash(before: string, after: string): boolean {
  return after !== '' && after !== before;
}

export function findStashRefByOid(list: string, stashOid: string): string | undefined {
  for (const line of list.split(/\r?\n/)) {
    const [oid, ref] = line.split('\t');
    if (oid === stashOid && ref) return ref;
  }
  return undefined;
}

/**
 * Stash dirty managed repositories before root/submodule alignment. The caller
 * separately stashes the Studio root after this pass so gitlink changes remain
 * part of the root transaction while nested file edits stay in their owners.
 */
export function stashDirtyUpdateRepos(
  root: string,
  repos: readonly ManagedUpdateRepo[],
  message: string,
  dryRun = false,
): UpdateRepoStash[] {
  const dirty: Array<ManagedUpdateRepo & { head: string; branch: string }> = [];
  for (const repo of repos) {
    const status = git(root, repo.path, ['status', '--porcelain=v2', '--untracked-files=all']);
    if (status.status !== 0) throw new Error(`${repo.path}: status failed: ${output(status)}`);
    const unmerged = git(root, repo.path, ['diff', '--name-only', '--diff-filter=U']);
    if (unmerged.status !== 0) throw new Error(`${repo.path}: unable to inspect conflicts: ${output(unmerged)}`);
    if (unmerged.stdout.trim()) {
      throw new Error(`${repo.path}: unresolved conflicts: ${unmerged.stdout.trim().split(/\r?\n/).join(', ')}`);
    }
    if (!status.stdout.trim()) continue;
    const head = git(root, repo.path, ['rev-parse', 'HEAD']);
    const branch = git(root, repo.path, ['branch', '--show-current']);
    if (head.status !== 0 || branch.status !== 0) {
      throw new Error(`${repo.path}: unable to capture checkout identity`);
    }
    dirty.push({ ...repo, head: head.stdout.trim(), branch: branch.stdout.trim() });
  }

  if (dryRun) return dirty.map((repo) => ({ ...repo, stashOid: 'dry-run' }));

  const stashed: UpdateRepoStash[] = [];
  try {
    // A nested checkout must be made clean before its parent is stashed.
    for (const repo of [...dirty].sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
      const before = git(root, repo.path, ['rev-parse', '--verify', 'refs/stash']);
      const result = git(root, repo.path, ['stash', 'push', '-u', '-m', `${message} (${repo.path})`]);
      if (result.status !== 0) throw new Error(`${repo.path}: stash failed: ${output(result)}`);
      const after = git(root, repo.path, ['rev-parse', '--verify', 'refs/stash']);
      if (!didCreateUpdateRepoStash(
        before.status === 0 ? before.stdout.trim() : '',
        after.status === 0 ? after.stdout.trim() : '',
      )) continue;
      stashed.push({ ...repo, stashOid: after.stdout.trim() });
    }
    return stashed;
  } catch (error) {
    restoreUpdateRepoStashes(root, stashed);
    throw error;
  }
}

export function restoreUpdateRepoStashes(
  root: string,
  stashes: readonly UpdateRepoStash[],
  dryRun = false,
): UpdateRepoRestoreResult[] {
  const results: UpdateRepoRestoreResult[] = [];
  // Restore parents before nested repositories so a parent checkout cannot
  // invalidate a child path after the child's worktree has been restored.
  for (const stash of [...stashes].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    if (dryRun) {
      results.push({ ...stash, ok: true, detail: 'would restore managed-repo stash' });
      continue;
    }
    const checkout = git(root, stash.path, restoreCheckoutArgs(stash.branch, stash.head));
    if (checkout.status !== 0) {
      results.push({ ...stash, ok: false, detail: `checkout restore failed: ${output(checkout)}` });
      continue;
    }
    const applied = git(root, stash.path, ['stash', 'apply', '--index', stash.stashOid]);
    if (applied.status !== 0) {
      results.push({ ...stash, ok: false, detail: `stash restore failed: ${output(applied)}` });
      continue;
    }
    const listed = git(root, stash.path, ['stash', 'list', '--format=%H%x09%gd']);
    if (listed.status !== 0) {
      results.push({ ...stash, ok: false, detail: `changes restored but stash lookup failed: ${output(listed)}` });
      continue;
    }
    const stashRef = findStashRefByOid(listed.stdout, stash.stashOid);
    if (!stashRef) {
      results.push({ ...stash, ok: false, detail: `changes restored but stash ${stash.stashOid} is no longer listed` });
      continue;
    }
    const dropped = git(root, stash.path, ['stash', 'drop', stashRef]);
    results.push({
      ...stash,
      ok: dropped.status === 0,
      detail: dropped.status === 0
        ? 'restored local checkout and changes'
        : `changes restored but stash cleanup failed: ${output(dropped)}`,
    });
  }
  return results;
}
