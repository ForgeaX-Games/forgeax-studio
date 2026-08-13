import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  CI_ERROR_CODES,
  CI_EXIT_CODES,
  CI_REQUIRED_CONTEXTS,
  loadCiContractFiles,
  validateCiManifest,
  validateCiSchemaDocument,
} from './ci-contract.ts';

const packageRoot = join(import.meta.dir, '..');

describe('producer-owned CI contract', () => {
  test('loads one closed manifest/schema pair and projects the exact required contexts', () => {
    const files = loadCiContractFiles(packageRoot);
    expect(validateCiSchemaDocument(files.schema).ok).toBe(true);
    expect(validateCiManifest(files.manifest).ok).toBe(true);
    expect(files.manifest.producers.map((producer) => producer.producerId)).toEqual([
      'fetch-submodules-ordinary',
      'fetch-submodules-trusted',
    ]);
    expect(files.manifest.requiredContexts.map((context) => context.name)).toEqual([...CI_REQUIRED_CONTEXTS]);
    expect(new Set(files.manifest.producers.map((producer) => producer.owner)).size).toBe(1);
    expect(CI_EXIT_CODES.ready).toBe(0);
    expect(CI_ERROR_CODES).toContain('recursive-input.ci.consumer-work-suppressed');
  });

  test('rejects owner, version, topology, and closed-schema failures before consumer work', () => {
    const files = loadCiContractFiles(packageRoot);
    const clone = () => structuredClone(files.manifest) as Record<string, unknown>;

    const missingOwner = clone();
    delete (missingOwner.producers as Array<Record<string, unknown>>)[0].owner;
    expect(validateCiManifest(missingOwner).errors.map((item) => item.code)).toContain('recursive-input.ci.producer-invalid');

    const duplicate = clone();
    (duplicate.producers as unknown[]).push(structuredClone((duplicate.producers as unknown[])[0]));
    expect(validateCiManifest(duplicate).errors.map((item) => item.code)).toContain('recursive-input.ci.duplicate-producer');

    const unsupportedVersion = clone();
    (unsupportedVersion.producers as Array<Record<string, unknown>>)[0].outputContractVersion = 'recursive-input-ci-result.v9';
    expect(validateCiManifest(unsupportedVersion).errors.map((item) => item.code)).toContain('recursive-input.ci.unsupported-output-version');

    const unknownProducer = clone();
    (unknownProducer.consumers as Array<Record<string, unknown>>)[0].producerId = 'not-declared';
    expect(validateCiManifest(unknownProducer).errors.map((item) => item.code)).toContain('recursive-input.ci.unknown-producer');

    const closedSchema = structuredClone(files.schema) as Record<string, unknown>;
    delete (closedSchema.properties as Record<string, unknown>).consumers;
    expect(validateCiSchemaDocument(closedSchema).ok).toBe(false);
    closedSchema.additionalProperties = true;
    expect(validateCiSchemaDocument(closedSchema).errors.map((item) => item.code)).toContain('recursive-input.ci.schema-invalid');
    const nestedSchema = structuredClone(files.schema) as Record<string, unknown>;
    (((nestedSchema.properties as Record<string, unknown>).producers as Record<string, unknown>).items as Record<string, unknown>).additionalProperties = true;
    expect(validateCiSchemaDocument(nestedSchema).errors.map((item) => item.code)).toContain('recursive-input.ci.schema-invalid');
  });
});
