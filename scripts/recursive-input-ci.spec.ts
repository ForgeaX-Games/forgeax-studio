import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRecursiveInputResult,
  validateRecursiveInputResult,
  type InputClass,
  type ProjectedGitGraph,
  type RecursiveInputResult,
} from '../packages/recursive-input-contract/src/index.ts';
import { createRecursiveInputCliDependencies, executeRecursiveInputCli } from '../packages/recursive-input-contract/src/cli.ts';
import { CI_REQUIRED_CONTEXTS, loadCiContractFiles } from '../packages/recursive-input-contract/src/ci-contract.ts';

const ROOT = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const action = read('.github/actions/fetch-submodules/action.yml');
const files = loadCiContractFiles(ROOT);
const ordinaryWorkflowPaths = [...new Set(files.manifest.consumers
  .filter((consumer) => consumer.trustScope === 'ordinary-ci')
  .flatMap((consumer) => [
    consumer.workflow,
    consumer.workflow.startsWith('.github/workflows/mirror-')
      ? `scripts/mirror/ci/${consumer.workflow.slice('.github/workflows/'.length)}`
      : undefined,
  ])
  .filter((path): path is string => Boolean(path)))];

const graph: ProjectedGitGraph = {
  sourceIdentity: { repository: 'https://github.com/ForgeaX-Games/forgeax-studio.git', revision: 'root-sha' },
  pins: [{ path: 'packages/editor', pin: 'editor-sha' }],
  unreachablePaths: [],
};
const classes: InputClass[] = ['source', 'large-file-storage'];
const context = {
  graph,
  requestedInputClasses: classes,
  trustScope: 'ordinary-ci' as const,
  job: 'ci-build',
  attempt: 'run-42-1',
};

function readyResult(): RecursiveInputResult {
  return createRecursiveInputResult({ ...context, producer: 'ordinary-action-test' });
}

function nonReadyResult(): RecursiveInputResult {
  return createRecursiveInputResult({
    ...context,
    producer: 'ordinary-action-test',
    readiness: { source: { status: 'partial' }, 'large-file-storage': { status: 'partial' } },
  });
}

describe('ordinary recursive input CI contract', () => {
  it('uses the shared validator and exposes manifest plus structured failure outputs', () => {
    for (const input of ['contract-mode', 'trust-scope', 'requested-classes', 'producer-attempt', 'manifest-path', 'job']) {
      expect(action).toContain(`${input}:`);
    }
    expect(action).toContain('validateCiResult');
    expect(action).toContain('parseMaterializationFacts');
    expect(action).toContain('recoveryActions');
    expect(action).toContain('GITHUB_OUTPUT');
    expect(action).toContain('source-work-status=');
    expect(action).toContain('recursive-input.consumer-work-suppressed');
    expect(action).toContain('exit 3');
  });

  it('accepts the current ordinary attempt and rejects trust, attempt, and class drift', () => {
    const candidate = readyResult();
    expect(validateRecursiveInputResult(candidate, context).ok).toBe(true);

    const wrongTrust = validateRecursiveInputResult(candidate, { ...context, trustScope: 'trusted-base-ci' });
    expect(wrongTrust.ok).toBe(false);
    expect(wrongTrust.result.status).toBe('non-ready');
    if (wrongTrust.result.status === 'non-ready') expect(wrongTrust.result.failure.code).toBe('recursive-input.trust-scope-mismatch');

    const wrongAttempt = validateRecursiveInputResult(candidate, { ...context, attempt: 'run-41-3' });
    expect(wrongAttempt.ok).toBe(false);
    if (wrongAttempt.result.status === 'non-ready') expect(wrongAttempt.result.failure.code).toBe('recursive-input.attempt-mismatch');

    const missingClass = validateRecursiveInputResult(candidate, { ...context, requestedInputClasses: ['source'] });
    expect(missingClass.ok).toBe(false);
    if (missingClass.result.status === 'non-ready') expect(missingClass.result.failure.code).toBe('recursive-input.input-class-mismatch');
  });

  it('preserves structured non-ready recovery before any consumer step', () => {
    const result = nonReadyResult();
    expect(result.status).toBe('non-ready');
    if (result.status === 'non-ready') {
      expect(result.failure.code).toBe('recursive-input.inputs-not-ready');
      expect(result.failure.recoveryActions).toEqual(['discard-partial-state', 'retry-cold']);
    }
    expect(action).toContain('status=');
    expect(action).toContain('failure-code=');
    expect(action).toContain('recovery-actions=');
  });

  it('places ordinary validation before install or mirror smoke consumers', () => {
    for (const workflowPath of ordinaryWorkflowPaths) {
      const workflow = read(workflowPath);
      const actionIndex = workflow.indexOf('uses: ./.github/actions/fetch-submodules');
      const manifestIndex = workflow.indexOf('manifest-path: ${{ runner.temp }}/forgeax-recursive-input-');
      const consumerIndex = Math.max(workflow.lastIndexOf('bun install'), workflow.lastIndexOf('smoke-install.sh'));
      expect(actionIndex).toBeGreaterThanOrEqual(0);
      expect(manifestIndex).toBeGreaterThan(actionIndex);
      expect(consumerIndex).toBeGreaterThan(manifestIndex);
    }
  });
});

describe('recursive-input CI contract entry', () => {
  it('discovers schema/status/verify through the existing AI entry', () => {
    const dependencies = createRecursiveInputCliDependencies(ROOT);
    const schema = executeRecursiveInputCli(['schema', '--scope', 'ci'], dependencies);
    expect(schema.exitCode).toBe(0);
    expect(JSON.parse(schema.stdout).requiredContexts.map((context: { name: string }) => context.name)).toEqual([...CI_REQUIRED_CONTEXTS]);

    const status = executeRecursiveInputCli(['status', '--scope', 'ci'], dependencies);
    expect(status.exitCode).toBe(3);
    expect(JSON.parse(status.stdout)).toEqual(expect.objectContaining({ operation: 'status', scope: 'ci', externalRuleset: 'not-checked' }));

    const usage = executeRecursiveInputCli(['verify', '--scope', 'ci'], dependencies);
    expect(usage.exitCode).toBe(2);
    expect(JSON.parse(usage.stdout)).toEqual(expect.objectContaining({ operation: 'verify', scope: 'ci', sourceWork: { status: 'suppressed' } }));
  });

  it('derives consumer identities from the canonical manifest and documents the live gate', () => {
    for (const workflow of new Set(files.manifest.consumers.map((consumer) => consumer.workflow))) {
      const source = read(workflow);
      for (const consumerId of [...source.matchAll(/consumer-id:\s*([a-z0-9-]+)/g)].map((match) => match[1])) {
        expect(files.manifest.consumers.some((consumer) => consumer.consumerId === consumerId)).toBe(true);
      }
    }
    expect(read('docs/contracts/recursive-inputs.md')).toContain('status --scope ci --live-ruleset');
    expect(read('docs/contracts/recursive-inputs.md')).toContain('sourceWork.status = suppressed');
  });
});
