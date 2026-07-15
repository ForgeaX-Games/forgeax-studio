// scripts/lib/repos.ts — one multi-repo scan (SSOT) + pure planning helpers.
//
// Consumers: scripts/repos.ts (`bun fx sync|check|commit|bump|versions` and
// `bun fx status --repos`). The repo state is scanned ONCE into RepoInfo[];
// every command is a thin shell over that array, so "what state is repo X in"
// has exactly one implementation.
//
// Root repo uses path '' ; submodules use root-relative paths, nested ones
// included (e.g. packages/editor/packages/engine). Floating clones that are
// not in .gitmodules (packages/engine, packages/kernel at root) are NOT
// scanned — they belong to parallel tracks, not to this repo's combination.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RepoInfo = {
  /** Root-relative path; '' = the root repo itself. */
  path: string;
  absPath: string;
  /** Root-relative path of the parent repo; null for root. */
  parent: string | null;
  /** Current branch name, or 'DETACHED'. */
  branch: string;
  /** Full HEAD sha. */
  head: string;
  /** Upstream ref name ('' when the branch has no upstream). */
  upstream: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  /** Gitlink sha recorded by the parent repo ('' for root). */
  pin: string;
};

export function gitOut(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Parse `git config --file .gitmodules --get-regexp path` output. */
export function parseSubmodulePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
}

export function parseLeftRight(output: string): { ahead: number; behind: number } {
  const [ahead = 0, behind = 0] = output.split(/\s+/).map((n) => Number(n) || 0);
  return { ahead, behind };
}

function submodulePathsOf(repoAbs: string): string[] {
  if (!existsSync(join(repoAbs, '.gitmodules'))) return [];
  return parseSubmodulePaths(gitOut(repoAbs, ['config', '--file', '.gitmodules', '--get-regexp', 'path']));
}

function inspectRepo(absPath: string, path: string, parent: string | null, pin: string): RepoInfo {
  const rawBranch = gitOut(absPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = rawBranch === 'HEAD' ? 'DETACHED' : rawBranch || '?';
  const upstream = gitOut(absPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const counts = upstream ? parseLeftRight(gitOut(absPath, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])) : { ahead: 0, behind: 0 };
  return {
    path,
    absPath,
    parent,
    branch,
    head: gitOut(absPath, ['rev-parse', 'HEAD']),
    upstream,
    ahead: counts.ahead,
    behind: counts.behind,
    dirty: gitOut(absPath, ['status', '--porcelain']) !== '',
    pin,
  };
}

/** Scan root + all initialized submodules (recursive). Root first, then DFS order. */
export function scanRepos(rootAbs: string): RepoInfo[] {
  const repos: RepoInfo[] = [];
  const walk = (repoAbs: string, repoRel: string, parent: string | null, pin: string): void => {
    repos.push(inspectRepo(repoAbs, repoRel, parent, pin));
    for (const sub of submodulePathsOf(repoAbs)) {
      const abs = join(repoAbs, sub);
      if (!existsSync(join(abs, '.git'))) continue; // not initialized — skip
      const childPin = gitOut(repoAbs, ['rev-parse', `:${sub}`]);
      walk(abs, repoRel ? `${repoRel}/${sub}` : sub, repoRel, childPin);
    }
  };
  walk(rootAbs, '', null, '');
  return repos;
}

/** Leaf-first commit order: deepest submodules first, root ('' → depth 0) last. */
export function orderLeafFirst(repos: RepoInfo[]): RepoInfo[] {
  const depth = (p: string): number => (p === '' ? 0 : p.split('/').length);
  return [...repos].sort((a, b) => depth(b.path) - depth(a.path));
}

/** Gate script names, in run order, for submodule / workspace packages. */
export const GATE_ORDER = ['lint', 'lint:dep', 'lint:agnostic', 'test'] as const;
/** Gate script names for the root repo. */
export const ROOT_GATE_ORDER = [
  'lint:layers',
  'lint:boundaries',
  'test:layers',
  'test:boundaries',
] as const;

/** Pick the gates a repo actually defines, preserving run order. */
export function pickGates(scripts: Record<string, string> | undefined, order: readonly string[]): string[] {
  return order.filter((name) => Boolean(scripts?.[name]));
}

export function gatesForRepo(repo: RepoInfo): string[] {
  const pkgPath = join(repo.absPath, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let scripts: Record<string, string> | undefined;
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts;
  } catch {
    return [];
  }
  return pickGates(scripts, repo.path === '' ? ROOT_GATE_ORDER : GATE_ORDER);
}

// ── commit planning (pure, unit-tested) ──────────────────────────────────────

export type CommitStep = {
  path: string;
  branch: string;
  /** Child submodule pins this commit records; each sha must exist on the child's remote first. */
  pinChecks: Array<{ child: string; sha: string }>;
  push: 'yes' | 'no' | 'refused-main';
};

export type CommitPlan = {
  violations: string[];
  steps: CommitStep[];
};

/**
 * Plan a multi-repo commit: dirty repos leaf-first, detached HEADs are hard
 * violations, pushes to main are refused (main is PR-only), and every parent
 * commit lists the child pins it would record (dangling-pin guard: those shas
 * must be on the child's remote before the parent may commit).
 */
export function planCommit(repos: RepoInfo[], opts: { push: boolean }): CommitPlan {
  const violations: string[] = [];
  const byPath = new Map(repos.map((r) => [r.path, r]));
  const dirty = orderLeafFirst(repos.filter((r) => r.dirty));

  const steps: CommitStep[] = [];
  for (const repo of dirty) {
    if (repo.branch === 'DETACHED') {
      violations.push(`${repo.path || '(root)'}: detached HEAD — create/switch to a branch before committing`);
      continue;
    }
    const pinChecks = repos
      .filter((child) => child.parent === repo.path && child.pin !== child.head)
      .map((child) => ({ child: child.path, sha: child.head }));
    const push: CommitStep['push'] = !opts.push ? 'no' : repo.branch === 'main' ? 'refused-main' : 'yes';
    steps.push({ path: repo.path, branch: repo.branch, pinChecks, push });
  }

  // A dirty child that never gets pushed leaves its parent's new pin dangling.
  for (const step of steps) {
    for (const check of step.pinChecks) {
      const child = byPath.get(check.child);
      const childStep = steps.find((s) => s.path === check.child);
      if (childStep && childStep.push === 'refused-main') {
        violations.push(
          `${step.path || '(root)'}: would pin ${check.child}@${check.sha.slice(0, 7)}, but that commit lands on ${child?.branch ?? '?'} which cannot be pushed directly (main is PR-only)`,
        );
      }
    }
  }

  return { violations, steps };
}

/** True when `sha` is reachable from some remote-tracking ref of the repo. */
export function remoteContains(repoAbs: string, sha: string): boolean {
  return gitOut(repoAbs, ['branch', '-r', '--contains', sha]) !== '';
}

// ── rendering ────────────────────────────────────────────────────────────────

export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => (row[i] ?? '').length)));
  const fmt = (row: string[]): string => row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function describeRepo(repo: RepoInfo): string {
  return gitOut(repo.absPath, ['describe', '--tags', '--always']) || '?';
}

// ── tag nudge (ADR 0022, Plan C trigger = version-field driven) ─────────────

/** Commits past the last tag before `bun fx bump` starts nudging for a release. */
export const TAG_NUDGE_DISTANCE = 10;

/**
 * Parse `git describe --tags --always` output into tag distance:
 * exact tag → 0; `<tag>-<n>-g<sha>` → n; bare sha (no tag reachable) → Infinity.
 */
export function tagDistance(describe: string): number {
  const m = describe.match(/-(\d+)-g[0-9a-f]+$/);
  if (m) return Number(m[1]);
  // A bare (possibly abbreviated) sha means no tag is reachable at all.
  return /^[0-9a-f]{7,40}$/.test(describe) ? Infinity : 0;
}

/**
 * One-line reminder when a bumped pin has no readable version name nearby.
 * The trigger itself is mechanical (subrepo CI derives tags from the
 * package.json version field); this nudge only surfaces the decision moment.
 */
export function tagNudge(path: string, describe: string): string | null {
  const distance = tagDistance(describe);
  if (distance < TAG_NUDGE_DISTANCE) return null;
  const detail = distance === Infinity ? 'no tag reachable' : `${distance} commits past ${describe.replace(/-\d+-g[0-9a-f]+$/, '')}`;
  return `${path}: ${detail} — consider bumping the version field in ${path}/package.json so CI cuts a <pkg>-vX.Y.Z tag (ADR 0022)`;
}
