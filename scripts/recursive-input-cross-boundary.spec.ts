import { describe, expect, test } from 'bun:test';
import { executeRecursiveInputCli, type RecursiveInputCliDependencies } from '../packages/recursive-input-contract/src/cli.ts';
import { isRecursiveInputResult, type ProjectedGitGraph, type RecursiveInputResult, type TrustScope } from '../packages/recursive-input-contract/src/index.ts';

const graph: ProjectedGitGraph = {
  sourceIdentity: { repository: 'forgeax-studio', revision: 'cli-matrix-root' },
  pins: [{ path: 'packages/editor', pin: 'editor-pin' }],
  unreachablePaths: [],
};
const scopes = ['local-fixed-worktree', 'ordinary-ci', 'trusted-base-ci'] as const;
const attempt = 'cli-matrix-current';

type MatrixEvidence = {
  caseId: string;
  trustScope: TrustScope;
  observed: string;
  verdict: 'pass' | 'reject';
  confidence: 'high';
};

function fixture(readResult: () => unknown, writeResult?: (result: RecursiveInputResult) => void): RecursiveInputCliDependencies {
  return { root: '/tmp/recursive-input-cross-boundary-cli', readGraph: () => graph, readResult, writeResult };
}

function parse(stdout: string): RecursiveInputResult {
  const result: unknown = JSON.parse(stdout);
  expect(isRecursiveInputResult(result)).toBe(true);
  return result as RecursiveInputResult;
}

describe('recursive input CLI cross-boundary matrix', () => {
  test('runs materialize → verify → status/schema → consumer for local, ordinary, and trusted scopes', () => {
    const evidence: MatrixEvidence[] = [];
    for (const trustScope of scopes) {
      let stored: unknown = null;
      const dependencies = fixture(() => stored, (result) => { stored = result; });
      const args = ['--classes=source', `--trust=${trustScope}`, '--job=cli-matrix-consumer', `--attempt=${attempt}`];
      const materialized = executeRecursiveInputCli(['materialize', ...args], dependencies);
      expect(materialized.exitCode).toBe(0);
      const materializedResult = parse(materialized.stdout);
      expect(materializedResult.status).toBe('ready');
      expect(materializedResult.provenance.trustScope).toBe(trustScope);
      expect(materializedResult.readiness.source.status).toBe('ready');
      expect(materializedResult.readiness['build-output'].status).toBe('not-requested');

      const verified = executeRecursiveInputCli(['verify', ...args], dependencies);
      expect(verified.exitCode).toBe(0);
      const verifiedResult = parse(verified.stdout);
      expect(verifiedResult.provenance.attempt).toBe(attempt);

      const status = executeRecursiveInputCli(['status', ...args], dependencies);
      expect(status.exitCode).toBe(0);
      expect(parse(status.stdout).status).toBe('ready');

      const schema = executeRecursiveInputCli(['schema'], dependencies);
      expect(schema.exitCode).toBe(0);
      const schemaResult = JSON.parse(schema.stdout) as { trustScopes: string[]; inputClasses: string[] };
      expect(schemaResult.trustScopes).toEqual(expect.arrayContaining(scopes));
      expect(schemaResult.inputClasses).toContain('source');
      evidence.push({ caseId: `cli-current-${trustScope}`, trustScope, observed: `materialize=${materializedResult.status}; verify=${verifiedResult.status}; status=${parse(status.stdout).status}`, verdict: 'pass', confidence: 'high' });
    }
    expect(evidence).toHaveLength(scopes.length);
    expect(evidence.every((item) => item.observed && item.verdict === 'pass' && item.confidence === 'high')).toBe(true);
  });

  test('rejects a stale attempt and requested class drift before the consumer', () => {
    let stored: unknown = null;
    const ordinary = executeRecursiveInputCli(['materialize', '--classes=source', '--trust=ordinary-ci', '--job=cli-matrix-consumer', '--attempt=attempt-old'], fixture(() => stored, (result) => { stored = result; }));
    expect(ordinary.exitCode).toBe(0);
    const stale = parse(ordinary.stdout);
    const dependencies = fixture(() => stale);

    const staleCheck = executeRecursiveInputCli(['verify', '--classes=source', '--trust=ordinary-ci', '--job=cli-matrix-consumer', `--attempt=${attempt}`], dependencies);
    expect(staleCheck.exitCode).toBe(3);
    const staleResult = parse(staleCheck.stdout);
    expect(staleResult.status).toBe('non-ready');
    if (staleResult.status === 'non-ready') expect(staleResult.failure.code).toBe('recursive-input.attempt-mismatch');

    const classDrift = executeRecursiveInputCli(['verify', '--classes=source,build-output', '--trust=ordinary-ci', '--job=cli-matrix-consumer', '--attempt=attempt-old'], dependencies);
    expect(classDrift.exitCode).toBe(3);
    const classDriftResult = parse(classDrift.stdout);
    expect(classDriftResult.status).toBe('non-ready');
    if (classDriftResult.status === 'non-ready') expect(classDriftResult.failure.code).toBe('recursive-input.input-class-mismatch');

    const evidence: MatrixEvidence[] = [
      { caseId: 'cli-stale-attempt', trustScope: 'ordinary-ci', observed: staleResult.status === 'non-ready' ? staleResult.failure.code : staleResult.status, verdict: 'reject', confidence: 'high' },
      { caseId: 'cli-class-drift', trustScope: 'ordinary-ci', observed: classDriftResult.status === 'non-ready' ? classDriftResult.failure.code : classDriftResult.status, verdict: 'reject', confidence: 'high' },
    ];
    expect(evidence.every((item) => item.observed.startsWith('recursive-input.') && item.verdict === 'reject' && item.confidence === 'high')).toBe(true);
  });
});
