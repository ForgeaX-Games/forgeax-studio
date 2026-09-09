import { createHash } from 'node:crypto';
import {
  releaseIntegrityError,
  validationFailure,
  type ReleaseIntegrityValidation,
} from './errors.ts';

export const RELEASE_CANDIDATE_SCHEMA_ID = 'urn:forgeax:release-candidate:v1' as const;
export const RELEASE_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const RELEASE_DIGEST_ALGORITHM = 'sha256' as const;

export const RELEASE_SURFACES = [
  'mirror-forward',
  'trusted-dry-run',
  'route-back',
  'desktop',
  'game-runtime',
] as const;
export type ReleaseSurface = (typeof RELEASE_SURFACES)[number];

export const CRITICAL_INPUT_KINDS = ['action', 'cli', 'sidecar', 'scanner', 'ruleset', 'signing'] as const;
export type CriticalInputKind = (typeof CRITICAL_INPUT_KINDS)[number];

/** Machine identity for one final release subject. */
export type ReleaseSubject = {
  subjectId: string;
  name: string;
  platform?: string;
  digest: string;
  digestAlgorithm: typeof RELEASE_DIGEST_ALGORITHM;
  sbom?: {
    status: 'applicable' | 'inapplicable';
    subjectDigest: string;
    reason?: string;
  };
};

/** Candidate-bound identity projected from recursive-input-result.v1. */
export type RecursiveInputIdentity = {
  repository: string;
  revision: string;
  inputDigest: string;
};

/** Immutable identity for an input that can change bytes or trust decisions. */
export type CriticalInput = {
  inputId: string;
  kind: CriticalInputKind;
  identity: string;
  status: 'resolved' | 'unverified';
};

/** Frozen release candidate consumed by every release-surface verifier. */
export type ReleaseCandidate = {
  schemaVersion: typeof RELEASE_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  releaseSurface: ReleaseSurface;
  rootRevision: string;
  recursiveInputIdentity: RecursiveInputIdentity;
  attempt: string;
  expectedSubjects: ReleaseSubject[];
  actualSubjects: ReleaseSubject[];
  criticalInputs: CriticalInput[];
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isReleaseSubject(value: unknown): value is ReleaseSubject {
  if (!isRecord(value) || !hasOnlyKeys(value, ['subjectId', 'name', 'platform', 'digest', 'digestAlgorithm', 'sbom'])) return false;
  if (typeof value.subjectId !== 'string' || value.subjectId.length === 0) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (value.platform !== undefined && typeof value.platform !== 'string') return false;
  if (!isDigest(value.digest) || value.digestAlgorithm !== RELEASE_DIGEST_ALGORITHM) return false;
  if (value.sbom === undefined) return true;
  if (!isRecord(value.sbom) || !hasOnlyKeys(value.sbom, ['status', 'subjectDigest', 'reason'])) return false;
  if (value.sbom.status !== 'applicable' && value.sbom.status !== 'inapplicable') return false;
  if (!isDigest(value.sbom.subjectDigest)) return false;
  return value.sbom.status === 'inapplicable' ? typeof value.sbom.reason === 'string' && value.sbom.reason.length > 0 : true;
}

export function isCriticalInput(value: unknown): value is CriticalInput {
  return isRecord(value)
    && hasOnlyKeys(value, ['inputId', 'kind', 'identity', 'status'])
    && typeof value.inputId === 'string'
    && value.inputId.length > 0
    && CRITICAL_INPUT_KINDS.includes(value.kind as CriticalInputKind)
    && typeof value.identity === 'string'
    && value.identity.length > 0
    && (value.status === 'resolved' || value.status === 'unverified');
}

function sameSubject(left: ReleaseSubject, right: ReleaseSubject): boolean {
  return left.subjectId === right.subjectId
    && left.name === right.name
    && left.platform === right.platform
    && left.digest === right.digest
    && left.digestAlgorithm === right.digestAlgorithm;
}

function validateSubjectSet(
  expected: readonly ReleaseSubject[],
  actual: readonly ReleaseSubject[],
  candidateId: string,
): ReleaseIntegrityValidation<true> {
  const expectedIds = new Set(expected.map((subject) => subject.subjectId));
  const actualIds = new Set(actual.map((subject) => subject.subjectId));
  const extra = actual.find((subject) => !expectedIds.has(subject.subjectId));
  const missing = expected.find((subject) => !actualIds.has(subject.subjectId));
  if (extra || missing || expected.length !== actual.length) {
    return validationFailure(releaseIntegrityError(
      'subject-set-mismatch',
      'subject-binding',
      expected.map((subject) => subject.subjectId).join(','),
      actual.map((subject) => subject.subjectId).join(','),
      {
        candidateId,
        recoveryActions: extra ? ['remove-unexpected-subject', 'rebuild-candidate'] : ['produce-missing-subject', 'rebuild-candidate'],
      },
    ));
  }
  for (const expectedSubject of expected) {
    const actualSubject = actual.find((subject) => subject.subjectId === expectedSubject.subjectId)!;
    if (!sameSubject(expectedSubject, actualSubject)) {
      return validationFailure(releaseIntegrityError(
        'subject-digest-mismatch',
        'subject-binding',
        `${expectedSubject.subjectId}:${expectedSubject.digest}`,
        `${actualSubject.subjectId}:${actualSubject.digest}`,
        { candidateId, subjectId: expectedSubject.subjectId, recoveryActions: ['rebuild-candidate', 'recompute-subject-digest'] },
      ));
    }
  }
  return { ok: true, value: true };
}

/** Returns true only when the candidate has complete bound identities. */
export function isReleaseCandidate(value: unknown): value is ReleaseCandidate {
  return validateReleaseCandidate(value).ok;
}

/** Validates candidate identity without reading credentials or changing state. */
export function validateReleaseCandidate(value: unknown): ReleaseIntegrityValidation<ReleaseCandidate> {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion', 'candidateId', 'releaseSurface', 'rootRevision', 'recursiveInputIdentity',
    'attempt', 'expectedSubjects', 'actualSubjects', 'criticalInputs',
  ])) {
    return validationFailure(releaseIntegrityError('candidate-schema-invalid', 'candidate-identity', 'closed release-candidate.v1 object', 'invalid or extra fields', { recoveryActions: ['repair-candidate-schema'] }));
  }
  const candidateId = typeof value.candidateId === 'string' ? value.candidateId : 'unknown';
  if (value.schemaVersion !== RELEASE_CANDIDATE_SCHEMA_VERSION) return validationFailure(releaseIntegrityError('candidate-schema-invalid', 'candidate-identity', 'schemaVersion=1', String(value.schemaVersion), { candidateId, recoveryActions: ['repair-candidate-schema'] }));
  if (typeof value.candidateId !== 'string' || value.candidateId.length === 0) return validationFailure(releaseIntegrityError('candidate-identity-missing', 'candidate-identity', 'non-empty candidateId', String(value.candidateId), { recoveryActions: ['assign-candidate-identity'] }));
  if (!RELEASE_SURFACES.includes(value.releaseSurface as ReleaseSurface)) return validationFailure(releaseIntegrityError('candidate-surface-invalid', 'candidate-identity', RELEASE_SURFACES.join(','), String(value.releaseSurface), { candidateId, recoveryActions: ['select-declared-release-surface'] }));
  if (typeof value.rootRevision !== 'string' || value.rootRevision.length === 0) return validationFailure(releaseIntegrityError('candidate-root-missing', 'candidate-identity', 'root revision', String(value.rootRevision), { candidateId, recoveryActions: ['freeze-root-revision'] }));
  if (!isRecord(value.recursiveInputIdentity)) return validationFailure(releaseIntegrityError('recursive-input-identity-missing', 'candidate-identity', 'repository, revision, and input digest', 'missing', { candidateId, recoveryActions: ['bind-recursive-input-result'] }));
  if (typeof value.recursiveInputIdentity.repository !== 'string' || value.recursiveInputIdentity.repository.length === 0 || typeof value.recursiveInputIdentity.revision !== 'string' || value.recursiveInputIdentity.revision.length === 0 || !isDigest(value.recursiveInputIdentity.inputDigest)) {
    return validationFailure(releaseIntegrityError('recursive-input-identity-invalid', 'candidate-identity', 'fixed repository, revision, and sha256 input digest', JSON.stringify(value.recursiveInputIdentity), { candidateId, recoveryActions: ['bind-recursive-input-result'] }));
  }
  if (value.recursiveInputIdentity.revision !== value.rootRevision) return validationFailure(releaseIntegrityError('root-revision-mismatch', 'candidate-identity', value.rootRevision, value.recursiveInputIdentity.revision, { candidateId, recoveryActions: ['freeze-root-revision', 'rebuild-candidate'] }));
  if (typeof value.attempt !== 'string' || value.attempt.length === 0) return validationFailure(releaseIntegrityError('attempt-missing', 'candidate-identity', 'non-empty attempt', String(value.attempt), { candidateId, retryable: true, recoveryActions: ['create-new-attempt'] }));
  if (!Array.isArray(value.expectedSubjects) || !Array.isArray(value.actualSubjects) || value.expectedSubjects.length === 0 || value.actualSubjects.length === 0) return validationFailure(releaseIntegrityError('subject-set-missing', 'subject-binding', 'non-empty expected and actual subject sets', 'missing or empty', { candidateId, recoveryActions: ['produce-subject-set', 'rebuild-candidate'] }));
  if (!value.expectedSubjects.every(isReleaseSubject) || !value.actualSubjects.every(isReleaseSubject)) return validationFailure(releaseIntegrityError('subject-schema-invalid', 'subject-binding', 'closed subject with sha256 digest', 'invalid subject', { candidateId, recoveryActions: ['repair-subject-schema'] }));
  const subjects = [...value.expectedSubjects, ...value.actualSubjects] as ReleaseSubject[];
  const unboundSbom = subjects.find((subject) => subject.sbom !== undefined && subject.sbom.subjectDigest !== subject.digest);
  if (unboundSbom?.sbom) {
    return validationFailure(releaseIntegrityError(
      'sbom-subject-digest-mismatch',
      'subject-binding',
      `${unboundSbom.subjectId}:${unboundSbom.digest}`,
      `${unboundSbom.subjectId}:${unboundSbom.sbom.subjectDigest}`,
      { candidateId, subjectId: unboundSbom.subjectId, recoveryActions: ['recompute-sbom', 'rebuild-candidate'] },
    ));
  }
  const subjectValidation = validateSubjectSet(value.expectedSubjects, value.actualSubjects, candidateId);
  if (!subjectValidation.ok) return subjectValidation;
  if (!Array.isArray(value.criticalInputs) || value.criticalInputs.length === 0) return validationFailure(releaseIntegrityError('critical-input-missing', 'critical-inputs', 'at least one candidate-bound critical input', 'missing', { candidateId, recoveryActions: ['record-critical-inputs', 'rebuild-candidate'] }));
  if (!value.criticalInputs.every(isCriticalInput)) {
    return validationFailure(releaseIntegrityError('critical-input-schema-invalid', 'critical-inputs', 'closed candidate-bound input declarations', 'invalid input declaration', { candidateId, recoveryActions: ['repair-critical-inputs'] }));
  }
  const unresolved = value.criticalInputs.find((input) => input.status === 'unverified');
  if (unresolved) return validationFailure(releaseIntegrityError('critical-input-unverified', 'critical-inputs', 'resolved immutable identity', unresolved.status, { status: 'unverified', candidateId, retryable: false, recoveryActions: ['pin-critical-input', 'create-new-attempt'] }));
  return { ok: true, value: value as ReleaseCandidate };
}

/** Derives a stable identity digest from the candidate binding fields. */
export function candidateIdentityDigest(candidate: ReleaseCandidate): string {
  return createHash('sha256').update(JSON.stringify({
    candidateId: candidate.candidateId,
    rootRevision: candidate.rootRevision,
    recursiveInputIdentity: candidate.recursiveInputIdentity,
    attempt: candidate.attempt,
  })).digest('hex');
}

/** Returns the discoverable JSON schema projection for release-candidate.v1. */
export function deriveReleaseCandidateJsonSchema(): Record<string, unknown> {
  const subject = deriveReleaseSubjectJsonSchema();
  const criticalInput = deriveCriticalInputJsonSchema();
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: RELEASE_CANDIDATE_SCHEMA_ID,
    title: 'ForgeaX release candidate',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'candidateId', 'releaseSurface', 'rootRevision', 'recursiveInputIdentity', 'attempt', 'expectedSubjects', 'actualSubjects', 'criticalInputs'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      candidateId: { type: 'string', minLength: 1 },
      releaseSurface: { type: 'string', enum: [...RELEASE_SURFACES] },
      rootRevision: { type: 'string', minLength: 1 },
      recursiveInputIdentity: { type: 'object', additionalProperties: false, required: ['repository', 'revision', 'inputDigest'], properties: { repository: { type: 'string', minLength: 1 }, revision: { type: 'string', minLength: 1 }, inputDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
      attempt: { type: 'string', minLength: 1 },
      expectedSubjects: { type: 'array', minItems: 1, items: { $ref: '#/$defs/subject' } },
      actualSubjects: { type: 'array', minItems: 1, items: { $ref: '#/$defs/subject' } },
      criticalInputs: { type: 'array', minItems: 1, items: { $ref: '#/$defs/criticalInput' } },
    },
    $defs: { subject, criticalInput },
  };
}

export function deriveReleaseSubjectJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['subjectId', 'name', 'digest', 'digestAlgorithm'],
    properties: {
      subjectId: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      platform: { type: 'string' },
      digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      digestAlgorithm: { type: 'string', const: 'sha256' },
      sbom: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'subjectDigest'],
        properties: {
          status: { type: 'string', enum: ['applicable', 'inapplicable'] },
          subjectDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          reason: { type: 'string', minLength: 1 },
        },
        allOf: [{ if: { properties: { status: { const: 'inapplicable' } } }, then: { required: ['reason'] } }],
      },
    },
  };
}

export function deriveCriticalInputJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['inputId', 'kind', 'identity', 'status'],
    properties: {
      inputId: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: [...CRITICAL_INPUT_KINDS] },
      identity: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['resolved', 'unverified'] },
    },
  };
}
