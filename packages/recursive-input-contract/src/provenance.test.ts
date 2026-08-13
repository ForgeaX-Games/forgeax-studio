import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGitlinkGraph, type AuthoritativeGitGraph } from './git-graph.ts';
import { createAttemptStore, readAttemptResult } from './attempt-store.ts';
import {
  createCredentialCleanupFact,
  publishRecursiveInputResult,
} from './publisher.ts';
import { createRecursiveInputResult } from './validator.ts';

const roots: string[] = [];
const graph = projectGitlinkGraph({
  sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
  nodes: [{ path: 'packages/editor', pin: 'editor-a' }],
} satisfies AuthoritativeGitGraph);

function context(attempt: string) {
  return {
    graph,
    requestedInputClasses: ['source'] as const,
    trustScope: 'ordinary-ci' as const,
    job: 'provenance-test',
    attempt,
  };
}

function result(attempt: string, cleanup: 'passed' | 'failed' | 'unknown') {
  return createRecursiveInputResult({
    ...context(attempt),
    producer: 'provenance-test',
    credentialCleanup: createCredentialCleanupFact(cleanup),
    readiness: { source: { status: 'ready' } },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recursive input credential cleanup provenance', () => {
  test.each([
    ['passed', true],
    ['failed', false],
    ['unknown', false],
  ] as const)('records cleanup status %s as readiness fact', (status, isReady) => {
    const candidate = result(`attempt-${status}`, status);

    expect(candidate.status === 'ready').toBe(isReady);
    expect(candidate.provenance.credentialCleanup).toEqual({ status });
  });

  test('failed cleanup is retained as an attempt result without exposing credential material', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-provenance-'));
    roots.push(root);
    const store = createAttemptStore(root);
    const candidate = result('attempt-secretless', 'failed');

    publishRecursiveInputResult({ store, context: context('attempt-secretless'), result: candidate });

    const serialized = JSON.stringify(readAttemptResult(store, 'attempt-secretless'));
    expect(serialized).not.toContain('TOKEN');
    expect(serialized).not.toContain('Authorization');
    expect(readAttemptResult(store, 'attempt-secretless')?.provenance.credentialCleanup.status).toBe('failed');
  });
});
