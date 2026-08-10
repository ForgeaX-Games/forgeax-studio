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

const ROOT = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const action = read('.github/actions/fetch-submodules/action.yml');
const ordinaryWorkflows = [
  read('.github/workflows/ci.yml'),
  read('.github/workflows/boundaries.yml'),
  read('.github/workflows/nightly-e2e.yml'),
  read('.github/workflows/mirror-multi.yml'),
  read('scripts/mirror/ci/mirror-multi.yml'),
];

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
  return createRecursiveInputResult({
    ...context,
    producer: 'ordinary-action-test',
  });
}

function nonReadyResult(): RecursiveInputResult {
  return createRecursiveInputResult({
    ...context,
    producer: 'ordinary-action-test',
    readiness: {
      source: { status: 'partial' },
      'large-file-storage': { status: 'partial' },
    },
  });
}

describe('ordinary recursive input CI contract', () => {
  it('uses the shared validator and exposes manifest plus structured failure outputs', () => {
    for (const input of [
      'contract-mode',
      'trust-scope',
      'requested-classes',
      'producer-attempt',
      'manifest-path',
      'job',
    ]) {
      expect(action).toContain(`${input}:`);
    }
    expect(action).toContain('validateRecursiveInputResult');
    expect(action).toContain('parseMaterializationFacts');
    expect(action).toContain('recoveryActions');
    expect(action).toContain('GITHUB_OUTPUT');
    expect(action).toContain('exit 3');
  });

  it('accepts the current ordinary attempt and rejects trust, attempt, and class drift', () => {
    const candidate = readyResult();
    expect(validateRecursiveInputResult(candidate, context).ok).toBe(true);

    const wrongTrust = validateRecursiveInputResult(candidate, {
      ...context,
      trustScope: 'trusted-base-ci',
    });
    expect(wrongTrust.ok).toBe(false);
    expect(wrongTrust.result.status).toBe('non-ready');
    if (wrongTrust.result.status === 'non-ready') {
      expect(wrongTrust.result.failure.code).toBe('recursive-input.trust-scope-mismatch');
    }

    const wrongAttempt = validateRecursiveInputResult(candidate, {
      ...context,
      attempt: 'run-41-3',
    });
    expect(wrongAttempt.ok).toBe(false);
    if (wrongAttempt.result.status === 'non-ready') {
      expect(wrongAttempt.result.failure.code).toBe('recursive-input.attempt-mismatch');
    }

    const missingClass = validateRecursiveInputResult(candidate, {
      ...context,
      requestedInputClasses: ['source'],
    });
    expect(missingClass.ok).toBe(false);
    if (missingClass.result.status === 'non-ready') {
      expect(missingClass.result.failure.code).toBe('recursive-input.input-class-mismatch');
    }
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
    for (const workflow of ordinaryWorkflows) {
      const actionIndex = workflow.indexOf('uses: ./.github/actions/fetch-submodules');
      const manifestIndex = workflow.indexOf('manifest-path: ${{ runner.temp }}/forgeax-recursive-input-');
      const consumerIndex = Math.max(workflow.lastIndexOf('bun install'), workflow.lastIndexOf('smoke-install.sh'));
      expect(actionIndex).toBeGreaterThanOrEqual(0);
      expect(manifestIndex).toBeGreaterThan(actionIndex);
      expect(consumerIndex).toBeGreaterThan(manifestIndex);
    }
  });
});
