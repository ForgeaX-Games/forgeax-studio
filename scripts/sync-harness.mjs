#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
// sync-harness.mjs — materialise the .forgeax-harness floating clone.
//
// .forgeax-harness is a standalone clone of forgeax-studio-harness, nested at
// <studio>/.forgeax-harness/ but gitignored + untracked by the studio repo
// (NOT a submodule — mirrors the forgeax-engine ↔ forgeax-engine-harness
// floating-clone design, see
// forgeax-engine/docs/specs/2026-06-06-harness-desubmodule-floating-clone-design.md).
// This script clones it on first run and fast-forwards it on later runs, so
// fresh checkouts + CI get the closed-loop state without `git submodule`.
//
// Runnable as `npm run harness:sync`; also called from scripts/bootstrap.sh
// and scripts/deploy.sh. Studio has no pnpm postinstall flow, so it is wired
// into the shell deploy entry points rather than package.json#postinstall.
//
// Failure policy:
//   - FORGEAX_SKIP_HARNESS_SYNC set        -> exit 0 (studio build/test do not
//     need the harness; CI opts in only where required).
//   - offline / clone or fetch unreachable -> warn, exit 0 (graceful: a missing
//     harness must not break install/bootstrap).
//   - LOUD failure (exit 1) ONLY when a local clone has diverged from origin and
//     `merge --ff-only` would skip un-pushed loop state.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DIR = resolve(root, '.forgeax-harness');
const REPO = 'https://github.com/ForgeaX-Games/forgeax-studio-harness.git';

// Never let git block on a TTY prompt or a GUI credential helper. Every git
// invocation below inherits these — a fresh HTTPS clone without a working SSH
// key / PAT will fail fast (warnExit0) instead of hanging waiting on stdin.
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
};
const NO_CRED = ['-c', 'credential.helper='];

function git(args, opts = {}) {
  return spawnSync('git', [...NO_CRED, ...args], { encoding: 'utf8', env: gitEnv, ...opts });
}

// SSH fallback for the private forgeax-studio-harness repo.
// REPO is an HTTPS URL but the repo is private; accounts with 2FA can't auth
// over HTTPS without a PAT. If a working GitHub SSH key is present (the common
// case), clone over SSH instead. If neither SSH nor a token is available, fall
// through to HTTPS — the clone will fail fast (prompts disabled) with a clear
// warning rather than hang.
//
// Exported so specs can exercise the branch table without touching the network.
// Injectable deps (env / sshProbe / warn) keep the function pure.
export function resolveCloneUrl(
  repo = REPO,
  env = process.env,
  sshProbe = defaultSshProbe,
  warn = (msg) => process.stdout.write(msg),
) {
  if (!repo.startsWith('https://github.com/')) return { url: repo, strategy: 'https-noauth' };
  if (sshProbe()) return { url: repo.replace('https://github.com/', 'git@github.com:'), strategy: 'ssh' };
  const tok = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (tok) {
    return {
      url: repo.replace('https://github.com/', `https://x-access-token:${tok}@github.com/`),
      strategy: 'pat',
    };
  }
  warn(
    '[harness:sync] no GitHub SSH key or GH_TOKEN detected; HTTPS clone of ' +
      'private forgeax-studio-harness will fail without prompting.\n',
  );
  return { url: repo, strategy: 'https-noauth' };
}

function defaultSshProbe() {
  const probe = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', 'git@github.com'],
    { encoding: 'utf8' },
  );
  return `${probe.stdout || ''}${probe.stderr || ''}`.includes('successfully authenticated');
}

function cloneUrl() {
  return resolveCloneUrl().url;
}

function warnExit0(msg) {
  process.stdout.write(`[harness:sync] ${msg} — continuing\n`);
  process.exit(0);
}

function failLoud(msg) {
  process.stderr.write(`[harness:sync] FORGEAX_HARNESS_DIVERGED: ${msg}\n`);
  process.exit(1);
}

// Only run the main sync flow when invoked directly (not when a spec imports
// resolveCloneUrl / other exports). Compare argv[1]'s file URL to import.meta.url.
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}

function main() {
if (process.env.FORGEAX_SKIP_HARNESS_SYNC) {
  process.stdout.write('[harness:sync] FORGEAX_SKIP_HARNESS_SYNC set — skipped\n');
  process.exit(0);
}

if (!existsSync(resolve(DIR, '.git'))) {
  const url = cloneUrl();
  const dirExists = existsSync(DIR);
  // Is the directory present but non-empty? `git clone` refuses to write into
  // a non-empty target, but that's a legitimate state here: forgeax-install
  // (install_harness.py) seeds .forgeax-harness/ with install-manifest.json +
  // scripts/ BEFORE this sync ever runs. Those are gitignored overlay files
  // meant to coexist with the floating clone. So instead of clone, "adopt"
  // the directory in place: init a repo, wire the remote, fetch the tip, and
  // check it out — preserving whatever install already wrote.
  const nonEmpty = dirExists && readdirSync(DIR).length > 0;

  if (!nonEmpty) {
    // First run (or a fresh checkout): plain clone. Offline → graceful skip.
    // Shallow by default (only the tip is needed); SSH if a key is available.
    const r = git(['clone', '--quiet', '--depth', '1', url, DIR], { cwd: root });
    if (r.status !== 0) {
      warnExit0(
        `clone failed (offline?); .forgeax-harness not materialised:\n${(r.stderr || '').trim()}`,
      );
    }
    process.stdout.write('[harness:sync] cloned forgeax-studio-harness\n');
    process.exit(0);
  }

  // Adopt-in-place path: non-empty dir without a .git (install-seeded).
  const steps = [
    ['init', ['init', '--quiet', DIR]],
    ['remote', ['-C', DIR, 'remote', 'add', 'origin', url]],
    ['fetch', ['-C', DIR, 'fetch', '--quiet', '--depth', '1', 'origin', 'main']],
    // -f: overwrite tracked files (e.g. the repo's own .gitignore) with the
    // remote version; install-seeded gitignored overlay files are untouched.
    ['checkout', ['-C', DIR, 'checkout', '-f', '-B', 'main', 'FETCH_HEAD']],
  ];
  for (const [label, args] of steps) {
    const r = git(args, { cwd: root });
    if (r.status !== 0) {
      warnExit0(
        `adopt-in-place ${label} failed (offline?); .forgeax-harness left as a plain dir:\n${(r.stderr || '').trim()}`,
      );
    }
  }
  process.stdout.write(
    '[harness:sync] adopted existing .forgeax-harness as floating clone (preserved install overlay)\n',
  );
  process.exit(0);
}

// Existing clone: fast-forward to origin/main. Never clobber local divergence.
const fetch = git(['fetch', '--quiet', 'origin', 'main'], { cwd: DIR });
if (fetch.status !== 0) {
  warnExit0(
    `fetch failed (offline?); leaving .forgeax-harness as-is:\n${(fetch.stderr || '').trim()}`,
  );
}

const ff = git(['merge', '--ff-only', 'origin/main'], { cwd: DIR });
if (ff.status === 0) {
  process.stdout.write('[harness:sync] fast-forwarded .forgeax-harness to origin/main\n');
  process.exit(0);
}

// ff-only refused. Distinguish "local has un-pushed commits" (loud, real risk)
// from a transient/no-op state (graceful).
const ahead = git(['rev-list', '--count', 'origin/main..HEAD'], { cwd: DIR });
const aheadN = Number.parseInt((ahead.stdout || '0').trim(), 10) || 0;
if (aheadN > 0) {
  failLoud(
    `local .forgeax-harness has ${aheadN} commit(s) not on origin/main; ` +
      'refusing to fast-forward (would not lose them, but the tree has ' +
      'diverged). Push or reconcile manually:\n' +
      '  git -C .forgeax-harness push   # or: git -C .forgeax-harness log origin/main..HEAD',
  );
}
warnExit0(
  `ff-only no-op (already up to date or detached); leaving as-is:\n${(ff.stderr || '').trim()}`,
);
}
