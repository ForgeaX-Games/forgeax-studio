import { describe, expect, test } from 'bun:test';
import {
  INPUT_CLASSES,
  SCHEMA_ID,
  TRUST_SCOPES,
  deriveRecursiveInputJsonSchema,
  isRecursiveInputResult,
  type RecursiveInputResult,
} from './schema.ts';

describe('recursive input result schema', () => {
  test('publishes one stable schema identity and the complete class/trust registry', () => {
    expect(SCHEMA_ID).toBe('urn:forgeax:recursive-input-result:v1');
    expect(INPUT_CLASSES).toEqual([
      'source',
      'dependency-installation',
      'toolchain',
      'large-file-storage',
      'build-output',
    ]);
    expect(TRUST_SCOPES).toEqual([
      'local-fixed-worktree',
      'ordinary-ci',
      'trusted-base-ci',
    ]);

    const schema = deriveRecursiveInputJsonSchema();
    expect(schema.$id).toBe(SCHEMA_ID);
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual([
      'schemaVersion',
      'status',
      'content',
      'provenance',
      'readiness',
    ]);
  });

  test('requires content and provenance to stay separate', () => {
    const schema = deriveRecursiveInputJsonSchema();
    expect(schema.properties).toHaveProperty('content');
    expect(schema.properties).toHaveProperty('provenance');
    expect(schema.properties).not.toHaveProperty('attemptTimestamp');
    expect(schema.properties).not.toHaveProperty('setupSnapshot');
  });

  test('accepts a ready result only when every requested class is represented', () => {
    const result: RecursiveInputResult = {
      schemaVersion: 1,
      status: 'ready',
      content: {
        sourceIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
        recursivePins: [],
        requestedInputClasses: ['source'],
        inputDigest: 'a'.repeat(64),
        digestAlgorithm: 'sha256',
      },
      provenance: {
        producer: 'test-producer',
        job: 'test-job',
        attempt: 'attempt-1',
        trustScope: 'local-fixed-worktree',
        checkoutIdentity: { repository: 'forgeax-studio', revision: 'root-a' },
        credentialCleanup: { status: 'passed' },
      },
      readiness: {
        source: { status: 'ready' },
        'dependency-installation': { status: 'not-requested' },
        toolchain: { status: 'not-requested' },
        'large-file-storage': { status: 'not-requested' },
        'build-output': { status: 'not-requested' },
      },
    };

    expect(isRecursiveInputResult(result)).toBe(true);
  });
});
