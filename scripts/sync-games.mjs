#!/usr/bin/env node
// Materialise the optional forgeax-games consumer checkout at packages/games.
// It deliberately has no gitlink in Studio: local game-library work floats
// independently, while Studio's own templates come from the engine checkout.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'packages/games');
const REPO = process.env.FORGEAX_GAMES_REPO ?? 'https://github.com/ForgeaX-Games/forgeax-games.git';

const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10',
};
const NO_CRED = ['-c', 'credential.helper='];

function git(args, opts = {}) {
  return spawnSync('git', [...NO_CRED, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: gitEnv,
    ...opts,
  });
}

function sshAvailable() {
  const probe = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', 'git@github.com'],
    { encoding: 'utf8' },
  );
  return `${probe.stdout ?? ''}${probe.stderr ?? ''}`.includes('successfully authenticated');
}

function cloneUrl() {
  if (sshAvailable() && REPO.startsWith('https://github.com/')) {
    return REPO.replace('https://github.com/', 'git@github.com:');
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token && REPO.startsWith('https://github.com/')) {
    return REPO.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
  }
  return REPO;
}

function isGitRepo() {
  return existsSync(DIR)
    && existsSync(resolve(DIR, '.git'))
    && git(['-C', DIR, 'rev-parse', '--git-dir']).status === 0;
}

function fetchArgs() {
  // An existing checkout already has an authenticated origin from --ensure.
  // Reusing it avoids a fresh SSH auth probe on every `bun fx update` while
  // preserving cloneUrl() as the fallback for unusual local checkouts.
  const origin = git(['-C', DIR, 'remote', 'get-url', 'origin']);
  // An explicit repository override is authoritative and must keep using the
  // configured URL even when the checkout's origin points elsewhere.
  if (!process.env.FORGEAX_GAMES_REPO && origin.status === 0 && origin.stdout?.trim()) {
    return ['-C', DIR, 'fetch', '--quiet', '--no-tags', 'origin', 'main'];
  }
  return ['-C', DIR, 'fetch', '--quiet', '--no-tags', cloneUrl(), 'main'];
}

function gitError(result) {
  return `${result.stderr ?? ''}`.trim() || `git exited with status ${result.status ?? 1}`;
}

function ensure() {
  if (isGitRepo()) {
    const head = git(['-C', DIR, 'rev-parse', '--short', 'HEAD']);
    process.stdout.write(`[games:floating] existing checkout preserved at ${(head.stdout ?? '').trim()}\n`);
    return 0;
  }

  if (existsSync(DIR) && readdirSync(DIR).length > 0) {
    process.stderr.write('[games:floating] packages/games exists but is not a git checkout; preserving it\n');
    return 0;
  }

  const result = git(['clone', '--quiet', '--depth', '1', '--branch', 'main', '--no-tags', cloneUrl(), DIR]);
  if (result.status !== 0) {
    process.stderr.write(`[games:floating] optional clone failed: ${gitError(result)}\n`);
    return 0;
  }
  process.stdout.write('[games:floating] cloned forgeax-games/main\n');
  return 0;
}

function update(dryRun) {
  if (!existsSync(DIR)) {
    process.stdout.write('[games:floating] checkout absent; update skipped\n');
    return 0;
  }
  const gitRepo = isGitRepo();
  if (!gitRepo && readdirSync(DIR).length === 0) {
    process.stdout.write('[games:floating] checkout absent; update skipped\n');
    return 0;
  }
  if (!gitRepo) {
    process.stdout.write('[games:floating] packages/games is externally supplied; update skipped\n');
    return 0;
  }
  if (dryRun) {
    process.stdout.write('[games:floating] would fetch and checkout forgeax-games/main\n');
    return 0;
  }
  const dirty = git(['-C', DIR, 'status', '--porcelain']).stdout?.trim();
  if (dirty) {
    process.stderr.write('[games:floating] local changes detected; refusing to update\n');
    return 1;
  }

  const fetch = git(fetchArgs());
  if (fetch.status !== 0) {
    process.stderr.write(`[games:floating] fetch failed: ${gitError(fetch)}\n`);
    return 1;
  }
  const current = (git(['-C', DIR, 'rev-parse', 'HEAD']).stdout ?? '').trim();
  const latest = (git(['-C', DIR, 'rev-parse', 'FETCH_HEAD']).stdout ?? '').trim();
  if (!latest) {
    process.stderr.write('[games:floating] fetch produced no main commit\n');
    return 1;
  }
  if (current === latest) {
    process.stdout.write(`[games:floating] already at ${latest.slice(0, 8)}\n`);
    return 0;
  }

  const checkout = git(['-C', DIR, 'checkout', '--detach', 'FETCH_HEAD']);
  if (checkout.status !== 0) {
    process.stderr.write(`[games:floating] checkout failed: ${gitError(checkout)}\n`);
    return 1;
  }
  process.stdout.write(`[games:floating] updated ${current.slice(0, 8)} → ${latest.slice(0, 8)}\n`);
  return 0;
}

const args = new Set(process.argv.slice(2));
if (process.env.FORGEAX_SKIP_GAMES === '1') {
  process.stdout.write('[games:floating] skipped (FORGEAX_SKIP_GAMES=1)\n');
  process.exit(0);
}
if (args.has('--ensure') === args.has('--update')) {
  process.stderr.write('usage: sync-games.mjs --ensure | --update [--dry-run]\n');
  process.exit(2);
}
process.exit(args.has('--ensure') ? ensure() : update(args.has('--dry-run')));
