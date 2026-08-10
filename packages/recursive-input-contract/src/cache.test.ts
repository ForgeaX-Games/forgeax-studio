import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGitlinkGraph, type AuthoritativeGitGraph } from './git-graph.ts';
import { createAttemptStore, invalidateCurrentReady, readCurrentReady } from './attempt-store.ts';
import { publishRecursiveInputResult, verifyCurrentReady } from './publisher.ts';
import { createRecursiveInputResult } from './validator.ts';

const roots: string[] = [];
const graph = projectGitlinkGraph({
  sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
  nodes: [{ path: 'packages/editor', pin: 'editor-a' }],
} satisfies AuthoritativeGitGraph);

function context(attempt: string, revision = 'root-a') {
  return {
    graph: { ...graph, sourceIdentity: { repository: 'forgeax-studio', revision } },
    requestedInputClasses: ['source'] as const,
    trustScope: 'ordinary-ci' as const,
    job: 'cache-test',
    attempt,
  };
}

function ready(attempt: string) {
  return createRecursiveInputResult({
    ...context(attempt),
    producer: 'cache-test',
    readiness: { source: { status: 'ready' } },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recursive input warm cache validation', () => {
  test('accepts a warm result only in the current repository, run, and trust scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-cache-'));
    roots.push(root);
    const store = createAttemptStore(root);
    publishRecursiveInputResult({ store, context: context('attempt-current'), result: ready('attempt-current') });

    expect(verifyCurrentReady({ store, context: context('attempt-current') }).ok).toBe(true);
    expect(verifyCurrentReady({
      store,
      context: { ...context('attempt-current'), trustScope: 'trusted-base-ci' },
    }).ok).toBe(false);
    expect(verifyCurrentReady({ store, context: context('attempt-current', 'root-other') }).ok).toBe(false);
  });

  test('invalidates an unverifiable warm result and requires a cold attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-cache-'));
    roots.push(root);
    const store = createAttemptStore(root);
    publishRecursiveInputResult({ store, context: context('attempt-current'), result: ready('attempt-current') });

    invalidateCurrentReady(store);

    expect(readCurrentReady(store)).toBeNull();
    expect(verifyCurrentReady({ store, context: context('attempt-current') }).ok).toBe(false);
  });

  test('does not require unrelated build output for a source-only consumer', () => {
    const candidate = ready('attempt-source-only');

    expect(candidate.status).toBe('ready');
    expect(candidate.readiness.source.status).toBe('ready');
    expect(candidate.readiness['build-output'].status).toBe('not-requested');
  });
});
