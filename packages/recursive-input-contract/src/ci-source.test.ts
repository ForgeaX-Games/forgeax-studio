import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectCiSourceFiles, inspectCiSources } from './ci-source.ts';
import { loadCiContractFiles, type CiManifest } from './ci-contract.ts';

// Negative cases must mutate a controlled, governed workflow, not a retired
// consumer name in the evolving repository workflow. Keep a second declaration
// so removing one consumer does not intentionally take the workflow out of scope.
function sourceFixture() {
  const workflow = '.github/workflows/fixture.yml';
  const manifest: CiManifest = {
    ...loadCiContractFiles().manifest,
    consumers: ['build', 'test'].map((job) => ({
      consumerId: `fixture-${job}`,
      producerId: 'fetch-submodules-ordinary',
      trustScope: 'ordinary-ci',
      workflow,
      job,
      validationBoundary: 'before first source-owned command',
      sourceWork: 'bun install',
    })),
  };
  const source = `jobs:
  build:
    steps:
      - uses: ./.github/actions/fetch-submodules
        with:
          contract-mode: ordinary-ci
          consumer-id: fixture-build
          trust-scope: ordinary-ci
      - run: bun install
  test:
    steps:
      - uses: ./.github/actions/fetch-submodules
        with:
          contract-mode: ordinary-ci
          consumer-id: fixture-test
          trust-scope: ordinary-ci
      - run: bun install
`;
  const producer = readFileSync(join(import.meta.dir, '../../../.github/actions/fetch-submodules/action.yml'), 'utf8');
  return { workflow, manifest, source, producer };
}

describe('manifest-derived CI source admission', () => {
  test('finds every direct consumer and proves the producer validator precedes source work', () => {
    const files = loadCiContractFiles();
    const inspection = inspectCiSourceFiles(join(import.meta.dir, '../../..'), files.manifest);
    expect(inspection.errors).toEqual([]);
    expect(new Set(inspection.calls.map((call) => call.consumerId)).size).toBe(files.manifest.consumers.length);
    expect(inspection.calls.length).toBeGreaterThanOrEqual(files.manifest.consumers.length);
    for (const call of inspection.calls) {
      expect(call.actionIndex).toBeGreaterThanOrEqual(0);
      expect(call.validationIndex).toBeGreaterThanOrEqual(call.actionIndex);
      expect(call.firstSourceWorkIndex).toBeGreaterThan(call.validationIndex);
    }
  });

  test('fails closed for an undeclared governed source call', () => {
    const { workflow, manifest, source, producer } = sourceFixture();
    expect(inspectCiSources({ [workflow]: source }, manifest, producer).errors).toEqual([]);
    const inspection = inspectCiSources({ [workflow]: source }, {
      ...manifest,
      consumers: manifest.consumers.filter((consumer) => consumer.consumerId !== 'fixture-build'),
    }, producer);
    expect(inspection.errors).toContain(`recursive-input.ci.undeclared-source-call: ${workflow}#build:fixture-build`);
  });

  test('does not govern source calls in workflows outside the manifest', () => {
    const files = loadCiContractFiles();
    const root = join(import.meta.dir, '../../..');
    const weekly = readFileSync(join(root, '.github/workflows/weekly-release.yml'), 'utf8');
    const inspection = inspectCiSources({ '.github/workflows/weekly-release.yml': weekly }, files.manifest);
    expect(inspection.errors).toEqual([]);
    expect(inspection.calls).toEqual([]);
    expect(inspection.outsideContract).toEqual(['.github/workflows/weekly-release.yml']);
  });

  test('fails closed for mismatched manifest calls', () => {
    const { workflow, manifest, source, producer } = sourceFixture();
    const renamed = source.replace('consumer-id: fixture-build', 'consumer-id: undeclared');
    expect(renamed).not.toBe(source);
    const inspection = inspectCiSources({ [workflow]: renamed }, manifest, producer);
    expect(inspection.errors).toContain(`recursive-input.ci.undeclared-source-call: ${workflow}#build:undeclared`);
    expect(inspection.errors).toContain('recursive-input.ci.missing-source-call: fixture-build');
  });

  test('fails closed for duplicate manifest calls', () => {
    const { workflow, manifest, source, producer } = sourceFixture();
    const duplicated = source.replace('consumer-id: fixture-test', 'consumer-id: fixture-build');
    expect(duplicated).not.toBe(source);
    const inspection = inspectCiSources({ [workflow]: duplicated }, manifest, producer);
    expect(inspection.errors).toContain('recursive-input.ci.duplicate-source-call: fixture-build');
    expect(inspection.errors).toContain('recursive-input.ci.missing-source-call: fixture-test');
  });

  test('fails closed for malformed YAML', () => {
    const { workflow, manifest, producer } = sourceFixture();
    const malformed = inspectCiSources({ [workflow]: 'jobs: [not-valid' }, manifest, producer);
    expect(malformed.errors).toContain(`recursive-input.ci.workflow-schema-invalid: ${workflow}`);
  });
});
