import { describe, expect, test } from 'bun:test';
import { computeInputDigest } from './digest.ts';
import { projectGitlinkGraph, type AuthoritativeGitGraph } from './git-graph.ts';
import {
  isRecursiveInputResult,
  type InputClass,
  type RecursiveInputResult,
} from './schema.ts';
import {
  validateRecursiveInputResult,
  type RecursiveInputValidationContext,
} from './validator.ts';

const graph: AuthoritativeGitGraph = {
  sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
  nodes: [{
    path: 'packages/editor',
    pin: 'editor-a',
    children: [{ path: 'packages/editor/packages/engine', pin: 'engine-a' }],
  }],
};
const projected = projectGitlinkGraph(graph);
const requestedInputClasses: InputClass[] = ['source', 'toolchain'];

function readyResult(): RecursiveInputResult {
  return {
    schemaVersion: 1,
    status: 'ready',
    content: {
      sourceIdentity: graph.sourceIdentity,
      recursivePins: projected.pins.map((pin) => ({ ...pin })),
      requestedInputClasses,
      inputDigest: computeInputDigest({
        sourceIdentity: graph.sourceIdentity,
        recursivePins: projected.pins,
        requestedInputClasses,
      }),
      digestAlgorithm: 'sha256',
    },
    provenance: {
      producer: 'test-producer',
      job: 'test-job',
      attempt: 'attempt-1',
      trustScope: 'ordinary-ci',
      checkoutIdentity: graph.sourceIdentity,
      credentialCleanup: { status: 'passed' },
    },
    readiness: {
      source: { status: 'ready' },
      'dependency-installation': { status: 'not-requested' },
      toolchain: { status: 'ready' },
      'large-file-storage': { status: 'not-requested' },
      'build-output': { status: 'not-requested' },
    },
  };
}

function context(overrides: Partial<RecursiveInputValidationContext> = {}): RecursiveInputValidationContext {
  return {
    graph: projected,
    requestedInputClasses,
    trustScope: 'ordinary-ci',
    job: 'test-job',
    attempt: 'attempt-1',
    ...overrides,
  };
}

function expectRejected(result: RecursiveInputResult, validationContext: RecursiveInputValidationContext, code: string): void {
  const outcome = validateRecursiveInputResult(result, validationContext);
  expect(outcome.ok).toBe(false);
  expect(outcome.result.status).toBe('non-ready');
  expect(isRecursiveInputResult(outcome.result)).toBe(true);
  if (outcome.result.status === 'non-ready') {
    expect(outcome.result.failure.code).toBe(code);
    expect(outcome.result.failure.hint).toEqual(expect.any(String));
    expect(outcome.result.failure.expected).toEqual(expect.any(String));
    expect(outcome.result.failure.actual).toEqual(expect.any(String));
    expect(outcome.result.failure.retryable).toEqual(expect.any(Boolean));
    expect(outcome.result.failure.recoveryActions.length).toBeGreaterThan(0);
  }
}

describe('recursive input semantic validator', () => {
  test('accepts a complete nested graph and rejects a missing deep pin', () => {
    const result = readyResult();
    const missing = { ...result, content: { ...result.content, recursivePins: [result.content.recursivePins[0]!] } };
    expect(validateRecursiveInputResult(result, context()).ok).toBe(true);
    expectRejected(missing, context(), 'recursive-input.graph-incomplete');
  });

  test('rejects wrong pin, unreachable pin, and digest identity', () => {
    const wrongPin = readyResult();
    wrongPin.content.recursivePins[1] = { path: 'packages/editor/packages/engine', pin: 'engine-wrong' };
    expectRejected(wrongPin, context(), 'recursive-input.pin-mismatch');

    const unreachable = readyResult();
    expectRejected(
      unreachable,
      context({ graph: { ...projected, unreachablePaths: ['packages/editor/packages/engine'] } }),
      'recursive-input.pin-unreachable',
    );

    const wrongDigest = readyResult();
    wrongDigest.content.inputDigest = 'b'.repeat(64);
    expectRejected(wrongDigest, context(), 'recursive-input.digest-mismatch');
  });

  test('rejects wrong attempt, trust scope, missing class, and build-output mixing', () => {
    const wrongAttempt = readyResult();
    wrongAttempt.provenance.attempt = 'attempt-old';
    expectRejected(wrongAttempt, context(), 'recursive-input.attempt-mismatch');

    const wrongTrust = readyResult();
    wrongTrust.provenance.trustScope = 'trusted-base-ci';
    expectRejected(wrongTrust, context(), 'recursive-input.trust-scope-mismatch');

    const missingClass = readyResult();
    missingClass.content.requestedInputClasses = ['source'];
    expectRejected(missingClass, context(), 'recursive-input.input-class-mismatch');

    const buildOutputMixed = readyResult();
    buildOutputMixed.content.requestedInputClasses = ['source', 'toolchain', 'build-output'];
    buildOutputMixed.readiness['build-output'] = { status: 'ready' };
    expectRejected(buildOutputMixed, context(), 'recursive-input.input-class-mismatch');
  });
});
