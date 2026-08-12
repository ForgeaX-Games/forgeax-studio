import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecursiveInputResult } from './schema.ts';

export type AttemptStore = {
  directory: string;
  attemptsDirectory: string;
  readyPath: string;
};

function safeAttempt(attempt: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(attempt)) {
    throw new TypeError('attempt must contain only ASCII letters, digits, dot, underscore, or hyphen');
  }
  return attempt;
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

export function createAttemptStore(directory: string): AttemptStore {
  const store = {
    directory,
    attemptsDirectory: join(directory, 'attempts'),
    readyPath: join(directory, 'ready.json'),
  };
  mkdirSync(store.attemptsDirectory, { recursive: true });
  return store;
}

export function attemptResultPath(store: AttemptStore, attempt: string): string {
  return join(store.attemptsDirectory, `${safeAttempt(attempt)}.json`);
}

export function invalidateCurrentReady(store: AttemptStore): void {
  rmSync(store.readyPath, { force: true });
}

export function writeAttemptResult(
  store: AttemptStore,
  attempt: string,
  result: RecursiveInputResult,
): void {
  mkdirSync(store.attemptsDirectory, { recursive: true });
  writeJsonAtomically(attemptResultPath(store, attempt), result);
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function readAttemptResult(store: AttemptStore, attempt: string): RecursiveInputResult | null {
  const value = readJson(attemptResultPath(store, attempt));
  return value && typeof value === 'object' ? value as RecursiveInputResult : null;
}

export function readCurrentReady(store: AttemptStore): RecursiveInputResult | null {
  const value = readJson(store.readyPath);
  return value && typeof value === 'object' ? value as RecursiveInputResult : null;
}

export function publishCurrentReady(store: AttemptStore, result: RecursiveInputResult): void {
  writeJsonAtomically(store.readyPath, result);
}
