import { describe, expect, test } from 'bun:test';
import { isRecursiveInputResult, type RecursiveInputResult } from './schema.ts';

const readyResult = (): RecursiveInputResult => ({
  schemaVersion: 1,
  status: 'ready',
  content: {
    sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
    recursivePins: [],
    requestedInputClasses: ['source', 'toolchain'],
    inputDigest: 'a'.repeat(64),
    digestAlgorithm: 'sha256',
  },
  provenance: {
    producer: 'test-producer',
    job: 'test-job',
    attempt: 'attempt-1',
    trustScope: 'ordinary-ci',
    checkoutIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
    credentialCleanup: { status: 'passed' },
  },
  readiness: {
    source: { status: 'ready' },
    'dependency-installation': { status: 'not-requested' },
    toolchain: { status: 'ready' },
    'large-file-storage': { status: 'not-requested' },
    'build-output': { status: 'not-requested' },
  },
});

describe('recursive input result rejection matrix', () => {
  test('rejects missing required fields instead of treating partial JSON as ready', () => {
    const result = readyResult() as unknown as Record<string, unknown>;
    delete result.provenance;
    expect(isRecursiveInputResult(result)).toBe(false);
  });

  test('rejects unknown schema versions', () => {
    const result = readyResult() as unknown as Record<string, unknown>;
    result.schemaVersion = 99;
    expect(isRecursiveInputResult(result)).toBe(false);
  });

  test('rejects an input class outside the declared registry', () => {
    const result = readyResult() as unknown as {
      content: { requestedInputClasses: unknown[] };
    };
    result.content.requestedInputClasses = ['source', 'dependency-cache'];
    expect(isRecursiveInputResult(result)).toBe(false);
  });

  test('rejects a non-ready result without a structured failure envelope', () => {
    const result = readyResult() as unknown as Record<string, unknown>;
    result.status = 'non-ready';
    expect(isRecursiveInputResult(result)).toBe(false);
  });

  test('accepts a non-ready result only with machine-readable recovery fields', () => {
    const result = readyResult() as unknown as Record<string, unknown>;
    result.status = 'non-ready';
    (result.readiness as { toolchain: { status: string } }).toolchain.status = 'stale';
    result.failure = {
      code: 'recursive-input.missing-pin',
      hint: 'Materialize the complete recursive graph before consuming source.',
      expected: 'packages/editor/packages/engine',
      actual: 'missing',
      retryable: true,
      recoveryActions: ['discard-partial-state', 'retry-cold'],
    };
    expect(isRecursiveInputResult(result)).toBe(true);
  });

  test('rejects a ready result whose requested class is not ready', () => {
    const result = readyResult() as unknown as {
      readiness: { toolchain: { status: string } };
    };
    result.readiness.toolchain.status = 'stale';
    expect(isRecursiveInputResult(result)).toBe(false);
  });
});
