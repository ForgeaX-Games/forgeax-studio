import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CI_ERROR_CODES,
  CI_EXIT_CODES,
  CI_REQUIRED_CONTEXTS,
  loadCiContractFiles,
  validateCiManifest,
  validateCiSchemaDocument,
} from './ci-contract.ts';
import { createReleaseProducerManifestFixture, validateReleaseProducerManifest } from './release/producer-manifest.ts';

const packageRoot = join(import.meta.dir, '..');

describe('producer-owned CI contract', () => {
  test('loads one closed manifest/schema pair and projects the exact required contexts', () => {
    const files = loadCiContractFiles(packageRoot);
    expect(validateCiSchemaDocument(files.schema).ok).toBe(true);
    expect(validateCiManifest(files.manifest).ok).toBe(true);
    expect(files.manifest.governance.strictRequiredStatusChecks).toBe(false);
    expect(files.manifest.producers.map((producer) => producer.producerId)).toEqual([
      'fetch-submodules-ordinary',
      'fetch-submodules-trusted',
    ]);
    expect(files.manifest.requiredContexts.map((context) => context.name)).toEqual([...CI_REQUIRED_CONTEXTS]);
    expect(new Set(files.manifest.producers.map((producer) => producer.owner)).size).toBe(1);
    expect(CI_EXIT_CODES.ready).toBe(0);
    expect(CI_ERROR_CODES).toContain('recursive-input.ci.consumer-work-suppressed');
  });

  test('keeps required checks active without strict freshness', () => {
    const files = loadCiContractFiles(packageRoot);
    expect(files.manifest.governance.strictRequiredStatusChecks).toBe(false);

    const strict = structuredClone(files.manifest) as Record<string, unknown>;
    (strict.governance as Record<string, unknown>).strictRequiredStatusChecks = true;
    expect(validateCiManifest(strict).errors.map((item) => item.code)).toContain('recursive-input.ci.governance-invalid');
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

  test('keeps release registry validation separate from the recursive-input result contract', () => {
    const releaseManifest = createReleaseProducerManifestFixture();
    expect(validateReleaseProducerManifest(releaseManifest).ok).toBe(true);
    expect(loadCiContractFiles(packageRoot).manifest.outputContractVersion).toBe('recursive-input-ci-result.v1');
  });

  test.each([
    ['empty nested release registry', (release: Record<string, unknown>) => { release.producers = []; release.consumers = []; release.edges = []; }],
    ['duplicate nested release surface', (release: Record<string, unknown>) => {
      const producers = release.producers as Array<Record<string, unknown>>;
      producers[1]!.releaseSurface = producers[0]!.releaseSurface;
    }],
    ['duplicate nested release edge identity', (release: Record<string, unknown>) => {
      const edges = release.edges as Array<Record<string, unknown>>;
      edges.push(structuredClone(edges[0]));
    }],
    ['unknown nested release endpoint', (release: Record<string, unknown>) => {
      (release.edges as Array<Record<string, unknown>>)[0]!.from = 'unknown-release-node';
    }],
    ['non-closed nested release graph', (release: Record<string, unknown>) => {
      release.edges = (release.edges as Array<Record<string, unknown>>).filter((edge) => edge.kind !== 'publisher');
    }],
  ])('rejects %s at the canonical loader boundary', (_label, mutate) => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'forgeax-ci-contract-release-'));
    try {
      const temporaryPackage = join(temporaryRoot, 'packages/recursive-input-contract');
      cpSync(join(packageRoot, 'schema'), join(temporaryPackage, 'schema'), { recursive: true });
      mkdirSync(join(temporaryPackage, 'ci'), { recursive: true });
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'ci/producer-manifest.v1.json'), 'utf8')) as Record<string, unknown>;
      mutate(manifest.releaseIntegrity as Record<string, unknown>);
      writeFileSync(join(temporaryPackage, 'ci/producer-manifest.v1.json'), JSON.stringify(manifest));

      expect(() => loadCiContractFiles(temporaryRoot)).toThrow(/recursive-input\.ci\.release-integrity-invalid/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test.each([
    ['missing producers', (release: Record<string, unknown>) => { delete release.producers; }],
    ['null producers', (release: Record<string, unknown>) => { release.producers = null; }],
    ['object producers', (release: Record<string, unknown>) => { release.producers = {}; }],
    ['missing consumers', (release: Record<string, unknown>) => { delete release.consumers; }],
    ['null consumers', (release: Record<string, unknown>) => { release.consumers = null; }],
    ['object consumers', (release: Record<string, unknown>) => { release.consumers = {}; }],
  ])('returns structured errors for %s at the canonical loader boundary', (_label, mutate) => {
    const manifest = structuredClone(loadCiContractFiles(packageRoot).manifest) as unknown as Record<string, unknown>;
    mutate(manifest.releaseIntegrity as Record<string, unknown>);

    expect(() => validateCiManifest(manifest)).not.toThrow();
    const validation = validateCiManifest(manifest);

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'recursive-input.ci.release-integrity-invalid' }),
    ]));
  });
});
