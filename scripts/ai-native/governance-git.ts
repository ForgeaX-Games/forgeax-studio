import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RUNTIME_PIN_PATH = 'docs/ai-native/pins/m2-2026-07-23.json';
export const BASELINE_APPROVALS_PATH = 'docs/ai-native/baseline/approvals.json';
export const RUNTIME_PROFILE_TERMINALS_PATH = 'docs/ai-native/baseline/runtime-profile-terminals.json';

export const GOVERNANCE_ARTIFACT_PATHS = [
  RUNTIME_PIN_PATH,
  BASELINE_APPROVALS_PATH,
  RUNTIME_PROFILE_TERMINALS_PATH,
] as const;

export interface GitCommandResult {
  ok: boolean;
  stdout: Uint8Array;
  stderr: string;
}

export type GitRunner = (args: readonly string[]) => GitCommandResult;

export interface GovernanceVerification {
  status: 'verified' | 'unverified-diagnostic';
  path: string;
  reasons: string[];
  committed_sha: 'HEAD' | null;
}

function defaultGitRunner(repoRoot: string): GitRunner {
  return (args) => {
    const result = spawnSync('git', [...args], {
      cwd: repoRoot,
      encoding: null,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = typeof result.stdout === 'string'
      ? new TextEncoder().encode(result.stdout)
      : result.stdout ?? new Uint8Array();
    return {
      ok: result.status === 0,
      stdout,
      stderr: Buffer.from(result.stderr ?? new Uint8Array()).toString('utf8').trim(),
    };
  };
}

export function verifyGovernanceArtifact(
  repoRoot: string,
  path: string,
  runner: GitRunner = defaultGitRunner(resolve(repoRoot)),
): GovernanceVerification {
  if (!(GOVERNANCE_ARTIFACT_PATHS as readonly string[]).includes(path)) {
    throw new Error(`unknown governance artifact path: ${path}`);
  }
  const reasons: string[] = [];
  const status = runner(['status', '--porcelain=v1', '--untracked-files=all', '--', path]);
  if (!status.ok) {
    reasons.push(`git-unavailable:${status.stderr || 'status failed'}`);
  } else if (Buffer.from(status.stdout).toString('utf8').trim() !== '') {
    reasons.push('worktree-path-is-dirty-or-untracked');
  }
  const committed = runner(['show', `HEAD:${path}`]);
  if (!committed.ok) {
    reasons.push('no-committed-HEAD-copy');
  } else {
    const live = readFileSync(resolve(repoRoot, path));
    if (!Buffer.from(committed.stdout).equals(live)) reasons.push('working-bytes-differ-from-HEAD');
  }
  return {
    status: reasons.length === 0 ? 'verified' : 'unverified-diagnostic',
    path,
    reasons,
    committed_sha: reasons.length === 0 ? 'HEAD' : null,
  };
}

export function mergeGovernanceVerifications(
  verifications: readonly GovernanceVerification[],
): GovernanceVerification {
  const paths = [...new Set(verifications.flatMap((item) => item.path.split(',')))];
  const reasons = [...new Set(verifications.flatMap((item) => item.reasons.map((reason) => (
    item.path.split(',').some((path) => reason.startsWith(`${path}:`))
      ? reason
      : `${item.path}:${reason}`
  ))))];
  return {
    status: reasons.length === 0 ? 'verified' : 'unverified-diagnostic',
    path: paths.join(','),
    reasons,
    committed_sha: reasons.length === 0 ? 'HEAD' : null,
  };
}

export function assertAppendOnlyBytes(ancestor: Uint8Array, current: Uint8Array): void {
  const ancestorBytes = Buffer.from(ancestor);
  const currentBytes = Buffer.from(current);
  if (currentBytes.length < ancestorBytes.length || !currentBytes.subarray(0, ancestorBytes.length).equals(ancestorBytes)) {
    throw new Error('runtime profile terminal registry rewrites its committed ancestor prefix');
  }
}

export interface AncestorPrefixVerification {
  status: 'verified' | 'unverified-diagnostic';
  ancestor: string | null;
  reasons: string[];
}

export function verifyCommittedAncestorPrefix(
  repoRoot: string,
  path: string,
  runner: GitRunner = defaultGitRunner(resolve(repoRoot)),
): AncestorPrefixVerification {
  const baseCandidate = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : undefined;
  let ancestor: string | null = null;
  if (baseCandidate) {
    const mergeBase = runner(['merge-base', 'HEAD', baseCandidate]);
    if (mergeBase.ok) ancestor = Buffer.from(mergeBase.stdout).toString('utf8').trim();
  }
  if (!ancestor) {
    const mergeBase = runner(['merge-base', 'HEAD', 'origin/main']);
    if (mergeBase.ok) ancestor = Buffer.from(mergeBase.stdout).toString('utf8').trim();
  }
  if (!ancestor) {
    const parent = runner(['rev-parse', 'HEAD^']);
    if (parent.ok) ancestor = Buffer.from(parent.stdout).toString('utf8').trim();
  }
  if (!ancestor) {
    return { status: 'unverified-diagnostic', ancestor: null, reasons: ['no-git-ancestor'] };
  }
  const committedAncestor = runner(['show', `${ancestor}:${path}`]);
  if (!committedAncestor.ok) {
    return {
      status: 'unverified-diagnostic',
      ancestor,
      reasons: ['no-ancestor-copy-genesis'],
    };
  }
  assertAppendOnlyBytes(committedAncestor.stdout, readFileSync(resolve(repoRoot, path)));
  return { status: 'verified', ancestor, reasons: [] };
}
