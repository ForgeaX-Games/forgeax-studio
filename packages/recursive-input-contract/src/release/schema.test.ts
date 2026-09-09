import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveReleaseCandidateJsonSchema,
  validateReleaseCandidate,
} from './candidate.ts';
import {
  deriveReleaseIntegrityResultJsonSchema,
  validateReleaseIntegrityResult,
} from './result.ts';
import { deriveReleaseTrustDagJsonSchema } from './trust-dag.ts';

const packageRoot = join(import.meta.dir, '..', '..');

type SchemaNode = {
  [key: string]: unknown;
  $defs?: Record<string, SchemaNode>;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  allOf?: SchemaNode[];
};

function assertClosedSchema(value: unknown, path = '$'): void {
  expect(value).toBeTruthy();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.type === 'object') {
    expect(record.additionalProperties, path).toBe(false);
    expect(record.properties, path).toBeTruthy();
    if (record.properties && typeof record.properties === 'object') {
      for (const [key, child] of Object.entries(record.properties)) assertClosedSchema(child, `${path}.properties.${key}`);
    }
  }
  if (record.items) assertClosedSchema(record.items, `${path}.items`);
  if (record.$defs && typeof record.$defs === 'object' && !Array.isArray(record.$defs)) {
    for (const [key, child] of Object.entries(record.$defs)) assertClosedSchema(child, `${path}.$defs.${key}`);
  }
  if (record.allOf && Array.isArray(record.allOf)) record.allOf.forEach((child, index) => assertClosedSchema(child, `${path}.allOf[${index}]`));
  if (record.if) assertClosedSchema(record.if, `${path}.if`);
  if (record.then) assertClosedSchema(record.then, `${path}.then`);
}

const readSchema = (name: string): unknown => JSON.parse(readFileSync(join(packageRoot, 'schema', name), 'utf8')) as unknown;

describe('release schema contract', () => {
  test('publishes closed v1 schemas for candidate, result, and trust DAG', () => {
    const candidateSchema = deriveReleaseCandidateJsonSchema();
    const resultSchema = deriveReleaseIntegrityResultJsonSchema();
    const dagSchema = deriveReleaseTrustDagJsonSchema();

    expect(candidateSchema.$id).toBe('urn:forgeax:release-candidate:v1');
    expect(resultSchema.$id).toBe('urn:forgeax:release-integrity-result:v1');
    expect(dagSchema.$id).toBe('urn:forgeax:release-trust-dag:v1');
    assertClosedSchema(candidateSchema);
    assertClosedSchema(resultSchema);
    assertClosedSchema(dagSchema);
    expect(candidateSchema.properties).toEqual(expect.objectContaining({
      expectedSubjects: { type: 'array', minItems: 1, items: { $ref: '#/$defs/subject' } },
      actualSubjects: { type: 'array', minItems: 1, items: { $ref: '#/$defs/subject' } },
      criticalInputs: { type: 'array', minItems: 1, items: { $ref: '#/$defs/criticalInput' } },
    }));
    expect(resultSchema.properties).toEqual(expect.objectContaining({
      subjects: { type: 'array', items: { $ref: '#/$defs/subject' } },
      criticalInputs: { type: 'array', items: { $ref: '#/$defs/criticalInput' } },
    }));
    expect(resultSchema.$defs).toEqual(expect.objectContaining({
      gate: expect.objectContaining({ type: 'object', additionalProperties: false }),
      subject: expect.objectContaining({ type: 'object', additionalProperties: false }),
      criticalInput: expect.objectContaining({ type: 'object', additionalProperties: false }),
    }));
    expect(dagSchema.properties).toEqual(expect.objectContaining({
      nodes: { type: 'array', minItems: 1, items: { $ref: '#/$defs/node' } },
      edges: { type: 'array', minItems: 1, items: { $ref: '#/$defs/edge' } },
      mutations: { type: 'array', minItems: 1, items: { $ref: '#/$defs/mutation' } },
    }));
    expect(dagSchema.$defs).toEqual(expect.objectContaining({
      node: expect.objectContaining({ type: 'object', additionalProperties: false }),
      edge: expect.objectContaining({ type: 'object', additionalProperties: false }),
      mutation: expect.objectContaining({ type: 'object', additionalProperties: false }),
    }));
    expect(readSchema('release-candidate.v1.schema.json')).toEqual(candidateSchema);
    expect(readSchema('release-integrity-result.v1.schema.json')).toEqual(expect.objectContaining({ $id: resultSchema.$id }));
    expect(readSchema('release-integrity-result.v1.schema.json')).toEqual(resultSchema);
    expect(readSchema('release-trust-dag.v1.schema.json')).toEqual(dagSchema);
  });

  test('publishes required item identity and digest constraints for schema-only consumers', () => {
    const candidateSchema = deriveReleaseCandidateJsonSchema() as Record<string, any>;
    const resultSchema = deriveReleaseIntegrityResultJsonSchema() as Record<string, any>;
    const dagSchema = deriveReleaseTrustDagJsonSchema() as Record<string, any>;
    const subject = candidateSchema.$defs.subject;
    const criticalInput = candidateSchema.$defs.criticalInput;

    expect(subject.required).toEqual(expect.arrayContaining(['subjectId', 'name', 'digest', 'digestAlgorithm']));
    expect(subject.properties.digest).toEqual({ type: 'string', pattern: '^[a-f0-9]{64}$' });
    expect(subject.properties.digestAlgorithm).toEqual({ type: 'string', const: 'sha256' });
    expect(subject.properties.sbom.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ then: { required: ['reason'] } }),
    ]));
    expect(criticalInput.required).toEqual(['inputId', 'kind', 'identity', 'status']);
    expect(criticalInput.properties.kind.enum).toEqual(['action', 'cli', 'sidecar', 'scanner', 'ruleset', 'signing']);
    expect(criticalInput.properties.identity).toEqual({ type: 'string', minLength: 1 });
    expect(resultSchema.$defs.subject).toEqual(subject);
    expect(resultSchema.$defs.criticalInput).toEqual(criticalInput);
    expect(dagSchema.$defs.node.required).toEqual(['nodeId', 'role', 'identity', 'permissions']);
    expect(dagSchema.$defs.edge.properties.kind.enum).toEqual(['evidence', 'precondition', 'binding', 'order']);
    expect(dagSchema.$defs.mutation.required).toEqual(['mutationId', 'targetNodeId', 'publisherNodeId', 'operation', 'requiredPreconditions']);
  });

  test('rejects schema-only result item shapes that runtime validators must not accept', () => {
    const result = {
      schemaVersion: 1,
      candidateId: 'candidate-1',
      releaseSurface: 'desktop',
      status: 'unverified',
      sourceAdmission: { status: 'unverified' },
      contentIntegrity: { status: 'passed' },
      platformTrust: { status: 'unverified' },
      subjects: [{}],
      criticalInputs: [{}],
      sourceWork: { status: 'suppressed' },
      recoveryActions: [],
    };

    expect(validateReleaseIntegrityResult(result).ok).toBe(false);
  });

  test('rejects old versions, unknown fields, invalid gates, and fake SBOM applicability', () => {
    const result = {
      schemaVersion: 1,
      candidateId: 'candidate-1',
      releaseSurface: 'desktop',
      status: 'fully-verified',
      sourceAdmission: { status: 'passed' },
      contentIntegrity: { status: 'passed' },
      platformTrust: { status: 'passed' },
      subjects: [{ subjectId: 'installer', name: 'installer.dmg', digest: 'a'.repeat(64), digestAlgorithm: 'sha256', sbom: { status: 'inapplicable', subjectDigest: 'b'.repeat(64) } }],
      criticalInputs: [],
      sourceWork: { status: 'permitted' },
      recoveryActions: [],
    } as Record<string, unknown>;
    expect(validateReleaseIntegrityResult(result).ok).toBe(false);
    result.schemaVersion = 2;
    expect(validateReleaseIntegrityResult(result).ok).toBe(false);
    result.schemaVersion = 1;
    result.extra = true;
    expect(validateReleaseIntegrityResult(result).ok).toBe(false);
    delete result.extra;
    (result.contentIntegrity as Record<string, unknown>).status = 'unknown';
    expect(validateReleaseIntegrityResult(result).ok).toBe(false);
    const candidate = {
      schemaVersion: 1,
      candidateId: 'candidate-1',
      releaseSurface: 'desktop',
      rootRevision: 'root-1',
      recursiveInputIdentity: { repository: 'repo', revision: 'root-1', inputDigest: 'c'.repeat(64) },
      attempt: 'attempt-1',
      expectedSubjects: [],
      actualSubjects: [],
      criticalInputs: [{ inputId: 'sbom', kind: 'scanner', identity: 'sha256:scanner', status: 'resolved' }],
      sbomApplicable: true,
    };
    expect(validateReleaseCandidate(candidate).ok).toBe(false);
  });

  test('rejects a permitted source work state when source admission failed', () => {
    const result = {
      schemaVersion: 1,
      candidateId: 'candidate-1',
      releaseSurface: 'desktop',
      status: 'fully-verified',
      sourceAdmission: { status: 'failed', code: 'release-integrity.source-mismatch' },
      contentIntegrity: { status: 'passed' },
      platformTrust: { status: 'passed' },
      subjects: [],
      criticalInputs: [],
      sourceWork: { status: 'permitted' },
      recoveryActions: [],
    };

    const validation = validateReleaseIntegrityResult(result);

    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.error.code).toBe('release-integrity.result-state-contradictory');
      expect(validation.error.gate).toBe('result-state');
      expect(validation.error.recoveryActions).toContain('repair-result-state');
    }
  });
});
