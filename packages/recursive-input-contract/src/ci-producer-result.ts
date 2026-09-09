export const CI_PRODUCER_RESULT_VERSION = 'forgeax-ci-producer-result.v1' as const;
export const CI_PRODUCER_RESULT_STATUSES = ['passed', 'failed', 'blocked', 'superseded'] as const;
export const CI_PRODUCER_RESULT_CATEGORIES = ['product', 'contract', 'infrastructure', 'stochastic', 'upstream'] as const;

export type CiProducerResultStatus = (typeof CI_PRODUCER_RESULT_STATUSES)[number];
export type CiProducerResultCategory = (typeof CI_PRODUCER_RESULT_CATEGORIES)[number];

export type CiProducerAttempt = {
  repository: string;
  revision: string;
  runId: string;
  runAttempt: string;
  job: string;
};

export type CiProducerResult = {
  specVersion: 1;
  resultVersion: typeof CI_PRODUCER_RESULT_VERSION;
  producerId: string;
  status: CiProducerResultStatus;
  category: CiProducerResultCategory;
  code: string;
  rootProducer: string;
  blockedBy: string[];
  safeRerun: boolean;
  attempt: CiProducerAttempt;
  timing: {
    queuedAt?: string;
    startedAt: string;
    prepareCompletedAt?: string;
    completedAt: string;
  };
  metrics: {
    queueDurationMs?: number;
    durationMs: number;
    prepareDurationMs?: number;
    runAttempt: number;
    isRerun: boolean;
  };
  evidence: {
    producers: string[];
  };
};

export type CiProducerResultValidation = {
  ok: boolean;
  errors: string[];
};

export type CreateCiProducerResultOptions = {
  producerId: string;
  status: CiProducerResultStatus;
  category: CiProducerResultCategory;
  code: string;
  rootProducer: string;
  blockedBy: string[];
  safeRerun: boolean;
  attempt: CiProducerAttempt;
  timing: {
    queuedAt?: string;
    startedAt: string;
    prepareCompletedAt?: string;
    completedAt: string;
  };
  evidenceProducers?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO timestamp`);
  return parsed;
}

export function createCiProducerResult(options: CreateCiProducerResultOptions): CiProducerResult {
  const startedAt = timestamp(options.timing.startedAt, 'timing.startedAt');
  const completedAt = timestamp(options.timing.completedAt, 'timing.completedAt');
  if (completedAt < startedAt) throw new Error('timing.completedAt must not precede timing.startedAt');
  const queuedAt = options.timing.queuedAt
    ? timestamp(options.timing.queuedAt, 'timing.queuedAt')
    : undefined;
  if (queuedAt !== undefined && queuedAt > startedAt) {
    throw new Error('timing.queuedAt must not follow timing.startedAt');
  }
  const prepareCompletedAt = options.timing.prepareCompletedAt
    ? timestamp(options.timing.prepareCompletedAt, 'timing.prepareCompletedAt')
    : undefined;
  if (prepareCompletedAt !== undefined && (prepareCompletedAt < startedAt || prepareCompletedAt > completedAt)) {
    throw new Error('timing.prepareCompletedAt must fall within the producer interval');
  }
  const runAttempt = Number(options.attempt.runAttempt);
  if (!Number.isInteger(runAttempt) || runAttempt <= 0) throw new Error('attempt.runAttempt must be a positive integer string');

  const result: CiProducerResult = {
    specVersion: 1,
    resultVersion: CI_PRODUCER_RESULT_VERSION,
    producerId: options.producerId,
    status: options.status,
    category: options.category,
    code: options.code,
    rootProducer: options.rootProducer,
    blockedBy: uniqueStrings(options.blockedBy),
    safeRerun: options.safeRerun,
    attempt: options.attempt,
    timing: {
      ...(options.timing.queuedAt ? { queuedAt: options.timing.queuedAt } : {}),
      startedAt: options.timing.startedAt,
      ...(options.timing.prepareCompletedAt ? { prepareCompletedAt: options.timing.prepareCompletedAt } : {}),
      completedAt: options.timing.completedAt,
    },
    metrics: {
      ...(queuedAt === undefined ? {} : { queueDurationMs: startedAt - queuedAt }),
      durationMs: completedAt - startedAt,
      ...(prepareCompletedAt === undefined ? {} : { prepareDurationMs: prepareCompletedAt - startedAt }),
      runAttempt,
      isRerun: runAttempt > 1,
    },
    evidence: {
      producers: uniqueStrings(options.evidenceProducers ?? [options.producerId]),
    },
  };
  const validation = validateCiProducerResult(result);
  if (!validation.ok) throw new Error(`invalid CI producer result: ${validation.errors.join('; ')}`);
  return result;
}

export function validateCiProducerResult(value: unknown): CiProducerResultValidation {
  const errors: string[] = [];
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'specVersion', 'resultVersion', 'producerId', 'status', 'category', 'code', 'rootProducer',
    'blockedBy', 'safeRerun', 'attempt', 'timing', 'metrics', 'evidence',
  ])) return { ok: false, errors: ['result must be a closed object'] };

  if (value.specVersion !== 1) errors.push('specVersion must be 1');
  if (value.resultVersion !== CI_PRODUCER_RESULT_VERSION) errors.push(`resultVersion must be ${CI_PRODUCER_RESULT_VERSION}`);
  for (const key of ['producerId', 'code', 'rootProducer']) {
    if (!nonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (!CI_PRODUCER_RESULT_STATUSES.includes(value.status as CiProducerResultStatus)) errors.push('status is unsupported');
  if (!CI_PRODUCER_RESULT_CATEGORIES.includes(value.category as CiProducerResultCategory)) errors.push('category is unsupported');
  if (!Array.isArray(value.blockedBy) || value.blockedBy.some((item) => !nonEmptyString(item))) errors.push('blockedBy must contain strings');
  if (typeof value.safeRerun !== 'boolean') errors.push('safeRerun must be boolean');

  if (!isRecord(value.attempt) || !hasOnlyKeys(value.attempt, ['repository', 'revision', 'runId', 'runAttempt', 'job'])) {
    errors.push('attempt must be a closed object');
  } else {
    for (const key of ['repository', 'revision', 'runId', 'runAttempt', 'job']) {
      if (!nonEmptyString(value.attempt[key])) errors.push(`attempt.${key} must be a non-empty string`);
    }
    const parsedAttempt = Number(value.attempt.runAttempt);
    if (!Number.isInteger(parsedAttempt) || parsedAttempt <= 0) errors.push('attempt.runAttempt must be a positive integer string');
  }

  if (!isRecord(value.timing) || !hasOnlyKeys(value.timing, ['queuedAt', 'startedAt', 'prepareCompletedAt', 'completedAt'])) {
    errors.push('timing must be a closed object');
  } else {
    for (const key of ['startedAt', 'completedAt']) {
      if (!nonEmptyString(value.timing[key]) || !Number.isFinite(Date.parse(String(value.timing[key])))) errors.push(`timing.${key} must be an ISO timestamp`);
    }
    if (value.timing.prepareCompletedAt !== undefined
      && (!nonEmptyString(value.timing.prepareCompletedAt) || !Number.isFinite(Date.parse(value.timing.prepareCompletedAt)))) {
      errors.push('timing.prepareCompletedAt must be an ISO timestamp');
    }
    if (value.timing.queuedAt !== undefined
      && (!nonEmptyString(value.timing.queuedAt) || !Number.isFinite(Date.parse(value.timing.queuedAt)))) {
      errors.push('timing.queuedAt must be an ISO timestamp');
    }
  }

  if (!isRecord(value.metrics) || !hasOnlyKeys(value.metrics, ['queueDurationMs', 'durationMs', 'prepareDurationMs', 'runAttempt', 'isRerun'])) {
    errors.push('metrics must be a closed object');
  } else {
    for (const key of ['durationMs']) {
      if (typeof value.metrics[key] !== 'number' || !Number.isFinite(value.metrics[key]) || Number(value.metrics[key]) < 0) errors.push(`metrics.${key} must be non-negative`);
    }
    if (typeof value.metrics.runAttempt !== 'number' || !Number.isInteger(value.metrics.runAttempt) || value.metrics.runAttempt <= 0) {
      errors.push('metrics.runAttempt must be a positive integer');
    }
    if (value.metrics.prepareDurationMs !== undefined
      && (typeof value.metrics.prepareDurationMs !== 'number' || !Number.isFinite(value.metrics.prepareDurationMs) || value.metrics.prepareDurationMs < 0)) {
      errors.push('metrics.prepareDurationMs must be non-negative');
    }
    if (value.metrics.queueDurationMs !== undefined
      && (typeof value.metrics.queueDurationMs !== 'number' || !Number.isFinite(value.metrics.queueDurationMs) || value.metrics.queueDurationMs < 0)) {
      errors.push('metrics.queueDurationMs must be non-negative');
    }
    if (typeof value.metrics.isRerun !== 'boolean') errors.push('metrics.isRerun must be boolean');
  }

  if (isRecord(value.timing) && isRecord(value.metrics)) {
    const startedAt = Date.parse(String(value.timing.startedAt));
    const completedAt = Date.parse(String(value.timing.completedAt));
    if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) {
      if (completedAt < startedAt) errors.push('timing.completedAt must not precede timing.startedAt');
      if (value.metrics.durationMs !== completedAt - startedAt) errors.push('metrics.durationMs must match timing');
    }
    if (value.timing.prepareCompletedAt !== undefined) {
      const prepareCompletedAt = Date.parse(String(value.timing.prepareCompletedAt));
      if (Number.isFinite(startedAt) && Number.isFinite(prepareCompletedAt)) {
        if (prepareCompletedAt < startedAt || (Number.isFinite(completedAt) && prepareCompletedAt > completedAt)) {
          errors.push('timing.prepareCompletedAt must fall within the producer interval');
        }
        if (value.metrics.prepareDurationMs !== prepareCompletedAt - startedAt) errors.push('metrics.prepareDurationMs must match timing');
      }
    } else if (value.metrics.prepareDurationMs !== undefined) {
      errors.push('metrics.prepareDurationMs requires timing.prepareCompletedAt');
    }
    if (value.timing.queuedAt !== undefined) {
      const queuedAt = Date.parse(String(value.timing.queuedAt));
      if (Number.isFinite(startedAt) && Number.isFinite(queuedAt)) {
        if (queuedAt > startedAt) errors.push('timing.queuedAt must not follow timing.startedAt');
        if (value.metrics.queueDurationMs !== startedAt - queuedAt) errors.push('metrics.queueDurationMs must match timing');
      }
    } else if (value.metrics.queueDurationMs !== undefined) {
      errors.push('metrics.queueDurationMs requires timing.queuedAt');
    }
    if (isRecord(value.attempt)) {
      const runAttempt = Number(value.attempt.runAttempt);
      if (Number.isInteger(runAttempt) && value.metrics.runAttempt !== runAttempt) errors.push('metrics.runAttempt must match attempt.runAttempt');
      if (Number.isInteger(runAttempt) && value.metrics.isRerun !== (runAttempt > 1)) errors.push('metrics.isRerun must match attempt.runAttempt');
    }
  }

  if (!isRecord(value.evidence) || !hasOnlyKeys(value.evidence, ['producers'])
    || !Array.isArray(value.evidence.producers) || value.evidence.producers.length === 0
    || value.evidence.producers.some((item) => !nonEmptyString(item))) {
    errors.push('evidence.producers must be a non-empty string array');
  }
  return { ok: errors.length === 0, errors };
}

const STATUS_PRIORITY: CiProducerResultStatus[] = ['failed', 'blocked', 'superseded', 'passed'];

export function combineCiProducerResults(options: {
  producerId: string;
  results: CiProducerResult[];
  attempt: CiProducerAttempt;
  queuedAt?: string;
  startedAt: string;
  completedAt: string;
}): CiProducerResult {
  if (options.results.length === 0) throw new Error('at least one producer result is required');
  for (const result of options.results) {
    const validation = validateCiProducerResult(result);
    if (!validation.ok) throw new Error(`invalid producer result ${result.producerId}: ${validation.errors.join('; ')}`);
  }
  const root = STATUS_PRIORITY
    .flatMap((status) => options.results.filter((result) => result.status === status))
    .at(0)!;
  return createCiProducerResult({
    producerId: options.producerId,
    status: root.status,
    category: root.category,
    code: root.status === 'passed' ? `${options.producerId}.passed` : root.code,
    rootProducer: root.status === 'passed' ? options.producerId : root.rootProducer,
    blockedBy: uniqueStrings(options.results.flatMap((result) => result.blockedBy)),
    safeRerun: root.safeRerun,
    attempt: options.attempt,
    timing: {
      ...(options.queuedAt ? { queuedAt: options.queuedAt } : {}),
      startedAt: options.startedAt,
      completedAt: options.completedAt,
    },
    evidenceProducers: options.results.flatMap((result) => result.evidence.producers),
  });
}
