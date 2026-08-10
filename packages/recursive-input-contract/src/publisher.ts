import {
  invalidateCurrentReady,
  publishCurrentReady,
  readCurrentReady,
  writeAttemptResult,
  type AttemptStore,
} from './attempt-store.ts';
import {
  validateRecursiveInputResult,
  type RecursiveInputValidation,
  type RecursiveInputValidationContext,
} from './validator.ts';
import type { CredentialCleanup, RecursiveInputResult } from './schema.ts';

export type PublishRecursiveInputResultOptions = {
  store: AttemptStore;
  context: RecursiveInputValidationContext;
  result: RecursiveInputResult;
};

export function createCredentialCleanupFact(status: CredentialCleanup['status']): CredentialCleanup {
  return { status };
}

export function publishRecursiveInputResult(
  options: PublishRecursiveInputResultOptions,
): RecursiveInputValidation {
  invalidateCurrentReady(options.store);
  const validation = validateRecursiveInputResult(options.result, options.context);
  const storedResult = !validation.ok && options.result.status === 'non-ready'
    ? {
        ...validation.result,
        provenance: {
          ...validation.result.provenance,
          credentialCleanup: options.result.provenance.credentialCleanup,
        },
      }
    : validation.result;
  writeAttemptResult(options.store, options.context.attempt, storedResult);
  if (validation.ok) publishCurrentReady(options.store, validation.result);
  return validation;
}

export function verifyCurrentReady(options: {
  store: AttemptStore;
  context: RecursiveInputValidationContext;
}): RecursiveInputValidation {
  const candidate = readCurrentReady(options.store);
  if (!candidate) {
    return {
      ok: false,
      result: {
        schemaVersion: 1,
        status: 'non-ready',
        content: {
          sourceIdentity: options.context.graph.sourceIdentity,
          recursivePins: options.context.graph.pins.map((pin) => ({ ...pin })),
          requestedInputClasses: [...options.context.requestedInputClasses],
          inputDigest: '0'.repeat(64),
          digestAlgorithm: 'sha256',
        },
        provenance: {
          producer: 'publisher',
          job: options.context.job,
          attempt: options.context.attempt,
          trustScope: options.context.trustScope,
          checkoutIdentity: options.context.graph.sourceIdentity,
          credentialCleanup: { status: 'unknown' },
        },
        readiness: {
          source: { status: 'unknown' },
          'dependency-installation': { status: 'not-requested' },
          toolchain: { status: 'not-requested' },
          'large-file-storage': { status: 'not-requested' },
          'build-output': { status: 'not-requested' },
        },
        failure: {
          code: 'recursive-input.ready-missing',
          hint: 'Produce and verify a complete recursive input result before consuming source.',
          expected: 'current ready result',
          actual: 'ready result is absent',
          retryable: true,
          recoveryActions: ['discard-partial-state', 'retry-cold'],
        },
      },
    };
  }
  return validateRecursiveInputResult(candidate, options.context);
}
