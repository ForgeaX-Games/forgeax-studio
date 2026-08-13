import {
  publishRecursiveInputResult,
  type PublishRecursiveInputResultOptions,
} from './publisher.ts';
import type {
  CredentialCleanup,
  InputClass,
  InputReadiness,
  RecursiveInputFailure,
  RecursiveInputResult,
  RecursiveInputCiBinding,
  ReadinessByClass,
} from './schema.ts';
import { createRecursiveInputResult, type RecursiveInputValidation } from './validator.ts';

export type MaterializationStatus = 'ready' | 'non-ready' | 'partial' | 'cancelled';

export type WarmMaterializationFacts = {
  mode: 'cold' | 'warm';
  verified: boolean;
};

export type MaterializationFacts = {
  status: MaterializationStatus;
  credentialCleanup: CredentialCleanup;
  warm?: WarmMaterializationFacts;
  readiness?: Partial<ReadinessByClass>;
  failure?: RecursiveInputFailure;
};

export type RecursiveInputProducerOptions = Omit<PublishRecursiveInputResultOptions, 'result'> & {
  producer: string;
  facts: MaterializationFacts;
  ci?: RecursiveInputCiBinding;
};

const statusForFailure: Record<Exclude<MaterializationStatus, 'ready'>, InputReadiness['status']> = {
  'non-ready': 'partial',
  partial: 'partial',
  cancelled: 'unknown',
};

function failureForFacts(facts: MaterializationFacts): RecursiveInputFailure | undefined {
  if (facts.failure) return facts.failure;
  if (facts.warm?.mode === 'warm' && !facts.warm.verified) {
    return {
      code: 'recursive-input.warm-invalidated',
      hint: 'Invalidate the unverifiable warm state and retry the complete input request cold.',
      expected: 'verified warm identity or cold fallback',
      actual: 'warm identity could not be verified',
      retryable: true,
      recoveryActions: ['invalidate-warm', 'retry-cold'],
    };
  }
  if (facts.status === 'cancelled') {
    return {
      code: 'recursive-input.materialization-cancelled',
      hint: 'Discard the partial checkout and retry the complete input request.',
      expected: 'materialization completed and post-check passed',
      actual: 'materialization was cancelled',
      retryable: true,
      recoveryActions: ['discard-partial-state', 'retry-cold'],
    };
  }
  if (facts.credentialCleanup.status !== 'passed') {
    return {
      code: 'recursive-input.credential-cleanup-failed',
      hint: 'Remove temporary credentials before retrying the input request.',
      expected: 'credential cleanup passed',
      actual: facts.credentialCleanup.status,
      retryable: true,
      recoveryActions: ['cleanup-credentials', 'retry-cold'],
    };
  }
  if (facts.status !== 'ready') {
    return {
      code: 'recursive-input.materialization-incomplete',
      hint: 'Discard the partial checkout and retry the complete input request.',
      expected: 'materialization completed and post-check passed',
      actual: facts.status,
      retryable: true,
      recoveryActions: ['discard-partial-state', 'retry-cold'],
    };
  }
  return undefined;
}

function readinessFor(
  requested: readonly InputClass[],
  facts: MaterializationFacts,
): Partial<ReadinessByClass> {
  const fallback = facts.status === 'ready' ? 'ready' : statusForFailure[facts.status];
  const readiness = Object.fromEntries(
    requested.map((inputClass) => [inputClass, { status: fallback }]),
  ) as Partial<ReadinessByClass>;
  return { ...readiness, ...facts.readiness };
}

export function parseMaterializationFacts(input: string): MaterializationFacts {
  const values = new Map(
    input.split('\n')
      .map((line) => line.split('='))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, value] as const),
  );
  const status = values.get('materialization_status');
  const cleanup = values.get('credential_cleanup');
  const warm = values.get('warm_status');
  return {
    status: status === 'ready' || status === 'partial' || status === 'cancelled' ? status : 'non-ready',
    credentialCleanup: {
      status: cleanup === 'passed' || cleanup === 'failed' ? cleanup : 'unknown',
    },
    warm: warm === 'verified'
      ? { mode: 'warm', verified: true }
      : warm === 'unverified'
        ? { mode: 'warm', verified: false }
        : undefined,
  };
}

export function produceRecursiveInputResult(
  options: RecursiveInputProducerOptions,
): RecursiveInputValidation {
  const failure = failureForFacts(options.facts);
  const result = createRecursiveInputResult({
    ...options.context,
    producer: options.producer,
    readiness: readinessFor(options.context.requestedInputClasses, options.facts),
    credentialCleanup: options.facts.credentialCleanup,
    ci: options.ci,
    failure,
  });
  return publishRecursiveInputResult({ ...options, result });
}

export type { RecursiveInputResult };
