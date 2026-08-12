import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectCiSourceFiles, inspectCiSources } from './ci-source.ts';
import { loadCiContractFiles } from './ci-contract.ts';

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
    const files = loadCiContractFiles();
    const inspection = inspectCiSourceFiles(join(import.meta.dir, '../../..'), {
      ...files.manifest,
      consumers: files.manifest.consumers.filter((consumer) => consumer.consumerId !== 'ci-build'),
    });
    expect(inspection.errors.some((error) => error.includes('undeclared-source-call'))).toBe(true);
  });

  test('fails closed for malformed YAML and duplicate or mismatched manifest calls', () => {
    const files = loadCiContractFiles();
    const root = join(import.meta.dir, '../../..');
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const renamed = workflow.replace('consumer-id: ci-build', 'consumer-id: undeclared');
    const renamedInspection = inspectCiSources({ '.github/workflows/ci.yml': renamed }, files.manifest, readFileSync(join(root, '.github/actions/fetch-submodules/action.yml'), 'utf8'));
    expect(renamedInspection.errors.some((error) => error.includes('undeclared-source-call'))).toBe(true);
    expect(renamedInspection.errors.some((error) => error.includes('missing-source-call'))).toBe(true);

    const malformed = inspectCiSources({ '.github/workflows/ci.yml': 'jobs: [not-valid' }, files.manifest, 'validateCiResult');
    expect(malformed.errors).toContain('recursive-input.ci.workflow-schema-invalid: .github/workflows/ci.yml');
  });
});
