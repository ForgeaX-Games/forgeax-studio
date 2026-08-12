import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttemptStore } from './attempt-store.ts';
import { projectGitlinkGraph, type ProjectedGitGraph } from './git-graph.ts';
import {
  publishRecursiveInputResult,
  verifyCurrentReady,
} from './publisher.ts';
import { deriveRecursiveInputJsonSchema, type RecursiveInputResult, type TrustScope } from './schema.ts';
import { createTrustedBaseInputResult } from './trust-adapter.ts';
import { createRecursiveInputResult, validateRecursiveInputResult } from './validator.ts';

const roots: string[] = [];
const scopes = ['local-fixed-worktree', 'ordinary-ci', 'trusted-base-ci'] as const;
const graph: ProjectedGitGraph = projectGitlinkGraph({
  sourceIdentity: { repository: 'forgeax-studio', revision: 'matrix-root' },
  nodes: [{
    path: 'packages/editor',
    pin: 'editor-pin',
    children: [{ path: 'packages/editor/packages/engine', pin: 'engine-pin' }],
  }],
});
const classes = ['source'] as const;

type MatrixEvidence = {
  caseId: string;
  trustScope: TrustScope;
  observed: string;
  verdict: 'pass' | 'reject';
  confidence: 'high';
};

function context(trustScope: TrustScope, attempt: string) {
  return {
    graph,
    requestedInputClasses: classes,
    trustScope,
    job: 'cross-boundary-consumer',
    attempt,
  };
}

function readyResult(trustScope: TrustScope, attempt: string): RecursiveInputResult {
  if (trustScope === 'trusted-base-ci') {
    return createTrustedBaseInputResult({
      ...context(trustScope, attempt),
      sourceAsDataRoot: '/tmp/pr-merge-tree',
      readiness: { source: { status: 'ready' } },
    }).result;
  }
  return createRecursiveInputResult({
    ...context(trustScope, attempt),
    producer: `${trustScope}-materializer`,
    readiness: { source: { status: 'ready' } },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recursive input cross-boundary acceptance matrix', () => {
  test('materialize, verify, status/schema, and consume current source input in every trust scope', () => {
    const evidence: MatrixEvidence[] = [];
    const schema = deriveRecursiveInputJsonSchema();

    for (const trustScope of scopes) {
      const attempt = `matrix-${trustScope}`;
      const candidate = readyResult(trustScope, attempt);
      const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-cross-boundary-'));
      roots.push(root);
      const store = createAttemptStore(root);
      const published = publishRecursiveInputResult({
        store,
        context: context(trustScope, attempt),
        result: candidate,
      });
      const verified = verifyCurrentReady({ store, context: context(trustScope, attempt) });

      expect(published.ok).toBe(true);
      expect(verified.ok).toBe(true);
      expect(verified.result.schemaVersion).toBe((schema.properties.schemaVersion as { const: 1 }).const);
      expect(verified.result.status).toBe('ready');
      expect(verified.result.readiness.source.status).toBe('ready');
      expect(verified.result.readiness['build-output'].status).toBe('not-requested');
      expect(verified.result.provenance.trustScope).toBe(trustScope);
      expect(verified.result.provenance.attempt).toBe(attempt);

      const consumedRevision = verified.result.content.sourceIdentity.revision;
      expect(consumedRevision).toBe('matrix-root');
      evidence.push({
        caseId: `current-${trustScope}`,
        trustScope,
        observed: `status=${verified.result.status}; source=${verified.result.readiness.source.status}; consumed=${consumedRevision}`,
        verdict: 'pass',
        confidence: 'high',
      });
    }

    expect(evidence).toHaveLength(scopes.length);
    expect(evidence.every((item) => item.observed && item.verdict && item.confidence)).toBe(true);
  });

  test('rejects cross-trust reuse, stale attempts, and undeclared build-output without blocking source-only input', () => {
    const candidate = readyResult('ordinary-ci', 'attempt-current');
    const evidence: MatrixEvidence[] = [];

    const wrongTrust = validateRecursiveInputResult(candidate, {
      ...context('trusted-base-ci', 'attempt-current'),
    });
    expect(wrongTrust.ok).toBe(false);
    if (!wrongTrust.ok) {
      expect(wrongTrust.result.failure.code).toBe('recursive-input.trust-scope-mismatch');
      evidence.push({
        caseId: 'ordinary-to-trusted-reuse',
        trustScope: 'trusted-base-ci',
        observed: wrongTrust.result.failure.code,
        verdict: 'reject',
        confidence: 'high',
      });
    }

    const wrongAttempt = validateRecursiveInputResult(candidate, context('ordinary-ci', 'attempt-stale'));
    expect(wrongAttempt.ok).toBe(false);
    if (!wrongAttempt.ok) {
      expect(wrongAttempt.result.failure.code).toBe('recursive-input.attempt-mismatch');
      evidence.push({
        caseId: 'stale-current-attempt',
        trustScope: 'ordinary-ci',
        observed: wrongAttempt.result.failure.code,
        verdict: 'reject',
        confidence: 'high',
      });
    }

    const sourceOnly = validateRecursiveInputResult(candidate, context('ordinary-ci', 'attempt-current'));
    expect(sourceOnly.ok).toBe(true);
    expect(candidate.readiness['build-output'].status).toBe('not-requested');

    const buildOutputContext = {
      ...context('ordinary-ci', 'attempt-current'),
      requestedInputClasses: ['source', 'build-output'] as const,
    };
    const undeclaredBuildOutput = validateRecursiveInputResult(candidate, buildOutputContext);
    expect(undeclaredBuildOutput.ok).toBe(false);
    if (!undeclaredBuildOutput.ok) {
      expect(undeclaredBuildOutput.result.failure.code).toBe('recursive-input.input-class-mismatch');
      evidence.push({
        caseId: 'undeclared-build-output',
        trustScope: 'ordinary-ci',
        observed: undeclaredBuildOutput.result.failure.code,
        verdict: 'reject',
        confidence: 'high',
      });
    }

    expect(evidence).toHaveLength(3);
    expect(evidence.every((item) => item.observed && item.verdict === 'reject' && item.confidence === 'high')).toBe(true);
  });
});
