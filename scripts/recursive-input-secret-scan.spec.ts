import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRecursiveInputResult,
  projectGitlinkGraph,
} from '../packages/recursive-input-contract/src/index.ts';
import { parseMaterializationFacts, produceRecursiveInputResult } from '../packages/recursive-input-contract/src/producer.ts';
import { createAttemptStore } from '../packages/recursive-input-contract/src/attempt-store.ts';

const ROOT = join(import.meta.dir, '..');
const secretPatterns = [
  'MIRROR_TOKEN',
  'INTERNAL_TOKEN',
  'Authorization',
  'x-access-token',
  'credential.helper',
  'core.sshCommand',
];
const roots: string[] = [];

function findSecretPatterns(value: string): string[] {
  return secretPatterns.filter((pattern) => value.includes(pattern));
}

function sourceAsDataStep(workflow: string): string {
  const start = workflow.indexOf('      - name: Mirror install smoke');
  const end = workflow.indexOf('      - name: Run the post-merge publish path', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recursive input secret canary', () => {
  test('keeps manifest, log, and shareable inputs secretless even when facts contain a canary', () => {
    const graph = projectGitlinkGraph({
      sourceIdentity: { repository: 'forgeax-studio', revision: 'secret-scan-root' },
      nodes: [{ path: 'packages/editor', pin: 'editor-pin' }],
    });
    const root = mkdtempSync(join(tmpdir(), 'forgeax-recursive-input-secret-scan-'));
    roots.push(root);
    const canary = 'FORGEAX_SECRET_CANARY_MUST_NOT_SERIALIZE';
    const facts = parseMaterializationFacts([
      'materialization_status=ready',
      'credential_cleanup=passed',
      `secret_canary=${canary}`,
    ].join('\n'));
    const produced = produceRecursiveInputResult({
      store: createAttemptStore(root),
      context: {
        graph,
        requestedInputClasses: ['source'],
        trustScope: 'ordinary-ci',
        job: 'secret-scan',
        attempt: 'canary-attempt',
      },
      producer: 'secret-scan',
      facts,
    });
    expect(produced.ok).toBe(true);

    const manifest = JSON.stringify(produced.result);
    const log = [
      `status=${produced.result.status}`,
      `input-digest=${produced.result.content.inputDigest}`,
      `readiness=${JSON.stringify(produced.result.readiness)}`,
    ].join('\n');
    const shareableInputs = JSON.stringify({
      content: produced.result.content,
      readiness: produced.result.readiness,
    });
    for (const [artifact, value] of Object.entries({ manifest, log, shareableInputs })) {
      expect(value).not.toContain(canary);
      expect(findSecretPatterns(value)).toEqual([]);
    }
  });

  test('does not expose protected credentials in the source-as-data producer step', () => {
    for (const relativePath of [
      '.github/workflows/mirror-publish-dryrun.yml',
      'scripts/mirror/ci/mirror-publish-dryrun.yml',
    ]) {
      const step = sourceAsDataStep(readFileSync(join(ROOT, relativePath), 'utf8'));
      expect(findSecretPatterns(step)).toEqual([]);
      expect(step).not.toContain('secrets.');
    }
  });

  test('keeps the canary out of a schema-valid source result', () => {
    const result = createRecursiveInputResult({
      graph: projectGitlinkGraph({
        sourceIdentity: { repository: 'forgeax-studio', revision: 'shareable-root' },
        nodes: [{ path: 'packages/editor', pin: 'editor-pin' }],
      }),
      requestedInputClasses: ['source'],
      trustScope: 'ordinary-ci',
      job: 'secret-scan',
      attempt: 'shareable-attempt',
      producer: 'secret-scan',
      readiness: { source: { status: 'ready' } },
    });
    expect(result.status).toBe('ready');
    expect(findSecretPatterns(JSON.stringify(result))).toEqual([]);
  });
});
