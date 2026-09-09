#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseGitmodules,
  resolveSubmoduleUrl,
  trackingBranch,
  type Submodule,
} from '../check-submodule-pins.ts';

const SHA_RE = /^[0-9a-f]{40}$/i;

export type RootPin = {
  path: string;
  url: string;
  branch: string;
  currentSha: string;
};

export type PinUpdate = RootPin & {
  nextSha: string;
};

type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runGit(args: string[], env: NodeJS.ProcessEnv = process.env): GitResult {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function redact(text: string): string {
  let output = text;
  for (const key of ['INTERNAL_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    const secret = process.env[key];
    if (secret) output = output.split(secret).join('***');
  }
  return output;
}

function gitOut(args: string[]): string {
  const result = runGit(args);
  if (result.status !== 0) {
    const detail = redact(result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function requireSha(value: string, label: string): string {
  const sha = value.trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error(`${label} is not a full commit SHA: ${value}`);
  return sha;
}

/** Parse one direct gitlink returned by `git ls-tree`. */
export function parseGitlink(output: string, path: string): string {
  const rows = output.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  const row = rows.find((candidate) => candidate.startsWith('160000 commit '));
  const sha = row?.match(/^160000 commit ([0-9a-f]{40})\s+/i)?.[1];
  if (!sha) throw new Error(`root path ${path} is not a valid mode-160000 gitlink`);
  return requireSha(sha, `${path} root pin`);
}

/** Parse an exact `refs/heads/<branch>` record from `git ls-remote --refs`. */
export function parseRemoteHead(output: string, ref: string): string {
  const matches = output
    .split(/\r?\n/)
    .map((row) => row.trim().split(/\s+/))
    .filter(([sha, remoteRef]) => remoteRef === ref && SHA_RE.test(sha ?? ''))
    .map(([sha]) => sha.toLowerCase());
  if (matches.length !== 1) {
    throw new Error(`remote did not return exactly one head for ${ref}`);
  }
  return requireSha(matches[0], `${ref} remote head`);
}

/** Plan all changes before touching the index, so a failed lookup leaves no partial staging. */
export function planPinUpdates(
  pins: readonly RootPin[],
  remoteHeads: ReadonlyMap<string, string>,
): PinUpdate[] {
  const updates: PinUpdate[] = [];
  for (const pin of pins) {
    const nextSha = requireSha(remoteHeads.get(pin.path) ?? '', `${pin.path} remote head`);
    if (nextSha === pin.currentSha) continue;
    updates.push({ ...pin, nextSha });
  }
  return updates;
}

/** The required-human-author gate must never be satisfied by an automation identity. */
export function isHumanActor(actor: string): boolean {
  const normalized = actor.trim().toLowerCase();
  if (!normalized) return false;
  return !(
    normalized.endsWith('[bot]')
    || normalized.endsWith('-bot')
    || normalized.endsWith('_bot')
    || normalized === 'github-actions'
    || normalized === 'dependabot'
    || normalized === 'renovate'
  );
}

export function formatPinSummary(updates: readonly PinUpdate[]): string {
  if (updates.length === 0) return 'No direct Studio submodule pins need updating.';
  return updates
    .map((update) => `- ${update.path}: ${update.currentSha} -> ${update.nextSha}`)
    .join('\n');
}

function directPins(root: string): RootPin[] {
  const modulesPath = join(root, '.gitmodules');
  const modules = parseGitmodules(readFileSync(modulesPath, 'utf8'));
  const parentRemote = gitOut(['config', '--get', 'remote.origin.url']);
  return modules.map((sub: Submodule) => {
    const currentSha = parseGitlink(gitOut(['ls-tree', 'HEAD', '--', sub.path]), sub.path);
    return {
      path: sub.path,
      url: resolveSubmoduleUrl(sub.url, parentRemote),
      branch: trackingBranch(sub),
      currentSha,
    };
  });
}

function remoteHeads(pins: readonly RootPin[]): Map<string, string> {
  const heads = new Map<string, string>();
  for (const pin of pins) {
    const ref = `refs/heads/${pin.branch}`;
    const result = runGit(['ls-remote', '--refs', pin.url, ref]);
    if (result.status !== 0) {
      const detail = redact(result.stderr || result.stdout).trim();
      throw new Error(`cannot inspect ${pin.path} ${ref}${detail ? `: ${detail}` : ''}`);
    }
    heads.set(pin.path, parseRemoteHead(result.stdout, ref));
  }
  return heads;
}

function assertRootClean(): void {
  const status = gitOut(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) {
    throw new Error('root checkout is not clean; refusing to stage automated pin updates');
  }
}

function stageUpdates(updates: readonly PinUpdate[]): void {
  for (const update of updates) {
    const result = runGit([
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${update.nextSha},${update.path}`,
    ]);
    if (result.status !== 0) {
      throw new Error(`cannot stage ${update.path}: ${redact(result.stderr || result.stdout).trim()}`);
    }
  }
}

export async function run(root = process.cwd()): Promise<PinUpdate[]> {
  process.chdir(root);
  assertRootClean();
  const pins = directPins(root);
  const updates = planPinUpdates(pins, remoteHeads(pins));
  if (updates.length > 0) stageUpdates(updates);
  console.log(formatPinSummary(updates));
  return updates;
}

if (import.meta.main) {
  void run().catch((error) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
