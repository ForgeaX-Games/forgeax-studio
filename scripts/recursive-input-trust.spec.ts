import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRecursiveInputResult,
  projectGitlinkGraph,
  type ProjectedGitGraph,
  type RecursiveInputResult,
} from '../packages/recursive-input-contract/src/index.ts';

const ROOT = join(import.meta.dir, '..');
const ADAPTER_PATH = join(ROOT, 'packages/recursive-input-contract/src/trust-adapter.ts');
const trustedWorkflow = readFileSync(join(ROOT, '.github/workflows/mirror-publish-dryrun.yml'), 'utf8');

type TrustedAdapter = {
  createTrustedBaseInputResult: (options: Record<string, unknown>) => {
    ok: boolean;
    result: RecursiveInputResult;
  };
  validateTrustedBaseInputResult: (candidate: unknown, context: Record<string, unknown>) => {
    ok: boolean;
    result: RecursiveInputResult;
  };
};

async function loadAdapter(): Promise<TrustedAdapter | null> {
  if (!existsSync(ADAPTER_PATH)) return null;
  return import(ADAPTER_PATH) as Promise<TrustedAdapter>;
}

const graph: ProjectedGitGraph = projectGitlinkGraph({
  sourceIdentity: { repository: 'forgeax-studio', revision: 'pr-merge-sha' },
  nodes: [{ path: 'packages/editor', pin: 'editor-sha' }],
});

const context = {
  graph,
  requestedInputClasses: ['source'] as const,
  job: 'mirror-publish-dryrun',
  attempt: 'run-42-1',
};

function ordinaryResult(): RecursiveInputResult {
  return createRecursiveInputResult({
    ...context,
    trustScope: 'ordinary-ci',
    producer: 'ordinary-action',
    readiness: { source: { status: 'ready' } },
  });
}

function trustedOptions(cleanup: 'passed' | 'failed' | 'unknown' = 'passed'): Record<string, unknown> {
  return {
    ...context,
    trustScope: 'trusted-base-ci',
    producer: 'trusted-base-adapter',
    sourceAsDataRoot: '/tmp/pr-merge-tree',
    readiness: { source: { status: 'ready' } },
    credentialCleanup: { status: cleanup },
  };
}

describe('trusted recursive input producer', () => {
  it('creates a secretless trusted-base result from PR source-as-data', async () => {
    const adapter = await loadAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter) return;

    const produced = adapter.createTrustedBaseInputResult(trustedOptions());
    expect(produced.ok).toBe(true);
    expect(produced.result.status).toBe('ready');
    expect(produced.result.provenance.trustScope).toBe('trusted-base-ci');
    expect(produced.result.provenance.producer).toBe('trusted-base-adapter');
    expect(JSON.stringify(produced.result)).not.toMatch(/MIRROR_TOKEN|INTERNAL_TOKEN|Authorization|x-access-token/);
  });

  it.each([
    ['passed', true],
    ['unknown', false],
    ['failed', false],
  ] as const)('fails closed when trusted credential cleanup is %s', async (cleanup, ready) => {
    const adapter = await loadAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter) return;

    const produced = adapter.createTrustedBaseInputResult(trustedOptions(cleanup));
    expect(produced.result.status === 'ready').toBe(ready);
    expect(produced.result.provenance.credentialCleanup).toEqual({ status: cleanup });
    if (!ready && produced.result.status === 'non-ready') {
      expect(produced.result.failure.code).toBe('recursive-input.credential-cleanup-failed');
    }
  });

  it('rejects ordinary result reuse and trust or attempt drift', async () => {
    const adapter = await loadAdapter();
    expect(adapter).not.toBeNull();
    if (!adapter) return;

    const trusted = adapter.createTrustedBaseInputResult(trustedOptions());
    expect(trusted.ok).toBe(true);

    const ordinary = adapter.validateTrustedBaseInputResult(ordinaryResult(), {
      ...context,
      trustScope: 'trusted-base-ci',
    });
    expect(ordinary.ok).toBe(false);
    if (!ordinary.ok && ordinary.result.status === 'non-ready') {
      expect(ordinary.result.failure.code).toBe('recursive-input.trust-scope-mismatch');
    }

    const wrongTrust = adapter.validateTrustedBaseInputResult(trusted.result, {
      ...context,
      trustScope: 'ordinary-ci',
    });
    expect(wrongTrust.ok).toBe(false);

    const wrongAttempt = adapter.validateTrustedBaseInputResult(trusted.result, {
      ...context,
      trustScope: 'trusted-base-ci',
      attempt: 'run-41-3',
    });
    expect(wrongAttempt.ok).toBe(false);
  });

  it('keeps the protected token out of the source-as-data producer step', () => {
    const sourceAsDataStepStart = trustedWorkflow.indexOf('source-as-data');
    const sourceAsDataStepEnd = trustedWorkflow.indexOf('\n      - name:', sourceAsDataStepStart + 1);
    const sourceAsDataStep = trustedWorkflow.slice(
      sourceAsDataStepStart,
      sourceAsDataStepEnd === -1 ? undefined : sourceAsDataStepEnd,
    );

    expect(sourceAsDataStepStart).toBeGreaterThanOrEqual(0);
    expect(sourceAsDataStep).not.toContain('MIRROR_TOKEN');
    expect(sourceAsDataStep).not.toContain('secrets.');
    expect(trustedWorkflow).toContain('MIRROR_TOKEN: ${{ secrets.MIRROR_TOKEN }}');
    expect(trustedWorkflow).toContain('MIRROR_DRY_RUN=1 bash .trusted-base/scripts/mirror/publish-multi.sh push');
  });
});
