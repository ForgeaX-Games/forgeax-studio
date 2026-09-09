import { describe, expect, test } from 'bun:test';
import { releaseIntegrityError } from './errors.ts';
import { resultFromReleaseIntegrityError } from './result.ts';

const matrix = [
  ['candidate mismatch', 'candidate-mismatch', 'candidate-binding', false, 'read-only-reconcile'],
  ['critical input unknown', 'critical-input-unverified', 'critical-inputs', false, 'pin-critical-input'],
  ['duplicate publisher', 'duplicate-publisher', 'trust-dag', false, 'repair-trust-dag'],
  ['permission drift', 'permission-expanded', 'permission-boundary', false, 'refresh-permission-observation'],
  ['mutation before gate', 'mutation-before-gate', 'mutation-order', false, 'complete-preconditions'],
  ['partial outcome', 'partial-outcome', 'external-observation', true, 'reconcile-same-candidate'],
  ['unknown outcome', 'external-outcome-unknown', 'external-observation', false, 'handoff-external-observation'],
] as const;

describe('release integrity recovery matrix', () => {
  test.each(matrix)('exposes structured recovery for %s', (_name, code, gate, retryable, action) => {
    const error = releaseIntegrityError(code, gate, 'expected-value', 'actual-value', {
      candidateId: 'candidate-1',
      subjectId: 'subject-1',
      target: 'target-1',
      retryable,
      recoveryActions: [action],
    });
    const result = resultFromReleaseIntegrityError(error, 'candidate-1');

    expect(error.code).toBe(`release-integrity.${code}`);
    expect(error.gate).toBe(gate);
    expect(error.expected).toBe('expected-value');
    expect(error.actual).toBe('actual-value');
    expect(error.candidateId).toBe('candidate-1');
    expect(error.subjectId).toBe('subject-1');
    expect(error.target).toBe('target-1');
    expect(error.retryable).toBe(retryable);
    expect(error.recoveryActions).toContain(action);
    expect(result.sourceWork.status).toBe('suppressed');
    expect(result.recoveryActions).toContain(action);
    expect('mutationPlan' in result).toBe(false);
  });

  test('keeps unknown evidence unverified and does not turn it into an automatic retry', () => {
    const error = releaseIntegrityError('critical-input-unverified', 'critical-inputs', 'resolved identity', 'unknown', {
      status: 'unverified',
      retryable: false,
      recoveryActions: ['pin-critical-input', 'handoff-missing-evidence'],
    });
    const result = resultFromReleaseIntegrityError(error);

    expect(result.status).toBe('unverified');
    expect(result.contentIntegrity.status).toBe('unverified');
    expect(error.retryable).toBe(false);
    expect(error.recoveryActions).toContain('handoff-missing-evidence');
  });
});
