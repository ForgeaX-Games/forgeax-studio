#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const DISPOSABLE_WORKTREE_SCHEMA = 'forgeax-ci-disposable-worktree/v1' as const;
const MARKER = '.forgeax-ci-worktree.json';

export type DisposableWorktreeMarker = {
  schema: string;
  createdAt: string;
  source: string;
  target: string;
  revision?: string;
};

function safeSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${field} must be a safe path segment`);
  return value;
}

export function disposableWorktreeTarget(runnerTemp: string, runId: string, attempt: string, job: string): string {
  const root = resolve(runnerTemp);
  return join(root, 'forgeax', safeSegment(runId, 'runId'), safeSegment(attempt, 'attempt'), safeSegment(job, 'job'));
}

export function assertDisposableTarget(runnerTemp: string, target: string): void {
  const ownedRoot = resolve(runnerTemp, 'forgeax');
  const resolvedTarget = resolve(target);
  const inside = relative(ownedRoot, resolvedTarget);
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || resolve(ownedRoot, inside) !== resolvedTarget) {
    throw new Error(`disposable target must be a child of ${ownedRoot}`);
  }
}

export function isExpiredDisposableMarker(marker: DisposableWorktreeMarker, now: number, ttlMs: number): boolean {
  if (marker.schema !== DISPOSABLE_WORKTREE_SCHEMA || ttlMs <= 0) return false;
  const createdAt = Date.parse(marker.createdAt);
  return Number.isFinite(createdAt) && now - createdAt >= ttlMs;
}

function readMarker(path: string): DisposableWorktreeMarker | null {
  try {
    return JSON.parse(readFileSync(join(path, MARKER), 'utf8')) as DisposableWorktreeMarker;
  } catch {
    return null;
  }
}

function removeMarked(runnerTemp: string, target: string, expectedSource?: string): void {
  assertDisposableTarget(runnerTemp, target);
  const marker = readMarker(target);
  if (!marker || marker.schema !== DISPOSABLE_WORKTREE_SCHEMA || resolve(marker.target) !== resolve(target)) {
    throw new Error(`refusing to remove unmarked disposable target ${target}`);
  }
  if (expectedSource && resolve(marker.source) !== resolve(expectedSource)) {
    throw new Error(`disposable marker source mismatch for ${target}`);
  }
  const removed = spawnSync('git', ['-C', marker.source, 'worktree', 'remove', '--force', target], { stdio: 'inherit' });
  if ((removed.status ?? 1) !== 0 && existsSync(target)) rmSync(target, { recursive: true, force: true });
  spawnSync('git', ['-C', marker.source, 'worktree', 'prune'], { stdio: 'ignore' });
}

function candidateTargets(runnerTemp: string): string[] {
  const root = resolve(runnerTemp, 'forgeax');
  if (!existsSync(root)) return [];
  const output: string[] = [];
  for (const run of readdirSync(root, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    for (const attempt of readdirSync(join(root, run.name), { withFileTypes: true })) {
      if (!attempt.isDirectory()) continue;
      for (const job of readdirSync(join(root, run.name, attempt.name), { withFileTypes: true })) {
        if (job.isDirectory()) output.push(join(root, run.name, attempt.name, job.name));
      }
    }
  }
  return output;
}

export function reapExpired(runnerTemp: string, ttlMs: number, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const target of candidateTargets(runnerTemp)) {
    const marker = readMarker(target);
    if (!marker || !isExpiredDisposableMarker(marker, now, ttlMs)) continue;
    removeMarked(runnerTemp, target);
    removed.push(target);
  }
  return removed;
}

function parse(argv: string[]): { command: string; values: Map<string, string> } {
  const [command = '', ...args] = argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${String(key)}`);
    values.set(key.slice(2), value);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function main(): void {
  const { command, values } = parse(process.argv.slice(2));
  const runnerTemp = resolve(required(values, 'runner-temp'));
  const ttlHours = Number(values.get('ttl-hours') ?? '6');
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error('--ttl-hours must be positive');
  const ttlMs = ttlHours * 60 * 60 * 1000;

  if (command === 'reap') {
    const removed = reapExpired(runnerTemp, ttlMs);
    process.stdout.write(`${JSON.stringify({ removed })}\n`);
    return;
  }

  const target = resolve(required(values, 'target'));
  assertDisposableTarget(runnerTemp, target);
  if (command === 'cleanup') {
    removeMarked(runnerTemp, target, values.get('source'));
    return;
  }
  if (command !== 'prepare') throw new Error('usage: disposable-worktree.ts <prepare|cleanup|reap> ...');

  const source = resolve(required(values, 'source'));
  const revision = required(values, 'revision');
  reapExpired(runnerTemp, ttlMs);
  if (existsSync(target)) removeMarked(runnerTemp, target, source);
  execFileSync('git', ['-C', source, 'worktree', 'add', '--detach', target, revision], { stdio: 'inherit' });
  const marker: DisposableWorktreeMarker = {
    schema: DISPOSABLE_WORKTREE_SCHEMA,
    createdAt: new Date().toISOString(),
    source,
    target,
    revision,
  };
  writeFileSync(join(target, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `workspace=${target}\nmarker=${join(target, MARKER)}\n`);
  process.stdout.write(`${JSON.stringify({ workspace: target, marker: join(target, MARKER), name: basename(target), parent: dirname(target) })}\n`);
}

if (import.meta.main) main();
