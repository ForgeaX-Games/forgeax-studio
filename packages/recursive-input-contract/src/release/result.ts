import {
  deriveCriticalInputJsonSchema,
  deriveReleaseSubjectJsonSchema,
  isCriticalInput,
  isReleaseSubject,
  RELEASE_SURFACES,
  validateReleaseCandidate,
  type ReleaseCandidate,
  type ReleaseSubject,
} from './candidate.ts';
import {
  releaseIntegrityError,
  validationFailure,
  type ReleaseIntegrityError,
  type ReleaseIntegrityValidation,
} from './errors.ts';

export const RELEASE_RESULT_SCHEMA_ID = 'urn:forgeax:release-integrity-result:v1' as const;
export const RELEASE_RESULT_SCHEMA_VERSION = 1 as const;
export const RELEASE_GATE_STATUSES = ['passed', 'failed', 'unverified'] as const;
export type ReleaseGateStatus = (typeof RELEASE_GATE_STATUSES)[number];

/** Independent result for one source, content, or platform gate. */
export type ReleaseGate = {
  status: ReleaseGateStatus;
  code?: string;
  expected?: string;
  actual?: string;
  recoveryActions?: string[];
};

/** Read-only result envelope shared by release-surface consumers. */
export type ReleaseIntegrityResult = {
  schemaVersion: typeof RELEASE_RESULT_SCHEMA_VERSION;
  candidateId: string;
  releaseSurface: ReleaseCandidate['releaseSurface'];
  status: 'fully-verified' | 'non-ready' | 'unverified';
  sourceAdmission: ReleaseGate;
  contentIntegrity: ReleaseGate;
  platformTrust: ReleaseGate;
  subjects: ReleaseSubject[];
  criticalInputs: ReleaseCandidate['criticalInputs'];
  sourceWork: { status: 'permitted' | 'suppressed' };
  recoveryActions: string[];
  trustDag?: { status: 'verified' | 'unverified' | 'failed'; candidateId: string };
};

function gateFromError(error: ReleaseIntegrityError): ReleaseGate {
  return { status: error.status === 'unverified' ? 'unverified' : 'failed', code: error.code, expected: error.expected, actual: error.actual, recoveryActions: error.recoveryActions };
}

function isReleaseGate(value: unknown): value is ReleaseGate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const gate = value as Record<string, unknown>;
  if (Object.keys(gate).some((key) => !['status', 'code', 'expected', 'actual', 'recoveryActions'].includes(key))) return false;
  return RELEASE_GATE_STATUSES.includes(gate.status as ReleaseGateStatus)
    && (gate.code === undefined || typeof gate.code === 'string')
    && (gate.expected === undefined || typeof gate.expected === 'string')
    && (gate.actual === undefined || typeof gate.actual === 'string')
    && (gate.recoveryActions === undefined || Array.isArray(gate.recoveryActions) && gate.recoveryActions.every((action) => typeof action === 'string'));
}

/** Projects a structured error into a non-ready result with source work suppressed. */
export function resultFromReleaseIntegrityError(error: ReleaseIntegrityError, candidateId = 'unknown'): ReleaseIntegrityResult {
  const gate = gateFromError(error);
  return {
    schemaVersion: RELEASE_RESULT_SCHEMA_VERSION,
    candidateId,
    releaseSurface: 'desktop',
    status: error.status === 'unverified' ? 'unverified' : 'non-ready',
    sourceAdmission: gate,
    contentIntegrity: gate,
    platformTrust: { status: 'unverified', code: error.code, expected: error.expected, actual: error.actual, recoveryActions: error.recoveryActions },
    subjects: [],
    criticalInputs: [],
    sourceWork: { status: 'suppressed' },
    recoveryActions: error.recoveryActions,
  };
}

/** Creates a result while keeping content and platform trust independent. */
export function createReleaseIntegrityResult(
  candidate: ReleaseCandidate,
  gates: Partial<Pick<ReleaseIntegrityResult, 'sourceAdmission' | 'contentIntegrity' | 'platformTrust'>> = {},
): ReleaseIntegrityResult {
  const sourceAdmission = gates.sourceAdmission ?? { status: 'unverified' };
  const contentIntegrity = gates.contentIntegrity ?? { status: 'passed' };
  const platformTrust = gates.platformTrust ?? { status: 'unverified' };
  const allPassed = sourceAdmission.status === 'passed' && contentIntegrity.status === 'passed' && platformTrust.status === 'passed';
  const status = allPassed ? 'fully-verified' : [sourceAdmission, contentIntegrity, platformTrust].some((gate) => gate.status === 'failed') ? 'non-ready' : 'unverified';
  return {
    schemaVersion: RELEASE_RESULT_SCHEMA_VERSION,
    candidateId: candidate.candidateId,
    releaseSurface: candidate.releaseSurface,
    status,
    sourceAdmission,
    contentIntegrity,
    platformTrust,
    subjects: candidate.actualSubjects,
    criticalInputs: candidate.criticalInputs,
    sourceWork: { status: allPassed ? 'permitted' : 'suppressed' },
    recoveryActions: [...new Set([sourceAdmission, contentIntegrity, platformTrust].flatMap((gate) => gate.recoveryActions ?? []))],
  };
}

/** Validates the closed result envelope without performing external mutation. */
export function validateReleaseIntegrityResult(value: unknown): ReleaseIntegrityValidation<ReleaseIntegrityResult> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return validationFailure(releaseIntegrityError('result-schema-invalid', 'result-schema', 'closed release-integrity-result.v1 object', 'not an object', { recoveryActions: ['repair-result-schema'] }));
  const allowedKeys = ['schemaVersion', 'candidateId', 'releaseSurface', 'status', 'sourceAdmission', 'contentIntegrity', 'platformTrust', 'subjects', 'criticalInputs', 'sourceWork', 'recoveryActions', 'trustDag'];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return validationFailure(releaseIntegrityError('result-schema-invalid', 'result-schema', 'closed result fields', Object.keys(value).join(','), { recoveryActions: ['repair-result-schema'] }));
  const result = value as Partial<ReleaseIntegrityResult>;
  if (result.schemaVersion !== RELEASE_RESULT_SCHEMA_VERSION || typeof result.candidateId !== 'string' || result.candidateId.length === 0 || !RELEASE_SURFACES.includes(result.releaseSurface as ReleaseCandidate['releaseSurface'])) return validationFailure(releaseIntegrityError('result-schema-invalid', 'result-schema', 'schemaVersion, candidateId, and declared releaseSurface', 'missing or invalid', { recoveryActions: ['repair-result-schema'] }));
  if (!['fully-verified', 'non-ready', 'unverified'].includes(result.status ?? '')) return validationFailure(releaseIntegrityError('result-status-invalid', 'result-schema', 'valid result status', String(result.status), { candidateId: result.candidateId, recoveryActions: ['repair-result-status'] }));
  const gateValues = [
    ['sourceAdmission', result.sourceAdmission as unknown],
    ['contentIntegrity', result.contentIntegrity as unknown],
    ['platformTrust', result.platformTrust as unknown],
  ] as const;
  for (const [key, gate] of gateValues) {
    if (!isReleaseGate(gate)) {
      const actual = typeof gate === 'object' && gate !== null && 'status' in gate ? String(gate.status) : String(gate);
      return validationFailure(releaseIntegrityError('gate-status-invalid', key, 'closed gate with typed optional diagnostics', actual, { candidateId: result.candidateId, recoveryActions: ['repair-gate-status'] }));
    }
  }
  if (!Array.isArray(result.subjects) || !result.subjects.every(isReleaseSubject) || !Array.isArray(result.criticalInputs) || !result.criticalInputs.every(isCriticalInput) || !result.sourceWork || !['permitted', 'suppressed'].includes(result.sourceWork.status)) return validationFailure(releaseIntegrityError('result-schema-invalid', 'result-schema', 'typed subject and critical-input arrays plus sourceWork', 'missing or invalid', { candidateId: result.candidateId, recoveryActions: ['repair-result-schema'] }));
  if (!Array.isArray(result.recoveryActions) || !result.recoveryActions.every((action) => typeof action === 'string')) return validationFailure(releaseIntegrityError('result-schema-invalid', 'result-schema', 'string recoveryActions array', 'missing or invalid', { candidateId: result.candidateId, recoveryActions: ['repair-result-schema'] }));
  if (result.trustDag !== undefined && (typeof result.trustDag !== 'object' || result.trustDag === null || Array.isArray(result.trustDag) || !['verified', 'unverified', 'failed'].includes(result.trustDag.status) || result.trustDag.candidateId !== result.candidateId || Object.keys(result.trustDag).some((key) => !['status', 'candidateId'].includes(key)))) return validationFailure(releaseIntegrityError('result-trust-dag-invalid', 'trust-dag', 'closed trust DAG result bound to candidateId', 'invalid or mismatched', { candidateId: result.candidateId, recoveryActions: ['repair-trust-dag', 'rerun-read-only-verifier'] }));
  const gates = gateValues.map(([, gate]) => gate as ReleaseGate);
  const expectedStatus = gates.some((gate) => gate.status === 'failed')
    ? 'non-ready'
    : gates.every((gate) => gate.status === 'passed')
      ? 'fully-verified'
      : 'unverified';
  const expectedSourceWork = expectedStatus === 'fully-verified' ? 'permitted' : 'suppressed';
  if (result.status !== expectedStatus || result.sourceWork.status !== expectedSourceWork) {
    return validationFailure(releaseIntegrityError(
      'result-state-contradictory',
      'result-state',
      `status=${expectedStatus}, sourceWork.status=${expectedSourceWork}`,
      `status=${result.status}, sourceWork.status=${result.sourceWork.status}`,
      { candidateId: result.candidateId, recoveryActions: ['repair-result-state', 'rerun-read-only-verifier'] },
    ));
  }
  return { ok: true, value: result as ReleaseIntegrityResult };
}

/** Returns the discoverable JSON schema projection for release-integrity-result.v1. */
export function deriveReleaseIntegrityResultJsonSchema(): Record<string, unknown> {
  const gate = { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: [...RELEASE_GATE_STATUSES] }, code: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, recoveryActions: { type: 'array', items: { type: 'string' } } } };
  const subject = deriveReleaseSubjectJsonSchema();
  const criticalInput = deriveCriticalInputJsonSchema();
  const trustDag = { type: 'object', additionalProperties: false, required: ['status', 'candidateId'], properties: { status: { type: 'string', enum: ['verified', 'unverified', 'failed'] }, candidateId: { type: 'string', minLength: 1 } } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: RELEASE_RESULT_SCHEMA_ID,
    title: 'ForgeaX release integrity result',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'candidateId', 'releaseSurface', 'status', 'sourceAdmission', 'contentIntegrity', 'platformTrust', 'subjects', 'criticalInputs', 'sourceWork', 'recoveryActions'],
    properties: {
      schemaVersion: { type: 'integer', const: 1 },
      candidateId: { type: 'string', minLength: 1 },
      releaseSurface: { type: 'string', enum: [...RELEASE_SURFACES] },
      status: { type: 'string', enum: ['fully-verified', 'non-ready', 'unverified'] },
      sourceAdmission: { $ref: '#/$defs/gate' },
      contentIntegrity: { $ref: '#/$defs/gate' },
      platformTrust: { $ref: '#/$defs/gate' },
      subjects: { type: 'array', items: { $ref: '#/$defs/subject' } },
      criticalInputs: { type: 'array', items: { $ref: '#/$defs/criticalInput' } },
      sourceWork: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['permitted', 'suppressed'] } } },
      recoveryActions: { type: 'array', items: { type: 'string' } },
      trustDag: { $ref: '#/$defs/trustDag' },
    },
    $defs: { gate, subject, criticalInput, trustDag },
    allOf: [
      {
        if: { properties: { status: { const: 'fully-verified' } } },
        then: {
          properties: {
            sourceAdmission: { properties: { status: { const: 'passed' } } },
            contentIntegrity: { properties: { status: { const: 'passed' } } },
            platformTrust: { properties: { status: { const: 'passed' } } },
            sourceWork: { properties: { status: { const: 'permitted' } } },
          },
        },
      },
      {
        if: { properties: { status: { enum: ['non-ready', 'unverified'] } } },
        then: { properties: { sourceWork: { properties: { status: { const: 'suppressed' } } } } },
      },
      {
        if: { properties: { sourceWork: { properties: { status: { const: 'permitted' } } } } },
        then: { properties: { status: { const: 'fully-verified' } } },
      },
    ],
  };
}
