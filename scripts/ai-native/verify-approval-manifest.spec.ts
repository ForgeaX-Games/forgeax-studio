import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  APPROVAL_MANIFEST_PATH,
  BASELINE_APPROVALS_PATH,
  CAPABILITY_BASELINE_PATH,
  CURRENT_BASELINE_ID,
  DECISION_SOURCE_PATHS,
  EFFECT_ADJUDICATIONS_PATH,
  R6_COVERAGE_PATH,
  approvedApprovalReceipt,
  buildApprovalManifest,
  buildDecisionObject,
  compoundApprovalIdentifier,
  parseApprovalReceipt,
  pendingApprovalReceipt,
  renderApprovalManifest,
  renderApprovalReceipt,
  stableStringify,
  verifyApprovalManifest,
  type ApprovalSource,
} from './verify-approval-manifest.ts';

const ROOT = resolve(import.meta.dir, '../..');
const encoder = new TextEncoder();

function repositoryFiles(): Map<string, Uint8Array> {
  return new Map([
    ...DECISION_SOURCE_PATHS.map((path) => [path, readFileSync(resolve(ROOT, path))] as const),
    [APPROVAL_MANIFEST_PATH, readFileSync(resolve(ROOT, APPROVAL_MANIFEST_PATH))],
    [BASELINE_APPROVALS_PATH, readFileSync(resolve(ROOT, BASELINE_APPROVALS_PATH))],
  ]);
}

function source(
  files: Map<string, Uint8Array> = repositoryFiles(),
  revisions: {
    exists?: (revision: string) => boolean;
    isAncestor?: (revision: string) => boolean;
  } = {},
): ApprovalSource {
  return {
    read(path: string) {
      const value = files.get(path);
      if (!value) throw new Error(`fixture path missing: ${path}`);
      return value;
    },
    list() {
      return [];
    },
    revisionExists(revision: string) {
      return revisions.exists?.(revision) ?? true;
    },
    isAncestor(revision: string) {
      return revisions.isAncestor?.(revision) ?? true;
    },
  };
}

function json<T>(files: Map<string, Uint8Array>, path: string): T {
  return JSON.parse(Buffer.from(files.get(path)!).toString('utf8')) as T;
}

function writeJson(files: Map<string, Uint8Array>, path: string, value: unknown): void {
  files.set(path, encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
}

function manifest(files: Map<string, Uint8Array> = repositoryFiles()) {
  return buildApprovalManifest(source(files));
}

describe('semantic approval decision signature', () => {
  test('binds the complete current decisions, ratchet, migrated set, and denominator policy', () => {
    const decision = buildDecisionObject(source());
    expect(decision.baseline_id).toBe(CURRENT_BASELINE_ID);
    expect(decision.effect_adjudications).toHaveLength(383);
    expect(decision.capability_ratchet.unmigrated_control_ids).toHaveLength(627);
    expect(decision.coverage.migrated_effect_ids).toEqual(['role.create', 'role.list']);
    expect(decision.coverage.included_dispositions).toEqual(['read', 'tool']);
    expect(decision.coverage.denominator).toBe(87);

    const value = manifest();
    expect(value.hash_algorithm).toBe('sha256-canonical-decision-object-v1');
    expect(value.files.map((entry) => entry.path)).toEqual([...DECISION_SOURCE_PATHS]);
    expect(verifyApprovalManifest(value, source())).toEqual(value);
    expect(renderApprovalManifest(value)).toBe(
      readFileSync(resolve(ROOT, APPROVAL_MANIFEST_PATH), 'utf8'),
    );
  });

  test('changing one disposition is rejected even when every source remains valid', () => {
    const files = repositoryFiles();
    const lines = Buffer.from(files.get(EFFECT_ADJUDICATIONS_PATH)!).toString('utf8').trim().split('\n');
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    row.disposition = row.disposition === 'view-opt' ? 'exempt:human-input' : 'view-opt';
    lines[0] = JSON.stringify(row);
    files.set(EFFECT_ADJUDICATIONS_PATH, encoder.encode(`${lines.join('\n')}\n`));
    expect(() => verifyApprovalManifest(manifest(), source(files))).toThrow(
      'approval manifest semantic source hash mismatch',
    );
  });

  test('deleting one unmigrated control id is rejected', () => {
    const files = repositoryFiles();
    const capability = json<{
      control_count: number;
      unmigrated_control_ids: string[];
    }>(files, CAPABILITY_BASELINE_PATH);
    capability.unmigrated_control_ids.splice(13, 1);
    capability.control_count -= 1;
    writeJson(files, CAPABILITY_BASELINE_PATH, capability);
    expect(() => verifyApprovalManifest(manifest(), source(files))).toThrow(
      'approval manifest semantic source hash mismatch',
    );
  });

  test('regenerating an artifact without changing its decisions still passes', () => {
    const files = repositoryFiles();
    const coverage = json<Record<string, unknown>>(files, R6_COVERAGE_PATH);
    coverage.coverage_percent = 2.300000;
    coverage.domains = [];
    coverage.evaluations = [{ regenerated: true, coordinates: 'moved' }];
    coverage.test_runs = [];
    coverage.runtime_snapshot_diagnostics = [{ regenerated: true }];
    writeJson(files, R6_COVERAGE_PATH, coverage);
    expect(verifyApprovalManifest(manifest(), source(files))).toEqual(manifest());
  });

  test('source formatting and row order do not change the decision signature', () => {
    const files = repositoryFiles();
    const rows = Buffer.from(files.get(EFFECT_ADJUDICATIONS_PATH)!).toString('utf8').trim().split('\n');
    files.set(EFFECT_ADJUDICATIONS_PATH, encoder.encode(`${rows.reverse().join('\n\n')}\n`));
    const capability = json<Record<string, unknown>>(files, CAPABILITY_BASELINE_PATH);
    files.set(CAPABILITY_BASELINE_PATH, encoder.encode(JSON.stringify(capability)));
    expect(verifyApprovalManifest(manifest(), source(files))).toEqual(manifest());
  });

  test('changing an adjudication basis is rejected', () => {
    const files = repositoryFiles();
    const lines = Buffer.from(files.get(EFFECT_ADJUDICATIONS_PATH)!).toString('utf8').trim().split('\n');
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    row.evidence = String(row.evidence).replace(' — ', ' — reviewed again: ');
    lines[0] = JSON.stringify(row);
    files.set(EFFECT_ADJUDICATIONS_PATH, encoder.encode(`${lines.join('\n')}\n`));
    expect(() => verifyApprovalManifest(manifest(), source(files))).toThrow(
      'approval manifest semantic source hash mismatch',
    );
  });

  test('fails closed on a denominator that disagrees with the adjudication policy', () => {
    const files = repositoryFiles();
    const coverage = json<{ denominator: number }>(files, R6_COVERAGE_PATH);
    coverage.denominator += 1;
    writeJson(files, R6_COVERAGE_PATH, coverage);
    expect(() => buildDecisionObject(source(files))).toThrow(
      'R6 denominator disagrees with the adjudication table and included dispositions',
    );
  });

  test('fails closed on duplicate decision identities', () => {
    const effectFiles = repositoryFiles();
    const effectLines = Buffer.from(effectFiles.get(EFFECT_ADJUDICATIONS_PATH)!).toString('utf8').trim().split('\n');
    effectFiles.set(
      EFFECT_ADJUDICATIONS_PATH,
      encoder.encode(`${effectLines[0]}\n${effectLines.join('\n')}\n`),
    );
    expect(() => buildDecisionObject(source(effectFiles))).toThrow(
      'effect adjudications contain duplicate effect_id values',
    );

    const ratchetFiles = repositoryFiles();
    const capability = json<{
      control_count: number;
      unmigrated_control_ids: string[];
    }>(ratchetFiles, CAPABILITY_BASELINE_PATH);
    capability.unmigrated_control_ids[1] = capability.unmigrated_control_ids[0]!;
    writeJson(ratchetFiles, CAPABILITY_BASELINE_PATH, capability);
    expect(() => buildDecisionObject(source(ratchetFiles))).toThrow(
      'unmigrated_control_ids contains duplicates',
    );
  });

  test('canonical rendering is stable', () => {
    const first = manifest();
    const second = manifest();
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(renderApprovalManifest(first)).toBe(renderApprovalManifest(second));
  });

  test('rejects an approved content commit that does not exist', () => {
    const files = repositoryFiles();
    const approvals = json<{ records: Array<Record<string, unknown>> }>(
      files,
      BASELINE_APPROVALS_PATH,
    );
    const missing = 'd'.repeat(40);
    const current = approvals.records.find((record) => record.baseline_id === CURRENT_BASELINE_ID)!;
    current.approved_content_commit = missing;
    writeJson(files, BASELINE_APPROVALS_PATH, approvals);

    expect(() => verifyApprovalManifest(manifest(), source(files, {
      exists: (revision) => revision !== missing,
    }))).toThrow(`approved content commit does not exist: baseline=${CURRENT_BASELINE_ID} commit=${missing}`);
  });

  test('rejects an approved content commit that exists but is not a HEAD ancestor', () => {
    const files = repositoryFiles();
    const approvals = json<{ records: Array<Record<string, unknown>> }>(
      files,
      BASELINE_APPROVALS_PATH,
    );
    const nonAncestor = 'e'.repeat(40);
    const current = approvals.records.find((record) => record.baseline_id === CURRENT_BASELINE_ID)!;
    current.approved_content_commit = nonAncestor;
    writeJson(files, BASELINE_APPROVALS_PATH, approvals);

    expect(() => verifyApprovalManifest(manifest(), source(files, {
      isAncestor: (revision) => revision !== nonAncestor,
    }))).toThrow(
      `approved content commit is not an ancestor of current HEAD: `
      + `baseline=${CURRENT_BASELINE_ID} commit=${nonAncestor}`,
    );
  });
});

describe('legacy receipt rendering compatibility', () => {
  test('keeps package receipt rendering deterministic without putting package bytes in the decision signature', () => {
    const scope = manifest().approval_scope_sha256;
    const pending = pendingApprovalReceipt(scope);
    expect(parseApprovalReceipt(renderApprovalReceipt(pending))).toEqual(pending);

    const approved = approvedApprovalReceipt({
      approved_content_commit: '1'.repeat(40),
      approval_manifest_raw_sha256: '2'.repeat(64),
      approval_scope_sha256: scope,
      approval_package_raw_sha256: '3'.repeat(64),
    });
    expect(parseApprovalReceipt(renderApprovalReceipt(approved))).toEqual(approved);
    expect(approved.compound_approval_id).toBe(
      compoundApprovalIdentifier(scope, '3'.repeat(64)),
    );
  });
});
