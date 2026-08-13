import { describe, expect, test } from 'bun:test';
import { computeInputDigest } from './digest.ts';
import { loadCiContractFiles, producerForConsumer, type CiConsumerDeclaration } from './ci-contract.ts';
import { runCiConsumer, validateCiResult, type CiExecutionContext } from './validator.ts';
import { createRecursiveInputResult } from './validator.ts';
import type { RecursiveInputResult } from './schema.ts';
import type { ProjectedGitGraph } from './git-graph.ts';

const files = loadCiContractFiles();
const graph: ProjectedGitGraph = {
  sourceIdentity: { repository: files.manifest.governance.repository, revision: 'revision-current' },
  pins: [],
  unreachablePaths: [],
};

function makeContext(consumer: CiConsumerDeclaration): CiExecutionContext {
  const inputDigest = computeInputDigest({ sourceIdentity: graph.sourceIdentity, recursivePins: graph.pins, requestedInputClasses: ['source'] });
  return {
    consumerId: consumer.consumerId,
    graph,
    requestedInputClasses: ['source'],
    producerId: consumer.producerId,
    outputContractVersion: files.manifest.outputContractVersion,
    repository: graph.sourceIdentity.repository,
    revision: graph.sourceIdentity.revision,
    run: 'run-current',
    attempt: 'attempt-current',
    job: consumer.job,
    trustScope: consumer.trustScope,
    inputProvenance: {
      producerId: consumer.producerId,
      outputContractVersion: files.manifest.outputContractVersion,
      repository: graph.sourceIdentity.repository,
      revision: graph.sourceIdentity.revision,
      inputDigest,
    },
  };
}

function readyFor(context: CiExecutionContext): RecursiveInputResult {
  return createRecursiveInputResult({
    graph,
    requestedInputClasses: ['source'],
    producer: 'github-actions-fetch-submodules',
    job: context.job,
    attempt: context.attempt,
    trustScope: context.trustScope,
    readiness: { source: { status: 'ready' } },
    ci: {
      producerId: context.producerId,
      outputContractVersion: context.outputContractVersion,
      repository: context.repository,
      revision: context.revision,
      run: context.run,
      attempt: context.attempt,
      job: context.job,
      trustScope: context.trustScope,
      inputProvenance: { ...context.inputProvenance },
    },
  });
}

describe('unified CI result/input validation', () => {
  test('validates every manifest consumer with one adapter and suppresses work before the callback', () => {
    for (const declaration of files.manifest.consumers) {
      const context = makeContext(declaration);
      const result = readyFor(context);
      let started = false;
      const ready = runCiConsumer(result, context, () => { started = true; return 'started'; }, files.manifest);
      expect(ready.ok).toBe(true);
      expect(started).toBe(true);
      expect(ready.envelope.sourceWork.status).toBe('allowed');

      const stale = structuredClone(result) as RecursiveInputResult;
      stale.ci!.attempt = 'attempt-stale';
      started = false;
      const refused = runCiConsumer(stale, context, () => { started = true; return 'started'; }, files.manifest);
      expect(refused.ok).toBe(false);
      expect(refused.envelope.code).toBe('recursive-input.attempt-mismatch');
      expect(refused.envelope.sourceWork.status).toBe('suppressed');
      expect(refused.envelope.suppressionCode).toBe('recursive-input.consumer-work-suppressed');
      expect(started).toBe(false);
      expect(refused.envelope.recoveryActions.every((action) => action.argv || action.manualHandoff)).toBe(true);
    }
  });

  test('has a deterministic red for every current execution identity dimension', () => {
    const declaration = files.manifest.consumers.find((item) => item.trustScope === 'ordinary-ci')!;
    const context = makeContext(declaration);
    const fields = [
      ['producerId', 'producer-mismatch'],
      ['outputContractVersion', 'output-contract-version-mismatch'],
      ['repository', 'repository-mismatch'],
      ['revision', 'revision-mismatch'],
      ['run', 'run-mismatch'],
      ['attempt', 'attempt-mismatch'],
      ['job', 'job-mismatch'],
      ['trustScope', 'trust-scope-mismatch'],
    ] as const;
    for (const [field, code] of fields) {
      const candidate = readyFor(context);
      (candidate.ci as Record<string, unknown>)[field] = field === 'trustScope' ? 'trusted-base-ci' : `wrong-${field}`;
      const result = validateCiResult(candidate, context, files.manifest);
      expect(result.ok).toBe(false);
      expect(result.envelope.code).toBe(`recursive-input.${code}`);
    }

    const provenanceCandidate = readyFor(context);
    const provenanceContext = { ...context, inputProvenance: { ...context.inputProvenance, inputDigest: 'a'.repeat(64) } };
    const provenanceResult = validateCiResult(provenanceCandidate, provenanceContext, files.manifest);
    expect(provenanceResult.ok).toBe(false);
    expect(provenanceResult.envelope.code).toBe('recursive-input.input-provenance-mismatch');

    const malformed = readyFor(context);
    delete malformed.ci;
    expect(validateCiResult(malformed, context, files.manifest).envelope.code).toBe('recursive-input.schema-invalid');

    const unsupported = readyFor(context);
    unsupported.ci!.outputContractVersion = 'recursive-input-ci-result.v9';
    expect(validateCiResult(unsupported, context, files.manifest).envelope.code).toBe('recursive-input.output-contract-version-mismatch');
  });

  test('rejects unknown consumers and unsupported context versions without guessing', () => {
    const declaration = files.manifest.consumers[0]!;
    const context = makeContext(declaration);
    const unknown = { ...context, consumerId: 'unknown-consumer' };
    expect(validateCiResult(readyFor(context), unknown, files.manifest).envelope.code).toBe('recursive-input.unknown-consumer');
    expect(validateCiResult(readyFor(context), { ...context, outputContractVersion: 'recursive-input-ci-result.v9' }, files.manifest).envelope.code).toBe('recursive-input.output-contract-version-mismatch');
  });
});
