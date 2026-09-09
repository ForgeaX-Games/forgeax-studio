import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import {
  focusPackagePaths,
  readPackageFiles,
  resolvePackageConfig,
  selectPackageEntries,
  type PackageEntry,
} from './package-manifest.ts';
import {
  hardenedGitEnv,
  NO_CRED_ARGV,
  probeGitHubSsh,
  resolveCredentialConfig,
} from './git-credential.ts';

export type PackageSyncMode = 'ensure' | 'sync' | 'update';
export type PackageSyncAction =
  | 'cloned'
  | 'preserved'
  | 'updated'
  | 'already-current'
  | 'missing-skipped'
  | 'environment-skipped'
  | 'external-preserved'
  | 'refused-dirty'
  | 'planned'
  | 'failed'
  | 'optional-failed';

export type PackageSyncResult = {
  path: string;
  action: PackageSyncAction;
  detail?: string;
};

export type SyncPackagesOptions = {
  root: string;
  mode: PackageSyncMode;
  focus?: boolean;
  selectors?: string[];
  dryRun?: boolean;
  basePath?: string;
  localPath?: string;
  env?: NodeJS.ProcessEnv;
};

type GitResult = SpawnSyncReturns<string>;

const COMMIT = /^[0-9a-f]{7,40}$/i;

function git(root: string, args: string[], env: NodeJS.ProcessEnv = process.env): GitResult {
  return spawnSync('git', [...NO_CRED_ARGV, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: hardenedGitEnv(env),
  });
}

export function packageGitEnvironment(
  _root: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  sshProbe: () => boolean = probeGitHubSsh,
): NodeJS.ProcessEnv {
  // `.packages` keeps portable canonical HTTPS URLs even when Studio itself
  // was cloned over SSH. Resolve credentials for those manifest URLs, not for
  // the unrelated parent transport; otherwise hardened Git disables the
  // credential helper and a private package fetch falls through to a bogus
  // local-branch switch.
  const credential = resolveCredentialConfig(
    'https://github.com/ForgeaX-Games/floating-package.git',
    baseEnv,
    sshProbe,
  );
  return { ...hardenedGitEnv(baseEnv), ...credential.gitConfig };
}

function detail(result: GitResult): string {
  return `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() || `git exited ${result.status ?? 1}`;
}

function isGitCheckout(root: string, path: string): boolean {
  return existsSync(path) && git(root, ['-C', path, 'rev-parse', '--git-dir']).status === 0;
}

function isNonEmpty(path: string): boolean {
  return existsSync(path) && (!lstatSync(path).isDirectory() || readdirSync(path).length > 0);
}

function checkoutPath(root: string, entry: PackageEntry): string {
  const target = resolve(root, entry.path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '') throw new Error(`Unsafe package checkout path: ${entry.path}`);
  return target;
}

function cloneArgs(entry: PackageEntry, target: string): string[] {
  if (entry.sparse?.length) {
    return ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--no-tags', entry.url, target];
  }
  if (COMMIT.test(entry.branch)) {
    return ['clone', '--quiet', '--no-checkout', '--no-tags', entry.url, target];
  }
  return ['clone', '--quiet', '--branch', entry.branch, '--no-tags', entry.url, target];
}

function checkoutClonedEntry(root: string, entry: PackageEntry, target: string, env: NodeJS.ProcessEnv): GitResult | null {
  if (entry.sparse?.length) {
    const init = git(root, ['-C', target, 'sparse-checkout', 'init', '--no-cone']);
    if (init.status !== 0) return init;
    const set = git(root, ['-C', target, 'sparse-checkout', 'set', '--', ...entry.sparse]);
    if (set.status !== 0) return set;
  }
  if (COMMIT.test(entry.branch)) {
    const fetch = git(root, ['-C', target, 'fetch', '--quiet', '--no-tags', entry.url, entry.branch], env);
    if (fetch.status !== 0) return fetch;
    return git(root, ['-C', target, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  }
  if (entry.sparse?.length) return git(root, ['-C', target, 'checkout', '--quiet', entry.branch]);
  return null;
}

function clonePackage(root: string, entry: PackageEntry, target: string, env: NodeJS.ProcessEnv): GitResult | null {
  mkdirSync(dirname(target), { recursive: true });
  let cloned = git(root, cloneArgs(entry, target), env);
  if (cloned.status !== 0 && !COMMIT.test(entry.branch)) {
    rmSync(target, { recursive: true, force: true });
    cloned = git(root, ['clone', '--quiet', '--no-tags', entry.url, target], env);
    if (cloned.status === 0) {
      const branch = git(root, ['-C', target, 'switch', '-q', '-c', entry.branch]);
      if (branch.status !== 0) return branch;
    }
  }
  if (cloned.status !== 0) return cloned;
  return checkoutClonedEntry(root, entry, target, env);
}

function installLinks(root: string, entry: PackageEntry, target: string): string | null {
  for (const [sourcePath, destinationPath] of Object.entries(entry.links ?? {})) {
    const source = resolve(target, sourcePath);
    const destination = resolve(root, destinationPath);
    const destinationRelative = relative(root, destination);
    if (destinationRelative.startsWith('..') || destinationRelative === '') {
      return `unsafe link destination: ${destinationPath}`;
    }
    if (!existsSync(source)) return `link source does not exist: ${entry.path}/${sourcePath}`;
    mkdirSync(dirname(destination), { recursive: true });
    const wanted = relative(dirname(destination), source) || '.';
    if (existsSync(destination) || lstatMaybe(destination)) {
      try {
        if (lstatSync(destination).isSymbolicLink() && readlinkSync(destination) === wanted) continue;
      } catch {
        // The path raced with a local deletion; recreate it below.
      }
      return `link destination already exists: ${destinationPath}`;
    }
    symlinkSync(wanted, destination);
  }
  return null;
}

function lstatMaybe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function updatePackage(root: string, entry: PackageEntry, target: string, env: NodeJS.ProcessEnv): PackageSyncResult {
  const dirty = git(root, ['-C', target, 'status', '--porcelain']);
  if (dirty.status !== 0) return { path: entry.path, action: 'failed', detail: detail(dirty) };
  if (dirty.stdout.trim()) return { path: entry.path, action: 'refused-dirty', detail: 'local changes detected' };

  const before = git(root, ['-C', target, 'rev-parse', 'HEAD']);
  if (before.status !== 0) return { path: entry.path, action: 'failed', detail: detail(before) };
  const fetch = git(root, ['-C', target, 'fetch', '--quiet', '--no-tags', entry.url, entry.branch], env);
  if (fetch.status !== 0) {
    const localBranch = git(root, ['-C', target, 'show-ref', '--verify', '--quiet', `refs/heads/${entry.branch}`]);
    if (!COMMIT.test(entry.branch) && localBranch.status === 0) {
      const switched = git(root, ['-C', target, 'switch', '--quiet', entry.branch]);
      return switched.status === 0
        ? { path: entry.path, action: 'already-current', detail: 'remote branch absent; switched to local branch' }
        : { path: entry.path, action: 'failed', detail: detail(switched) };
    }
    return { path: entry.path, action: 'failed', detail: detail(fetch) };
  }

  let checkout: GitResult;
  let detachedForWorktree = false;
  if (COMMIT.test(entry.branch)) {
    checkout = git(root, ['-C', target, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  } else {
    const localBranch = git(root, ['-C', target, 'show-ref', '--verify', '--quiet', `refs/heads/${entry.branch}`]);
    if (localBranch.status === 0) {
      detachedForWorktree = branchUsedByAnotherWorktree(root, target, entry.branch);
      if (detachedForWorktree) {
        // Keep the sibling worktree and its branch untouched while aligning
        // this dependency checkout exactly to the fetched package revision.
        checkout = git(root, ['-C', target, 'switch', '--quiet', '--detach', 'FETCH_HEAD']);
      } else {
        checkout = git(root, ['-C', target, 'switch', '--quiet', entry.branch]);
      }
      if (checkout.status === 0 && !detachedForWorktree) {
        checkout = git(root, ['-C', target, 'merge', '--quiet', '--ff-only', 'FETCH_HEAD']);
      }
    } else {
      checkout = git(root, ['-C', target, 'switch', '--quiet', '-c', entry.branch, 'FETCH_HEAD']);
    }
  }
  if (checkout.status !== 0) {
    const operation = detachedForWorktree ? 'detach fetched revision' : `switch ${entry.branch}`;
    return { path: entry.path, action: 'failed', detail: `${operation}: ${detail(checkout)}` };
  }
  const after = git(root, ['-C', target, 'rev-parse', 'HEAD']);
  return {
    path: entry.path,
    action: before.stdout.trim() === after.stdout.trim() ? 'already-current' : 'updated',
    detail: after.stdout.trim().slice(0, 8),
  };
}

function branchUsedByAnotherWorktree(root: string, target: string, branch: string): boolean {
  const current = git(root, ['-C', target, 'branch', '--show-current']);
  const listed = git(root, ['-C', target, 'worktree', 'list', '--porcelain']);
  if (listed.status !== 0) return false;
  return branchUsedByWorktreeList(current.stdout.trim(), listed.stdout, branch);
}

export function branchUsedByWorktreeList(currentBranch: string, worktreeList: string, targetBranch: string): boolean {
  if (currentBranch === targetBranch) return false;
  return worktreeList.split(/\r?\n/).includes(`branch refs/heads/${targetBranch}`);
}

function applyMirrors(root: string, entry: PackageEntry, target: string): string | null {
  for (const mirror of entry.mirrors ?? []) {
    const existing = git(root, ['-C', target, 'remote', 'get-url', mirror.name]);
    const remote = existing.status === 0
      ? git(root, ['-C', target, 'remote', 'set-url', mirror.name, mirror.url])
      : git(root, ['-C', target, 'remote', 'add', mirror.name, mirror.url]);
    if (remote.status !== 0) return detail(remote);
  }
  return null;
}

function syncOne(options: SyncPackagesOptions, entry: PackageEntry, gitEnv: NodeJS.ProcessEnv): PackageSyncResult {
  const env = options.env ?? process.env;
  if (entry.skipEnv && env[entry.skipEnv] === '1') {
    return { path: entry.path, action: 'environment-skipped', detail: entry.skipEnv };
  }
  const target = checkoutPath(options.root, entry);
  const existsAsGit = isGitCheckout(options.root, target);
  if (!existsAsGit && isNonEmpty(target)) {
    return entry.optional
      ? { path: entry.path, action: 'external-preserved' }
      : { path: entry.path, action: 'failed', detail: 'target exists but is not a git checkout' };
  }
  if (!existsAsGit && options.mode === 'update') return { path: entry.path, action: 'missing-skipped' };
  if (options.dryRun) return { path: entry.path, action: 'planned', detail: existsAsGit ? options.mode : 'clone' };

  if (!existsAsGit) {
    const clone = clonePackage(options.root, entry, target, gitEnv);
    if (clone && clone.status !== 0) {
      rmSync(target, { recursive: true, force: true });
      return { path: entry.path, action: entry.optional ? 'optional-failed' : 'failed', detail: detail(clone) };
    }
    const mirrorError = applyMirrors(options.root, entry, target);
    const linkError = installLinks(options.root, entry, target);
    if (mirrorError || linkError) {
      return { path: entry.path, action: entry.optional ? 'optional-failed' : 'failed', detail: mirrorError ?? linkError! };
    }
    return { path: entry.path, action: 'cloned' };
  }

  const mirrorError = applyMirrors(options.root, entry, target);
  if (mirrorError) return { path: entry.path, action: entry.optional ? 'optional-failed' : 'failed', detail: mirrorError };
  if (options.mode === 'ensure') {
    const linkError = installLinks(options.root, entry, target);
    return linkError
      ? { path: entry.path, action: entry.optional ? 'optional-failed' : 'failed', detail: linkError }
      : { path: entry.path, action: 'preserved' };
  }
  const result = updatePackage(options.root, entry, target, gitEnv);
  const linkError = result.action === 'failed' || result.action === 'refused-dirty'
    ? null
    : installLinks(options.root, entry, target);
  return linkError ? { path: entry.path, action: entry.optional ? 'optional-failed' : 'failed', detail: linkError } : result;
}

export function syncPackages(options: SyncPackagesOptions): { exitCode: number; results: PackageSyncResult[] } {
  const files = readPackageFiles(options.root, { basePath: options.basePath, localPath: options.localPath });
  let entries = resolvePackageConfig(files.base, files.local);
  entries = selectPackageEntries(entries, options.selectors);
  if (options.focus) {
    const focused = focusPackagePaths(files.local);
    const available = new Set(entries.map((entry) => entry.path));
    const missing = focused.filter((path) => !available.has(path));
    if (missing.length > 0) throw new Error(`Focused package path(s) missing from effective config: ${missing.join(', ')}`);
    entries = entries.filter((entry) => focused.includes(entry.path));
  }
  const gitEnv = packageGitEnvironment(options.root, options.env ?? process.env);
  const results = entries.map((entry) => syncOne(options, entry, gitEnv));
  const failed = results.some((result, index) => {
    const optional = entries[index]?.optional;
    return !optional && (result.action === 'failed' || result.action === 'refused-dirty');
  });
  return { exitCode: failed ? 1 : 0, results };
}
