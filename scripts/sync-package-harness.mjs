#!/usr/bin/env node
// Materialise the forgeax-harness runtime-tool checkout at packages/harness.
// It is deliberately not a Studio submodule: setup bootstraps a missing
// checkout, while update is the only command that advances an existing one.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'packages/harness');
const REPO = 'https://github.com/ForgeaX-Games/forgeax-harness.git';

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
  if (sshAvailable()) return REPO.replace('https://github.com/', 'git@github.com:');
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) return REPO.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
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
  if (origin.status === 0 && origin.stdout?.trim()) {
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
    process.stdout.write(`[harness:package] existing checkout preserved at ${(head.stdout ?? '').trim()}\n`);
    return 0;
  }

  if (existsSync(DIR) && readdirSync(DIR).length > 0) {
    process.stderr.write('[harness:package] packages/harness exists but is not a git checkout\n');
    return 1;
  }

  const result = git(['clone', '--quiet', '--depth', '1', '--branch', 'main', '--no-tags', cloneUrl(), DIR]);
  if (result.status !== 0) {
    process.stderr.write(`[harness:package] clone failed: ${gitError(result)}\n`);
    return 1;
  }
  process.stdout.write('[harness:package] cloned forgeax-harness/main\n');
  return 0;
}

function update(dryRun) {
  if (!existsSync(DIR)) {
    process.stdout.write('[harness:package] checkout absent; update skipped\n');
    return 0;
  }
  const gitRepo = isGitRepo();
  if (!gitRepo && readdirSync(DIR).length === 0) {
    process.stdout.write('[harness:package] checkout absent; update skipped\n');
    return 0;
  }
  if (!gitRepo) {
    process.stderr.write('[harness:package] packages/harness exists but is not a git checkout\n');
    return 1;
  }
  if (dryRun) {
    process.stdout.write('[harness:package] would fetch and checkout forgeax-harness/main\n');
    return 0;
  }
  const dirty = git(['-C', DIR, 'status', '--porcelain']).stdout?.trim();
  if (dirty) {
    process.stderr.write('[harness:package] local changes detected; refusing to update\n');
    return 1;
  }

  const fetch = git(fetchArgs());
  if (fetch.status !== 0) {
    process.stderr.write(`[harness:package] fetch failed: ${gitError(fetch)}\n`);
    return 1;
  }
  const current = (git(['-C', DIR, 'rev-parse', 'HEAD']).stdout ?? '').trim();
  const latest = (git(['-C', DIR, 'rev-parse', 'FETCH_HEAD']).stdout ?? '').trim();
  if (!latest) {
    process.stderr.write('[harness:package] fetch produced no main commit\n');
    return 1;
  }
  if (current === latest) {
    process.stdout.write(`[harness:package] already at ${latest.slice(0, 8)}\n`);
    return 0;
  }

  // --detach handles both a normal fast-forward and a deliberate upstream
  // history rewrite. The dirty-tree check above makes this explicit update
  // safe; old commits remain recoverable in the local repository.
  const checkout = git(['-C', DIR, 'checkout', '--detach', 'FETCH_HEAD']);
  if (checkout.status !== 0) {
    process.stderr.write(`[harness:package] checkout failed: ${gitError(checkout)}\n`);
    return 1;
  }
  process.stdout.write(`[harness:package] updated ${current.slice(0, 8)} → ${latest.slice(0, 8)}\n`);
  return 0;
}

const args = new Set(process.argv.slice(2));
if (args.has('--ensure') === args.has('--update')) {
  process.stderr.write('usage: sync-package-harness.mjs --ensure | --update [--dry-run]\n');
  process.exit(2);
}
process.exit(args.has('--ensure') ? ensure() : update(args.has('--dry-run')));
