import { computeInputDigest } from './digest.ts';
import type { ProjectedGitGraph } from './git-graph.ts';
import {
  INPUT_CLASSES,
  isRecursiveInputResult,
  type InputClass,
  type InputReadiness,
  type RecursiveInputFailure,
  type RecursiveInputProvenance,
  type RecursiveInputResult,
  type ReadinessByClass,
  type TrustScope,
} from './schema.ts';

export type RecursiveInputValidationContext = {
  graph: ProjectedGitGraph;
  requestedInputClasses: readonly InputClass[];
  trustScope: TrustScope;
  job: string;
  attempt: string;
};

export type RecursiveInputValidation = {
  ok: boolean;
  result: RecursiveInputResult;
};

export type RecursiveInputResultDraft = RecursiveInputValidationContext & {
  producer: string;
  readiness?: Partial<ReadinessByClass>;
  credentialCleanup?: RecursiveInputProvenance['credentialCleanup'];
  failure?: RecursiveInputFailure;
};

function readinessFor(
  requestedInputClasses: readonly InputClass[],
  overrides: Partial<ReadinessByClass> | undefined,
): ReadinessByClass {
  const requested = new Set(requestedInputClasses);
  return Object.fromEntries(
    INPUT_CLASSES.map((inputClass) => [
      inputClass,
      overrides?.[inputClass] ?? { status: requested.has(inputClass) ? 'ready' : 'not-requested' },
    ]),
  ) as ReadinessByClass;
}

function allRequestedReady(
  requestedInputClasses: readonly InputClass[],
  readiness: ReadinessByClass,
): boolean {
  return requestedInputClasses.every((inputClass) => readiness[inputClass].status === 'ready');
}

function failureFor(code: string, expected: string, actual: string, retryable = false): RecursiveInputFailure {
  return {
    code: `recursive-input.${code}`,
    hint: 'Recreate the complete recursive input result before consuming source.',
    expected,
    actual,
    retryable,
    recoveryActions: retryable
      ? ['discard-partial-state', 'retry-cold']
      : ['discard-result', 'produce-in-current-context'],
  };
}

function withFailure(
  draft: RecursiveInputResultDraft,
  failure: RecursiveInputFailure,
): RecursiveInputResult {
  const readiness = readinessFor(draft.requestedInputClasses, draft.readiness);
  const firstRequested = draft.requestedInputClasses[0];
  if (firstRequested && allRequestedReady(draft.requestedInputClasses, readiness)) {
    readiness[firstRequested] = { status: 'unavailable' };
  }
  const content = {
    sourceIdentity: draft.graph.sourceIdentity,
    recursivePins: draft.graph.pins.map((pin) => ({ ...pin })),
    requestedInputClasses: [...draft.requestedInputClasses],
    inputDigest: computeInputDigest({
      sourceIdentity: draft.graph.sourceIdentity,
      recursivePins: draft.graph.pins,
      requestedInputClasses: draft.requestedInputClasses,
    }),
    digestAlgorithm: 'sha256' as const,
  };
  return {
    schemaVersion: 1,
    status: 'non-ready',
    content,
    provenance: {
      producer: draft.producer,
      job: draft.job,
      attempt: draft.attempt,
      trustScope: draft.trustScope,
      checkoutIdentity: draft.graph.sourceIdentity,
      credentialCleanup: draft.credentialCleanup ?? { status: 'passed' },
    },
    readiness,
    failure,
  };
}

export function createRecursiveInputResult(draft: RecursiveInputResultDraft): RecursiveInputResult {
  const readiness = readinessFor(draft.requestedInputClasses, draft.readiness);
  const content = {
    sourceIdentity: draft.graph.sourceIdentity,
    recursivePins: draft.graph.pins.map((pin) => ({ ...pin })),
    requestedInputClasses: [...draft.requestedInputClasses],
    inputDigest: computeInputDigest({
      sourceIdentity: draft.graph.sourceIdentity,
      recursivePins: draft.graph.pins,
      requestedInputClasses: draft.requestedInputClasses,
    }),
    digestAlgorithm: 'sha256' as const,
  };
  const provenance = {
    producer: draft.producer,
    job: draft.job,
    attempt: draft.attempt,
    trustScope: draft.trustScope,
    checkoutIdentity: draft.graph.sourceIdentity,
    credentialCleanup: draft.credentialCleanup ?? { status: 'passed' as const },
  };
  if (draft.failure || !allRequestedReady(draft.requestedInputClasses, readiness) || provenance.credentialCleanup.status !== 'passed') {
    return withFailure(draft, draft.failure ?? failureFor('inputs-not-ready', 'all requested classes ready', 'one or more classes not ready', true));
  }
  return { schemaVersion: 1, status: 'ready', content, provenance, readiness };
}

function sameIdentity(left: { repository: string; revision: string }, right: { repository: string; revision: string }): boolean {
  return left.repository === right.repository && left.revision === right.revision;
}

function sameClassSet(left: readonly InputClass[], right: readonly InputClass[]): boolean {
  return left.length === right.length && [...left].sort().every((inputClass, index) => inputClass === [...right].sort()[index]);
}

export function validateRecursiveInputResult(
  candidate: unknown,
  context: RecursiveInputValidationContext,
): RecursiveInputValidation {
  const fallback = (failure: RecursiveInputFailure, retryable = false): RecursiveInputValidation => ({
    ok: false,
    result: withFailure({ ...context, producer: 'validator', failure: undefined }, {
      ...failure,
      retryable: retryable || failure.retryable,
    }),
  });

  if (!isRecursiveInputResult(candidate)) {
    return fallback(failureFor('schema-invalid', 'schema-valid recursive input result', 'invalid result shape'));
  }
  if (!sameIdentity(candidate.content.sourceIdentity, context.graph.sourceIdentity)
    || !sameIdentity(candidate.provenance.checkoutIdentity, context.graph.sourceIdentity)) {
    return fallback(failureFor('source-identity-mismatch', context.graph.sourceIdentity.revision, candidate.content.sourceIdentity.revision));
  }
  if (!sameClassSet(candidate.content.requestedInputClasses, context.requestedInputClasses)) {
    return fallback(failureFor('input-class-mismatch', context.requestedInputClasses.join(','), candidate.content.requestedInputClasses.join(',')));
  }
  if (context.graph.unreachablePaths.length > 0) {
    return fallback(failureFor('pin-unreachable', 'all graph pins reachable', context.graph.unreachablePaths.join(','), true), true);
  }

  const expectedByPath = new Map(context.graph.pins.map((pin) => [pin.path, pin.pin]));
  const actualByPath = new Map(candidate.content.recursivePins.map((pin) => [pin.path, pin.pin]));
  if (actualByPath.size !== expectedByPath.size || [...expectedByPath.keys()].some((path) => !actualByPath.has(path))) {
    return fallback(failureFor('graph-incomplete', [...expectedByPath.keys()].join(','), [...actualByPath.keys()].join(','), true), true);
  }
  const mismatch = [...expectedByPath].find(([path, pin]) => actualByPath.get(path) !== pin);
  if (mismatch) {
    return fallback(failureFor('pin-mismatch', `${mismatch[0]}=${mismatch[1]}`, `${mismatch[0]}=${actualByPath.get(mismatch[0])}`));
  }
  const expectedDigest = computeInputDigest({
    sourceIdentity: candidate.content.sourceIdentity,
    recursivePins: candidate.content.recursivePins,
    requestedInputClasses: candidate.content.requestedInputClasses,
  });
  if (candidate.content.inputDigest !== expectedDigest) {
    return fallback(failureFor('digest-mismatch', expectedDigest, candidate.content.inputDigest));
  }
  if (candidate.provenance.job !== context.job || candidate.provenance.attempt !== context.attempt) {
    return fallback(failureFor('attempt-mismatch', `${context.job}/${context.attempt}`, `${candidate.provenance.job}/${candidate.provenance.attempt}`));
  }
  if (candidate.provenance.trustScope !== context.trustScope) {
    return fallback(failureFor('trust-scope-mismatch', context.trustScope, candidate.provenance.trustScope));
  }
  if (candidate.provenance.credentialCleanup.status !== 'passed') {
    return fallback(failureFor('credential-cleanup-failed', 'passed', candidate.provenance.credentialCleanup.status, true), true);
  }
  if (candidate.status !== 'ready' || !allRequestedReady(context.requestedInputClasses, candidate.readiness)) {
    return fallback(failureFor('result-not-ready', 'ready', candidate.status));
  }
  return { ok: true, result: candidate };
}
