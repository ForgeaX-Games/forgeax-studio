#!/usr/bin/env bun
// @ts-nocheck
// scripts/repos.ts — multi-repo lifecycle commands behind `bun fx`.
//
//   bun fx status --repos      # scan table: branch / ahead-behind / dirty / pin drift
//   bun fx versions            # scan table + nearest tag (derived manifest — never hand-maintained)
//   bun fx sync [--dry-run]    # DEV sync: fetch + ff-only each submodule BRANCH (keeps branch
//                              #   checkouts; contrast `bun fx update`, which detaches to pins)
//   bun fx check [--all] [path...]
//                              # run each dirty repo's own gates (lint/lint:dep/lint:agnostic/test;
//                              #   root: lint:layers/lint:boundaries/test:layers/test:boundaries).
//                              #   Paths narrow the target set.
//   bun fx commit -m "msg" [path...] [--push] [--dry-run] [--no-verify]
//                              # leaf-first multi-repo commit; paths scope it (`.` = root only).
//                              #   Hard rails: no detached-HEAD commits, no pushes to main
//                              #   (PR-only), and a parent may only record a child pin whose sha
//                              #   already exists on the child's remote (kills the #173
//                              #   dangling-pin class locally).
//   bun fx bump <path...> [--dry-run]
//                              # advance a direct submodule: fetch + ff its branch, then stage the
//                              #   new pin in root. Reports the nearest tag (ADR 0022 tag
//                              #   discipline: bump commits/PRs carry it). Commit via `bun fx commit`.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeRepo,
  formatTable,
  gatesForRepo,
  gitOut,
  orderLeafFirst,
  planCommit,
  remoteContains,
  scanRepos,
  shortSha,
  tagNudge,
  type RepoInfo,
} from './lib/repos.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUN = process.execPath;

function git(repo: RepoInfo, args: string[], dryRun: boolean): boolean {
  if (dryRun) {
    console.log(`[dry-run] (${repo.path || 'root'}) git ${args.join(' ')}`);
    return true;
  }
  const r = spawnSync('git', args, { cwd: repo.absPath, stdio: 'inherit' });
  return (r.status ?? 1) === 0;
}

function label(repo: RepoInfo): string {
  return repo.path || '(root)';
}

// ── status / versions ────────────────────────────────────────────────────────

function scanTable(repos: RepoInfo[], withDescribe: boolean): string {
  const header = ['REPO', 'BRANCH', 'AHEAD', 'BEHIND', 'DIRTY', 'PIN', ...(withDescribe ? ['NEAREST TAG'] : [])];
  const rows = repos.map((r) => [
    label(r),
    r.branch + (r.upstream ? '' : r.path ? ' (no upstream)' : ''),
    r.ahead ? String(r.ahead) : '',
    r.behind ? String(r.behind) : '',
    r.dirty ? 'yes' : '',
    r.path === '' ? '' : r.pin === r.head ? 'ok' : `drift ${shortSha(r.pin)}→${shortSha(r.head)}`,
    ...(withDescribe ? [describeRepo(r)] : []),
  ]);
  return formatTable(header, rows);
}

// ── sync ─────────────────────────────────────────────────────────────────────

function syncCmd(args: string[]): number {
  const dryRun = args.includes('--dry-run');
  const repos = scanRepos(ROOT);
  const rows: string[][] = [];
  let failed = 0;

  for (const repo of repos) {
    if (repo.path === '') {
      rows.push([label(repo), 'skipped', 'root is `bun fx update` territory']);
      continue;
    }
    if (repo.branch === 'DETACHED') {
      rows.push([label(repo), 'skipped', 'detached at pin — no branch to fast-forward']);
      continue;
    }
    if (!repo.upstream) {
      rows.push([label(repo), 'skipped', `branch ${repo.branch} has no upstream`]);
      continue;
    }
    if (dryRun) {
      rows.push([label(repo), 'planned', `fetch + ff-only ${repo.branch} (currently ${repo.behind}↓ ${repo.ahead}↑)`]);
      continue;
    }
    if (!git(repo, ['fetch', '--quiet'], false)) {
      rows.push([label(repo), 'FAILED', 'fetch failed (offline?)']);
      failed++;
      continue;
    }
    // Re-read counts after fetch — the scan predates it.
    const counts = gitOut(repo.absPath, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).split(/\s+/);
    const ahead = Number(counts[0]) || 0;
    const behind = Number(counts[1]) || 0;
    if (behind === 0) {
      rows.push([label(repo), 'ok', ahead ? `up-to-date, ${ahead} unpushed commit(s)` : 'up-to-date']);
      continue;
    }
    if (ahead > 0) {
      rows.push([label(repo), 'FAILED', `diverged (${ahead}↑ ${behind}↓) — resolve manually`]);
      failed++;
      continue;
    }
    if (git(repo, ['merge', '--ff-only', '@{u}'], false)) {
      rows.push([label(repo), 'ok', `fast-forwarded ${behind} commit(s)`]);
    } else {
      rows.push([label(repo), 'FAILED', 'ff-only merge failed (dirty files in the way?)']);
      failed++;
    }
  }

  console.log(formatTable(['REPO', 'RESULT', 'DETAIL'], rows));
  console.log('\nnote: sync moves submodule BRANCHES past the recorded pins; root will show them as');
  console.log('      new commits. Stage a new pin with `bun fx bump <path>`, commit with `bun fx commit`.');
  return failed ? 1 : 0;
}

// ── check ────────────────────────────────────────────────────────────────────

function checkCmd(args: string[]): number {
  const all = args.includes('--all');
  const pathArgs = args.filter((a) => !a.startsWith('--')).map((p) => (p === '.' ? '' : p));
  const repos = scanRepos(ROOT).filter(
    (r) => (all || r.dirty) && (pathArgs.length === 0 || pathArgs.includes(r.path)),
  );
  if (repos.length === 0) {
    console.log('nothing to check (no dirty repo matched — use --all to gate every repo, or pass repo paths)');
    return 0;
  }
  const rows: string[][] = [];
  let failed = 0;
  for (const repo of repos) {
    const gates = gatesForRepo(repo);
    if (gates.length === 0) {
      rows.push([label(repo), 'skipped', 'no gate scripts in package.json']);
      continue;
    }
    for (const gate of gates) {
      console.log(`\n── ${label(repo)} · bun run ${gate} ──`);
      const r = spawnSync(BUN, ['run', gate], { cwd: repo.absPath, stdio: 'inherit' });
      if ((r.status ?? 1) === 0) {
        rows.push([label(repo), gate, 'ok']);
      } else {
        rows.push([label(repo), gate, 'FAILED']);
        failed++;
        break; // first failing gate stops this repo; move on to the next repo
      }
    }
  }
  console.log(`\n${formatTable(['REPO', 'GATE', 'RESULT'], rows)}`);
  return failed ? 1 : 0;
}

// ── commit ───────────────────────────────────────────────────────────────────

function commitCmd(args: string[]): number {
  const dryRun = args.includes('--dry-run');
  const push = args.includes('--push');
  const noVerify = args.includes('--no-verify');
  const mIdx = args.indexOf('-m');
  const message = mIdx >= 0 ? args[mIdx + 1] : undefined;
  if (!message) {
    console.error('usage: bun fx commit -m "message" [path...] [--push] [--dry-run] [--no-verify]');
    console.error('       paths scope the commit to those repos (`.` = root); default: every dirty repo');
    return 2;
  }
  const scopePaths = args
    .filter((a, i) => i !== mIdx && i !== mIdx + 1 && !a.startsWith('--'))
    .map((p) => (p === '.' ? '' : p.replace(/\/$/, '')));

  const repos = scanRepos(ROOT);
  // Out-of-scope repos are treated as clean: they are not committed, but their
  // pin relationships stay visible to the dangling-pin guard.
  const scoped = scopePaths.length === 0 ? repos : repos.map((r) => (scopePaths.includes(r.path) ? r : { ...r, dirty: false }));
  const plan = planCommit(scoped, { push });
  if (plan.violations.length > 0) {
    console.error('commit blocked:');
    for (const v of plan.violations) console.error(`- ${v}`);
    return 2;
  }
  if (plan.steps.length === 0) {
    console.log('nothing dirty — nothing to commit');
    return 0;
  }

  if (!noVerify && !dryRun) {
    console.log('[commit] running gates on dirty repos first (skip with --no-verify)…');
    // Inherit the commit scope — out-of-scope dirt (e.g. parallel-track repos) is not gated here.
    const gateExit = checkCmd(scopePaths.map((p) => (p === '' ? '.' : p)));
    if (gateExit !== 0) {
      console.error('[commit] gates failed — fix or rerun with --no-verify (loudly discouraged)');
      return gateExit;
    }
  } else if (noVerify) {
    console.log('[commit] --no-verify: gates SKIPPED');
  }

  const byPath = new Map(repos.map((r) => [r.path, r]));
  const rows: string[][] = [];
  for (const step of plan.steps) {
    const repo = byPath.get(step.path)!;

    // Dangling-pin guard: every child pin this commit records must already be
    // on the child's remote. (Children commit+push before parents — leaf-first.)
    for (const check of step.pinChecks) {
      const child = byPath.get(check.child)!;
      if (dryRun) {
        console.log(`[dry-run] (${step.path || 'root'}) verify ${check.child}@${shortSha(check.sha)} is on its remote`);
        continue;
      }
      if (!remoteContains(child.absPath, check.sha)) {
        console.error(`[commit] BLOCKED: ${label(repo)} would pin ${check.child}@${shortSha(check.sha)}, but that sha is not on ${check.child}'s remote yet — push it first (dangling-pin guard)`);
        rows.push([label(repo), 'BLOCKED', `dangling pin ${check.child}@${shortSha(check.sha)}`]);
        console.log(`\n${formatTable(['REPO', 'RESULT', 'DETAIL'], rows)}`);
        return 1;
      }
    }

    const ok = git(repo, ['add', '-A'], dryRun) && git(repo, ['commit', '-m', message], dryRun);
    if (!ok) {
      rows.push([label(repo), 'FAILED', 'git add/commit failed']);
      console.log(`\n${formatTable(['REPO', 'RESULT', 'DETAIL'], rows)}`);
      return 1;
    }
    if (step.push === 'yes') {
      if (!git(repo, ['push', 'origin', 'HEAD'], dryRun)) {
        rows.push([label(repo), 'FAILED', 'push failed']);
        console.log(`\n${formatTable(['REPO', 'RESULT', 'DETAIL'], rows)}`);
        return 1;
      }
      rows.push([label(repo), dryRun ? 'planned' : 'ok', `committed + pushed (${step.branch})`]);
    } else if (step.push === 'refused-main') {
      rows.push([label(repo), dryRun ? 'planned' : 'ok', 'committed; push REFUSED (main is PR-only)']);
    } else {
      rows.push([label(repo), dryRun ? 'planned' : 'ok', `committed (${step.branch}, not pushed)`]);
    }
  }

  console.log(`\n${formatTable(['REPO', 'RESULT', 'DETAIL'], rows)}`);
  return 0;
}

// ── bump ─────────────────────────────────────────────────────────────────────

function bumpCmd(args: string[]): number {
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((a) => !a.startsWith('--'));
  const repos = scanRepos(ROOT);
  const direct = repos.filter((r) => r.parent === '');
  if (paths.length === 0) {
    console.error('usage: bun fx bump <path...> [--dry-run]   (direct submodules only)');
    console.error(`known: ${direct.map((r) => r.path).join(', ')}`);
    return 2;
  }

  const rows: string[][] = [];
  const nudges: string[] = [];
  let failed = 0;
  for (const path of paths) {
    const repo = direct.find((r) => r.path === path);
    if (!repo) {
      rows.push([path, 'FAILED', 'not a direct submodule of root']);
      failed++;
      continue;
    }
    if (repo.branch === 'DETACHED') {
      rows.push([path, 'FAILED', 'detached HEAD — check out a branch first (see plan root-checkout rules)']);
      failed++;
      continue;
    }
    if (!repo.upstream) {
      rows.push([path, 'FAILED', `branch ${repo.branch} has no upstream to advance to`]);
      failed++;
      continue;
    }
    const oldPin = repo.pin;
    if (!dryRun) {
      if (!git(repo, ['fetch', '--quiet'], false) || !git(repo, ['merge', '--ff-only', '@{u}'], false)) {
        rows.push([path, 'FAILED', 'fetch/ff failed — resolve manually']);
        failed++;
        continue;
      }
    }
    const newHead = dryRun ? '(post-ff sha)' : gitOut(repo.absPath, ['rev-parse', 'HEAD']);
    if (!dryRun && newHead === oldPin) {
      rows.push([path, 'ok', 'already at pin — nothing to bump']);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] (root) git add ${path}`);
      rows.push([path, 'planned', `ff ${repo.branch}, then stage new pin`]);
      continue;
    }
    const r = spawnSync('git', ['add', path], { cwd: ROOT, stdio: 'inherit' });
    if ((r.status ?? 1) !== 0) {
      rows.push([path, 'FAILED', 'git add of new pin failed']);
      failed++;
      continue;
    }
    // ADR 0022 (Plan C): surface the nearest tag so the pin-bump commit/PR can
    // carry a human-readable version instead of a bare sha.
    const nearest = gitOut(repo.absPath, ['describe', '--tags', '--always']) || shortSha(newHead);
    rows.push([path, 'ok', `pin staged ${shortSha(oldPin)}→${shortSha(newHead)} (${nearest}) — commit via \`bun fx commit\``]);
    const nudge = tagNudge(path, nearest);
    if (nudge) nudges.push(nudge);
  }

  console.log(formatTable(['SUBMODULE', 'RESULT', 'DETAIL'], rows));
  for (const nudge of nudges) console.log(`\nnudge: ${nudge}`);
  return failed ? 1 : 0;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function main(): void {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'status':
      console.log(scanTable(scanRepos(ROOT), false));
      process.exit(0);
    case 'versions':
      console.log(scanTable(scanRepos(ROOT), true));
      process.exit(0);
    case 'sync':
      process.exit(syncCmd(args));
    case 'check':
      process.exit(checkCmd(args));
    case 'commit':
      process.exit(commitCmd(args));
    case 'bump':
      process.exit(bumpCmd(args));
    default:
      console.error('usage: bun fx sync|check|commit|bump|versions  (or: bun fx status --repos)');
      process.exit(2);
  }
}

main();
