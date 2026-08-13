import { computeInputDigest } from './digest.ts';
import {
  CI_OUTPUT_CONTRACT_VERSION,
  ciFailureRecovery,
  loadCiContractFiles,
  producerForConsumer,
  type CiConsumerDeclaration,
  type CiManifest,
  type CiTrustScope,
} from './ci-contract.ts';
import type { ProjectedGitGraph } from './git-graph.ts';
import {
  INPUT_CLASSES,
  isRecursiveInputResult,
  type InputClass,
  type InputReadiness,
  type RecursiveInputFailure,
  type RecursiveInputCiBinding,
  type RecursiveInputProvenance,
  type RecursiveInputResult,
  type ReadinessByClass,
  type TrustScope,
  type RecursiveInputCiProvenance,
} from './schema.ts';

export type RecursiveInputValidationContext = {
  graph: ProjectedGitGraph;
  requestedInputClasses: readonly InputClass[];
  trustScope: TrustScope;
  job: string;
  attempt: string;
};

export type RecursiveInputValidation = {
  ok: true;
  result: Extract<RecursiveInputResult, { status: 'ready' }>;
} | {
  ok: false;
  result: Extract<RecursiveInputResult, { status: 'non-ready' }>;
};

export type RecursiveInputResultDraft = RecursiveInputValidationContext & {
  producer: string;
  ci?: RecursiveInputCiBinding;
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
): Extract<RecursiveInputResult, { status: 'non-ready' }> {
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
    ...(draft.ci ? { ci: draft.ci } : {}),
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
  return {
    schemaVersion: 1,
    status: 'ready',
    content,
    provenance,
    readiness,
    ...(draft.ci ? { ci: draft.ci } : {}),
  };
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

export type CiExecutionContext = {
  consumerId: string;
  graph: ProjectedGitGraph;
  requestedInputClasses: readonly InputClass[];
  producerId: string;
  outputContractVersion: string;
  repository: string;
  revision: string;
  run: string;
  attempt: string;
  job: string;
  trustScope: CiTrustScope;
  inputProvenance: RecursiveInputCiProvenance;
};

export type CiRecoveryAction = {
  actionId: string;
  argv?: string[];
  manualHandoff?: string;
};

export type CiValidationEnvelope = {
  operation: 'verify';
  scope: 'ci';
  status: 'ready' | 'non-ready';
  code: string;
  hint: string;
  expected: string;
  actual: string;
  consumerId: string;
  producerId: string;
  outputContractVersion: string;
  expectedIdentity: Record<string, unknown>;
  observedIdentity: Record<string, unknown>;
  sourceWork: { status: 'allowed' | 'suppressed' };
  suppressionCode?: 'recursive-input.consumer-work-suppressed';
  recoveryActions: CiRecoveryAction[];
};

export type CiValidation = {
  ok: boolean;
  result: RecursiveInputResult;
  envelope: CiValidationEnvelope;
};

function ciBindingFor(context: CiExecutionContext): RecursiveInputCiBinding {
  return {
    producerId: context.producerId,
    outputContractVersion: context.outputContractVersion,
    repository: context.repository,
    revision: context.revision,
    run: context.run,
    attempt: context.attempt,
    job: context.job,
    trustScope: context.trustScope,
    inputProvenance: { ...context.inputProvenance },
  };
}

function ciRejectedResult(candidate: unknown, context: CiExecutionContext, failure: RecursiveInputFailure): RecursiveInputResult {
  if (isRecursiveInputResult(candidate)) {
    const readiness = { ...candidate.readiness };
    const requested = candidate.content.requestedInputClasses[0];
    if (requested) readiness[requested] = { status: 'unavailable' };
    return {
      ...candidate,
      status: 'non-ready',
      readiness,
      failure,
    };
  }
  return createRecursiveInputResult({
    graph: context.graph,
    requestedInputClasses: context.requestedInputClasses,
    trustScope: context.trustScope,
    job: context.job,
    attempt: context.attempt,
    producer: 'recursive-input-ci-validator',
    ci: ciBindingFor(context),
    failure,
  });
}

function ciFailure(
  code: string,
  expected: string,
  actual: string,
  context: CiExecutionContext,
  candidate: unknown,
  retryable = false,
): CiValidation {
  const failure: RecursiveInputFailure = {
    code: `recursive-input.${code}`,
    hint: 'Discard the candidate and materialize the declared producer output for the current execution before source work.',
    expected,
    actual,
    retryable,
    recoveryActions: ciFailureRecovery(code).map((action) => action.actionId),
  };
  const result = ciRejectedResult(candidate, context, failure);
  const observed = isRecursiveInputResult(candidate) && candidate.ci ? candidate.ci : {};
  return {
    ok: false,
    result,
    envelope: {
      operation: 'verify',
      scope: 'ci',
      status: 'non-ready',
      code: failure.code,
      hint: failure.hint,
      expected,
      actual,
      consumerId: context.consumerId,
      producerId: context.producerId,
      outputContractVersion: context.outputContractVersion,
      expectedIdentity: { ...ciBindingFor(context) },
      observedIdentity: observed as Record<string, unknown>,
      sourceWork: { status: 'suppressed' },
      suppressionCode: 'recursive-input.consumer-work-suppressed',
      recoveryActions: ciFailureRecovery(code),
    },
  };
}

function sameCiProvenance(left: RecursiveInputCiProvenance, right: RecursiveInputCiProvenance): boolean {
  return left.producerId === right.producerId
    && left.outputContractVersion === right.outputContractVersion
    && left.repository === right.repository
    && left.revision === right.revision
    && left.inputDigest === right.inputDigest;
}

function ciMismatch(
  field: string,
  expected: string,
  actual: string,
  context: CiExecutionContext,
  candidate: unknown,
): CiValidation {
  return ciFailure(`${field}-mismatch`, expected, actual, context, candidate);
}

export function validateCiResult(
  candidate: unknown,
  context: CiExecutionContext,
  manifest: CiManifest = loadCiContractFiles().manifest,
): CiValidation {
  const declared = producerForConsumer(manifest, context.consumerId);
  if (!declared) return ciFailure('unknown-consumer', context.consumerId, 'undeclared consumer', context, candidate);
  if (declared.consumer.producerId !== context.producerId) return ciMismatch('producer', declared.consumer.producerId, context.producerId, context, candidate);
  if (!declared.producer.trustScopes.includes(context.trustScope)) return ciFailure('trust-scope-unsupported', declared.producer.trustScopes.join(','), context.trustScope, context, candidate);
  if (declared.producer.outputContractVersion !== context.outputContractVersion || context.outputContractVersion !== CI_OUTPUT_CONTRACT_VERSION) {
    return ciMismatch('output-contract-version', declared.producer.outputContractVersion, context.outputContractVersion, context, candidate);
  }
  if (!isRecursiveInputResult(candidate) || !candidate.ci) return ciFailure('schema-invalid', 'schema-valid CI result with ci binding', 'missing or malformed ci binding', context, candidate);
  const binding = candidate.ci;
  const dimensions: Array<[string, string, string]> = [
    ['producer', context.producerId, binding.producerId],
    ['output-contract-version', context.outputContractVersion, binding.outputContractVersion],
    ['repository', context.repository, binding.repository],
    ['revision', context.revision, binding.revision],
    ['run', context.run, binding.run],
    ['attempt', context.attempt, binding.attempt],
    ['job', context.job, binding.job],
    ['trust-scope', context.trustScope, binding.trustScope],
  ];
  for (const [field, expected, actual] of dimensions) {
    if (expected !== actual) return ciMismatch(field, expected, actual, context, candidate);
  }
  if (candidate.content.sourceIdentity.repository !== context.repository) return ciMismatch('repository', context.repository, candidate.content.sourceIdentity.repository, context, candidate);
  if (candidate.content.sourceIdentity.revision !== context.revision) return ciMismatch('revision', context.revision, candidate.content.sourceIdentity.revision, context, candidate);
  if (!sameCiProvenance(binding.inputProvenance, context.inputProvenance)) {
    return ciMismatch('input-provenance', JSON.stringify(context.inputProvenance), JSON.stringify(binding.inputProvenance), context, candidate);
  }
  if (binding.inputProvenance.inputDigest !== candidate.content.inputDigest) return ciMismatch('input-provenance', context.inputProvenance.inputDigest, binding.inputProvenance.inputDigest, context, candidate);

  const semantic = validateRecursiveInputResult(candidate, {
    graph: context.graph,
    requestedInputClasses: context.requestedInputClasses,
    trustScope: context.trustScope,
    job: context.job,
    attempt: context.attempt,
  });
  if (!semantic.ok) {
    const failure = semantic.result.status === 'non-ready' ? semantic.result.failure : undefined;
    return ciFailure(
      failure?.code.replace(/^recursive-input\./, '') ?? 'result-not-ready',
      failure?.expected ?? 'ready result',
      failure?.actual ?? 'non-ready',
      context,
      candidate,
      failure?.retryable,
    );
  }
  return {
    ok: true,
    result: candidate,
    envelope: {
      operation: 'verify',
      scope: 'ci',
      status: 'ready',
      code: 'recursive-input.ready',
      hint: 'The producer result matches the complete current execution identity.',
      expected: 'current declared CI execution',
      actual: 'matching producer result',
      consumerId: context.consumerId,
      producerId: context.producerId,
      outputContractVersion: context.outputContractVersion,
      expectedIdentity: { ...ciBindingFor(context) },
      observedIdentity: { ...binding },
      sourceWork: { status: 'allowed' },
      recoveryActions: [],
    },
  };
}

export type CiConsumerExecution<T> = CiValidation & { value?: T };

export function runCiConsumer<T>(candidate: unknown, context: CiExecutionContext, work: () => T, manifest?: CiManifest): CiConsumerExecution<T> {
  const validation = validateCiResult(candidate, context, manifest);
  if (!validation.ok) {
    return validation;
  }
  return { ...validation, value: work() };
}
