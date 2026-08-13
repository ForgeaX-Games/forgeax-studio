import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeInputDigest } from './digest.ts';
import { projectGitlinkGraph, type AuthoritativeGitGraph } from './git-graph.ts';
import { createAttemptStore, readAttemptResult, readCurrentReady } from './attempt-store.ts';
import { publishRecursiveInputResult } from './publisher.ts';
import { type RecursiveInputResult } from './schema.ts';
import { createRecursiveInputResult } from './validator.ts';

const roots: string[] = [];

const graph: AuthoritativeGitGraph = {
  sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
  nodes: [{
    path: 'packages/editor',
    pin: 'editor-a',
    children: [{ path: 'packages/editor/packages/engine', pin: 'engine-a' }],
  }],
};
const projected = projectGitlinkGraph(graph);
const classes = ['source', 'toolchain'] as const;

function context(attempt: string) {
  return {
    graph: projected,
    requestedInputClasses: classes,
    trustScope: 'local-fixed-worktree' as const,
    job: 'publisher-test',
    attempt,
  };
}

function ready(attempt: string): RecursiveInputResult {
  return createRecursiveInputResult({
    ...context(attempt),
    producer: 'publisher-test',
    readiness: {
      source: { status: 'ready' },
      toolchain: { status: 'ready' },
    },
  });
}

function nonReady(attempt: string, code = 'recursive-input.materialization-cancelled'): RecursiveInputResult {
  return createRecursiveInputResult({
    ...context(attempt),
    producer: 'publisher-test',
    readiness: {
      source: { status: 'partial' },
      toolchain: { status: 'unknown' },
    },
    failure: {
      code,
      hint: 'Discard the partial attempt and retry from a complete checkout.',
      expected: 'complete recursive checkout',
      actual: 'cancelled before post-check',
      retryable: true,
      recoveryActions: ['discard-partial-state', 'retry-cold'],
    },
  });
}

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-publisher-'));
  roots.push(root);
  return createAttemptStore(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recursive input atomic publisher', () => {
  test('invalidates stale ready before recording a failed current attempt', () => {
    const store = makeStore();
    writeFileSync(store.readyPath, JSON.stringify(ready('attempt-old')));

    const published = publishRecursiveInputResult({
      store,
      context: context('attempt-current'),
      result: nonReady('attempt-current'),
    });

    expect(published.ok).toBe(false);
    expect(readCurrentReady(store)).toBeNull();
    expect(readAttemptResult(store, 'attempt-current')?.status).toBe('non-ready');
  });

  test('writes a complete ready result through a same-directory atomic rename', () => {
    const store = makeStore();
    const published = publishRecursiveInputResult({
      store,
      context: context('attempt-success'),
      result: ready('attempt-success'),
    });

    expect(published.ok).toBe(true);
    expect(readCurrentReady(store)).toEqual(ready('attempt-success'));
    expect(readdirSync(store.directory).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(readFileSync(store.readyPath, 'utf8')).toContain('"status":"ready"');
  });

  test('keeps cancelled and partial checkout facts in the attempt store without publishing ready', () => {
    const store = makeStore();
    const published = publishRecursiveInputResult({
      store,
      context: context('attempt-cancelled'),
      result: nonReady('attempt-cancelled'),
    });

    expect(published.ok).toBe(false);
    expect(readCurrentReady(store)).toBeNull();
    expect(readAttemptResult(store, 'attempt-cancelled')).toMatchObject({
      status: 'non-ready',
      content: { inputDigest: computeInputDigest({
        sourceIdentity: graph.sourceIdentity,
        recursivePins: projected.pins,
        requestedInputClasses: classes,
      }) },
    });
  });

  test('keeps content identity stable while separating repeated attempt provenance', () => {
    const store = makeStore();
    const first = publishRecursiveInputResult({ store, context: context('attempt-one'), result: ready('attempt-one') });
    const second = publishRecursiveInputResult({ store, context: context('attempt-two'), result: ready('attempt-two') });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(readAttemptResult(store, 'attempt-one')?.content.inputDigest)
      .toBe(readAttemptResult(store, 'attempt-two')?.content.inputDigest);
    expect(readAttemptResult(store, 'attempt-one')?.provenance.attempt).toBe('attempt-one');
    expect(readAttemptResult(store, 'attempt-two')?.provenance.attempt).toBe('attempt-two');
    expect(readCurrentReady(store)?.provenance.attempt).toBe('attempt-two');
  });
});
