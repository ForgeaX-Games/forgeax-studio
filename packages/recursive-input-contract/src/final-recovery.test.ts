import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeInputDigest } from './digest.ts';
import { createAttemptStore, readAttemptResult, readCurrentReady } from './attempt-store.ts';
import { projectGitlinkGraph } from './git-graph.ts';
import {
  createCredentialCleanupFact,
  publishRecursiveInputResult,
  verifyCurrentReady,
} from './publisher.ts';
import {
  produceRecursiveInputResult,
  type MaterializationFacts,
} from './producer.ts';
import type { RecursiveInputResult } from './schema.ts';
import { createRecursiveInputResult } from './validator.ts';

const roots: string[] = [];
const graph = projectGitlinkGraph({
  sourceIdentity: { repository: 'forgeax-studio', revision: 'final-recovery-root' },
  nodes: [
    {
      path: 'packages/editor',
      pin: 'editor-pin',
      children: [{ path: 'packages/editor/packages/engine', pin: 'engine-pin' }],
    },
    { path: 'packages/contracts', pin: 'contracts-pin' },
  ],
});
const requestedInputClasses = ['source', 'toolchain'] as const;

function context(attempt: string) {
  return {
    graph,
    requestedInputClasses,
    trustScope: 'ordinary-ci' as const,
    job: 'final-recovery',
    attempt,
  };
}

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-final-recovery-'));
  roots.push(root);
  return createAttemptStore(root);
}

function readyFacts(mode: 'cold' | 'warm'): MaterializationFacts {
  return {
    status: 'ready',
    credentialCleanup: createCredentialCleanupFact('passed'),
    warm: { mode, verified: true },
    readiness: {
      source: { status: 'ready' },
      toolchain: { status: 'ready' },
    },
  };
}

function readyResult(attempt: string, producer = 'final-recovery-test'): RecursiveInputResult {
  return createRecursiveInputResult({
    ...context(attempt),
    producer,
    readiness: {
      source: { status: 'ready' },
      toolchain: { status: 'ready' },
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recursive input final recovery matrix', () => {
  test('keeps repeated content identity stable, distinguishes attempts, and rejects stale ready', () => {
    const store = makeStore();
    const first = publishRecursiveInputResult({
      store,
      context: context('attempt-one'),
      result: readyResult('attempt-one', 'producer-one'),
    });
    const second = publishRecursiveInputResult({
      store,
      context: context('attempt-two'),
      result: readyResult('attempt-two', 'producer-two'),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstAttempt = readAttemptResult(store, 'attempt-one');
    const secondAttempt = readAttemptResult(store, 'attempt-two');
    expect(firstAttempt?.content.inputDigest).toBe(secondAttempt?.content.inputDigest);
    expect(firstAttempt?.content.inputDigest).toBe(computeInputDigest({
      sourceIdentity: graph.sourceIdentity,
      recursivePins: graph.pins,
      requestedInputClasses,
    }));
    expect(firstAttempt?.provenance.attempt).toBe('attempt-one');
    expect(secondAttempt?.provenance.attempt).toBe('attempt-two');
    expect(secondAttempt?.provenance.producer).toBe('producer-two');
    expect(readCurrentReady(store)?.provenance.attempt).toBe('attempt-two');
    expect(readdirSync(store.attemptsDirectory).sort()).toEqual(['attempt-one.json', 'attempt-two.json']);

    const stale = verifyCurrentReady({ store, context: context('attempt-one') });
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.result.status === 'non-ready') {
      expect(stale.result.failure.code).toBe('recursive-input.attempt-mismatch');
    }
  });

  test('invalidates stale ready before every failed or cancelled retry and preserves cleanup facts', () => {
    const cases = [
      {
        attempt: 'partial-attempt',
        facts: {
          status: 'partial',
          credentialCleanup: createCredentialCleanupFact('passed'),
          readiness: {
            source: { status: 'partial' },
            toolchain: { status: 'unknown' },
          },
        } satisfies MaterializationFacts,
        validationCode: 'recursive-input.result-not-ready',
      },
      {
        attempt: 'cancelled-attempt',
        facts: {
          status: 'cancelled',
          credentialCleanup: createCredentialCleanupFact('unknown'),
        } satisfies MaterializationFacts,
        validationCode: 'recursive-input.credential-cleanup-failed',
      },
      {
        attempt: 'cleanup-failed-attempt',
        facts: {
          status: 'ready',
          credentialCleanup: createCredentialCleanupFact('failed'),
          readiness: {
            source: { status: 'ready' },
            toolchain: { status: 'ready' },
          },
        } satisfies MaterializationFacts,
        validationCode: 'recursive-input.credential-cleanup-failed',
      },
    ] as const;

    for (const entry of cases) {
      const store = makeStore();
      const old = publishRecursiveInputResult({
        store,
        context: context(`${entry.attempt}-old`),
        result: readyResult(`${entry.attempt}-old`),
      });
      expect(old.ok).toBe(true);
      expect(readCurrentReady(store)?.status).toBe('ready');

      const retried = produceRecursiveInputResult({
        store,
        context: context(entry.attempt),
        producer: 'final-recovery-producer',
        facts: entry.facts,
      });
      expect(retried.ok).toBe(false);
      expect(retried.result.status).toBe('non-ready');
      if (retried.result.status === 'non-ready') {
        expect(retried.result.failure.code).toBe(entry.validationCode);
        expect(retried.result.failure.recoveryActions.length).toBeGreaterThan(0);
      }
      expect(readCurrentReady(store)).toBeNull();
      expect(readAttemptResult(store, entry.attempt)?.provenance.credentialCleanup)
        .toEqual(entry.facts.credentialCleanup);
    }
  });

  test('keeps warm and cold results equivalent and performs an actual cold fallback after warm invalidation', () => {
    const coldStore = makeStore();
    const warmStore = makeStore();
    const cold = produceRecursiveInputResult({
      store: coldStore,
      context: context('cold-attempt'),
      producer: 'cold-producer',
      facts: readyFacts('cold'),
    });
    const warm = produceRecursiveInputResult({
      store: warmStore,
      context: context('warm-attempt'),
      producer: 'warm-producer',
      facts: readyFacts('warm'),
    });

    expect(cold.ok).toBe(true);
    expect(warm.ok).toBe(true);
    expect(warm.result.content.inputDigest).toBe(cold.result.content.inputDigest);
    expect(warm.result.content.requestedInputClasses).toEqual(cold.result.content.requestedInputClasses);
    expect(warm.result.readiness).toEqual(cold.result.readiness);
    expect(verifyCurrentReady({ store: warmStore, context: context('warm-attempt') }).ok).toBe(true);

    const invalidatedStore = makeStore();
    const invalidated = produceRecursiveInputResult({
      store: invalidatedStore,
      context: context('warm-invalidated'),
      producer: 'warm-producer',
      facts: {
        ...readyFacts('warm'),
        warm: { mode: 'warm', verified: false },
      },
    });
    expect(invalidated.ok).toBe(false);
    expect(invalidated.result.status).toBe('non-ready');
    if (invalidated.result.status === 'non-ready') {
      expect(invalidated.result.failure.code).toBe('recursive-input.result-not-ready');
      expect(invalidated.result.failure.recoveryActions).toEqual(['discard-result', 'produce-in-current-context']);
    }
    expect(readCurrentReady(invalidatedStore)).toBeNull();

    const coldRetry = produceRecursiveInputResult({
      store: invalidatedStore,
      context: context('cold-retry'),
      producer: 'cold-producer',
      facts: readyFacts('cold'),
    });
    expect(coldRetry.ok).toBe(true);
    expect(coldRetry.result.content.inputDigest).toBe(invalidated.result.content.inputDigest);
    expect(coldRetry.result.readiness).toEqual(cold.result.readiness);
    expect(verifyCurrentReady({ store: invalidatedStore, context: context('cold-retry') }).ok).toBe(true);
    expect(readAttemptResult(invalidatedStore, 'warm-invalidated')?.status).toBe('non-ready');
    expect(readAttemptResult(invalidatedStore, 'cold-retry')?.status).toBe('ready');
  });

  test('re-runs the full declared input set after a digest fault without promoting the bad result', () => {
    const store = makeStore();
    const valid = readyResult('digest-good');
    const corrupted = {
      ...valid,
      content: { ...valid.content, inputDigest: '0'.repeat(64) },
    } satisfies RecursiveInputResult;

    const failed = publishRecursiveInputResult({
      store,
      context: context('digest-bad'),
      result: corrupted,
    });
    expect(failed.ok).toBe(false);
    expect(failed.result.status).toBe('non-ready');
    if (failed.result.status === 'non-ready') {
      expect(failed.result.failure.code).toBe('recursive-input.digest-mismatch');
      expect(failed.result.failure.recoveryActions).toEqual(['discard-result', 'produce-in-current-context']);
    }
    expect(readCurrentReady(store)).toBeNull();

    const recovered = produceRecursiveInputResult({
      store,
      context: context('digest-recovered'),
      producer: 'final-recovery-producer',
      facts: readyFacts('cold'),
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.result.content.inputDigest).toBe(valid.content.inputDigest);
    expect(recovered.result.content.requestedInputClasses).toEqual([...requestedInputClasses]);
    expect(recovered.result.readiness.source.status).toBe('ready');
    expect(recovered.result.readiness.toolchain.status).toBe('ready');
    expect(verifyCurrentReady({ store, context: context('digest-recovered') }).ok).toBe(true);
    expect(readdirSync(store.attemptsDirectory).sort()).toEqual(['digest-bad.json', 'digest-recovered.json']);
  });
});
