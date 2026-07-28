#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseBaselineApprovals } from './baseline-approval.ts';
import { parseEffectAdjudication } from './effect-adjudication.schema.ts';
import { loadCurrentBaselineState } from './baseline-state.ts';

export const APPROVAL_MANIFEST_PATH = 'docs/ai-native/baseline/approval-manifest.json';
export const BASELINE_APPROVALS_PATH = 'docs/ai-native/baseline/approvals.json';
export const APPROVAL_PACKAGE_PATH =
  'docs/ai-native/evidence/2026-07-25-m2-phase2-approval-package.md';
export const FINAL_EXECUTION_REPORT_PATH =
  'docs/ai-native/evidence/2026-07-25-m2-phase2-final-execution-report.md';
export const PHASE2_METRICS_PATH =
  'docs/ai-native/evidence/2026-07-25-m2-phase2-approval-metrics.json';
export const GATE_LOG_DIRECTORY =
  'docs/ai-native/evidence/2026-07-25-p2e-gates';
export const PHASE2_DELIVERY_SURFACE_PATHS = [
  PHASE2_METRICS_PATH,
  FINAL_EXECUTION_REPORT_PATH,
  APPROVAL_PACKAGE_PATH,
  APPROVAL_MANIFEST_PATH,
] as const;

const ROOT = resolve(import.meta.dir, '../..');
const CURRENT_BASELINE_STATE = loadCurrentBaselineState(ROOT);
export const CURRENT_BASELINE_ID = CURRENT_BASELINE_STATE.currentBaselineId;
export const CURRENT_BASELINE_DIRECTORY = `docs/ai-native/baseline/${CURRENT_BASELINE_ID}`;

export const EFFECT_ADJUDICATIONS_PATH =
  'scripts/ai-native/effect-adjudications-v1.jsonl';
export const CAPABILITY_BASELINE_PATH =
  'scripts/ai-native/capability-baseline.json';
export const R6_COVERAGE_PATH = 'scripts/ai-native/r6-coverage.json';
export const DECISION_SOURCE_PATHS = [
  EFFECT_ADJUDICATIONS_PATH,
  CAPABILITY_BASELINE_PATH,
  R6_COVERAGE_PATH,
] as const;

const SHA256_RE = /^[0-9a-f]{64}$/;
const EFFECT_ID_RE = /^[a-z0-9_]+(?:[.:_-][a-z0-9_]+)+$/;
const CONTROL_ID_RE = /^ctl_[0-9a-f]{24}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const RECEIPT_MARKER = '<!-- forgeax-phase2-approval-receipt-v1 -->';

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(object[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value: unknown): string {
  return sha256(stableStringify(value));
}

function codePointSort(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function assertUniqueSorted(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  if (stableStringify(values) !== stableStringify(codePointSort(values))) {
    throw new Error(`${label} must be code-point sorted`);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonLines(bytes: Uint8Array, label: string): unknown[] {
  return Buffer.from(bytes).toString('utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (error) {
      throw new Error(
        `${label}:${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

const capabilityBaselineSchema = z.object({
  schema_version: z.literal(1),
  baseline_id: z.literal(CURRENT_BASELINE_ID),
  source: z.string().trim().min(1),
  invariant: z.string().trim().min(1),
  previous_sha256: z.string().regex(SHA256_RE),
  control_count: z.number().int().nonnegative(),
  unmigrated_control_ids: z.array(z.string().regex(CONTROL_ID_RE)),
}).strict();

const r6DecisionSchema = z.object({
  baseline_id: z.literal(CURRENT_BASELINE_ID),
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  coverage_percent: z.number().nonnegative(),
  exclusion_disclosure: z.object({
    included_dispositions: z.array(z.string().trim().min(1)).min(1),
    excluded_effects_by_disposition: z.record(z.number().int().nonnegative()),
  }).passthrough(),
  migrated_effect_ids: z.array(z.string().regex(EFFECT_ID_RE)),
  migrated_control_ids: z.array(z.string().regex(CONTROL_ID_RE)),
}).passthrough();

export interface DecisionObject {
  schema_version: 1;
  baseline_id: string;
  effect_adjudications: Array<{
    effect_id: string;
    disposition: string;
    basis: string;
  }>;
  capability_ratchet: {
    unmigrated_control_ids: string[];
  };
  coverage: {
    included_dispositions: string[];
    denominator: number;
    migrated_effect_ids: string[];
  };
}

export interface ApprovalSource {
  read(path: string): Uint8Array;
  list(directory: string): string[];
  atRevision?(revision: string): ApprovalSource;
  revisionExists?(revision: string): boolean;
  isAncestor?(revision: string): boolean;
}

export function buildDecisionObject(source: ApprovalSource): DecisionObject {
  const effectRows = parseJsonLines(
    source.read(EFFECT_ADJUDICATIONS_PATH),
    EFFECT_ADJUDICATIONS_PATH,
  ).map((value, index) => {
    try {
      return parseEffectAdjudication(value);
    } catch (error) {
      throw new Error(
        `${EFFECT_ADJUDICATIONS_PATH}:${index + 1} is invalid: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  if (effectRows.some((row) => row.baseline_id !== CURRENT_BASELINE_ID)) {
    throw new Error('effect adjudication baseline_id disagrees with the current baseline');
  }
  const effectIds = effectRows.map((row) => row.effect_id);
  if (new Set(effectIds).size !== effectIds.length) {
    throw new Error('effect adjudications contain duplicate effect_id values');
  }
  const effectAdjudications = effectRows
    .map((row) => ({
      effect_id: row.effect_id,
      disposition: row.disposition,
      basis: row.evidence,
    }))
    .sort((left, right) => left.effect_id < right.effect_id ? -1 : left.effect_id > right.effect_id ? 1 : 0);

  const capability = capabilityBaselineSchema.parse(parseJson(
    source.read(CAPABILITY_BASELINE_PATH),
    CAPABILITY_BASELINE_PATH,
  ));
  assertUniqueSorted(capability.unmigrated_control_ids, 'unmigrated_control_ids');
  if (capability.control_count !== capability.unmigrated_control_ids.length) {
    throw new Error(
      `capability baseline control_count mismatch: `
      + `declared=${capability.control_count} actual=${capability.unmigrated_control_ids.length}`,
    );
  }

  const coverage = r6DecisionSchema.parse(parseJson(
    source.read(R6_COVERAGE_PATH),
    R6_COVERAGE_PATH,
  ));
  const includedDispositions = codePointSort(coverage.exclusion_disclosure.included_dispositions);
  assertUniqueSorted(includedDispositions, 'included_dispositions');
  const included = new Set(includedDispositions);
  const denominator = effectRows.filter((row) => included.has(row.disposition)).length;
  if (coverage.denominator !== denominator) {
    throw new Error(
      `R6 denominator disagrees with the adjudication table and included dispositions: `
      + `declared=${coverage.denominator} derived=${denominator}`,
    );
  }
  const migratedEffectIds = codePointSort(coverage.migrated_effect_ids);
  assertUniqueSorted(migratedEffectIds, 'migrated_effect_ids');
  if (coverage.numerator !== migratedEffectIds.length) {
    throw new Error(
      `R6 numerator disagrees with migrated_effect_ids: `
      + `declared=${coverage.numerator} actual=${migratedEffectIds.length}`,
    );
  }
  const decisionByEffect = new Map(effectRows.map((row) => [row.effect_id, row] as const));
  for (const effectId of migratedEffectIds) {
    const row = decisionByEffect.get(effectId);
    if (!row) throw new Error(`migrated effect has no adjudication: ${effectId}`);
    if (!included.has(row.disposition)) {
      throw new Error(`migrated effect is outside the denominator: ${effectId}/${row.disposition}`);
    }
  }

  return {
    schema_version: 1,
    baseline_id: CURRENT_BASELINE_ID,
    effect_adjudications: effectAdjudications,
    capability_ratchet: {
      unmigrated_control_ids: capability.unmigrated_control_ids,
    },
    coverage: {
      included_dispositions: includedDispositions,
      denominator,
      migrated_effect_ids: migratedEffectIds,
    },
  };
}

const semanticFileSchema = z.object({
  path: z.enum(DECISION_SOURCE_PATHS),
  sha256: z.string().regex(SHA256_RE),
}).strict();

const manifestSchema = z.object({
  schema_version: z.literal(3),
  hash_algorithm: z.literal('sha256-canonical-decision-object-v1'),
  approval_scope_sha256: z.string().regex(SHA256_RE),
  files: z.array(semanticFileSchema).length(DECISION_SOURCE_PATHS.length),
  decision_summary: z.object({
    baseline_id: z.literal(CURRENT_BASELINE_ID),
    effect_adjudications: z.number().int().nonnegative(),
    unmigrated_controls: z.number().int().nonnegative(),
    migrated_effects: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    included_dispositions: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
}).strict();

export type ApprovalManifest = z.infer<typeof manifestSchema>;

function semanticSourceHashes(decision: DecisionObject): ApprovalManifest['files'] {
  const values = new Map<string, unknown>([
    [EFFECT_ADJUDICATIONS_PATH, decision.effect_adjudications],
    [CAPABILITY_BASELINE_PATH, decision.capability_ratchet],
    [R6_COVERAGE_PATH, decision.coverage],
  ]);
  return DECISION_SOURCE_PATHS.map((path) => ({
    path,
    sha256: canonicalSha256(values.get(path)),
  }));
}

export function approvalScopeSha256(value: DecisionObject | ApprovalManifest['files']): string {
  if (Array.isArray(value)) return canonicalSha256(value);
  return canonicalSha256(value);
}

export function buildApprovalManifest(
  source: ApprovalSource,
  _sourceHeadSha?: string,
  _generatedAt?: string,
): ApprovalManifest {
  const decision = buildDecisionObject(source);
  return manifestSchema.parse({
    schema_version: 3,
    hash_algorithm: 'sha256-canonical-decision-object-v1',
    approval_scope_sha256: approvalScopeSha256(decision),
    files: semanticSourceHashes(decision),
    decision_summary: {
      baseline_id: decision.baseline_id,
      effect_adjudications: decision.effect_adjudications.length,
      unmigrated_controls: decision.capability_ratchet.unmigrated_control_ids.length,
      migrated_effects: decision.coverage.migrated_effect_ids.length,
      denominator: decision.coverage.denominator,
      included_dispositions: decision.coverage.included_dispositions,
    },
  });
}

export function buildApprovalManifestFromMetrics(source: ApprovalSource): ApprovalManifest {
  return buildApprovalManifest(source);
}

export function renderApprovalManifest(manifest: ApprovalManifest): string {
  return `${JSON.stringify(manifestSchema.parse(manifest), null, 2)}\n`;
}

export function verifyApprovalManifest(value: unknown, source: ApprovalSource): ApprovalManifest {
  const manifest = manifestSchema.parse(value);
  const expected = buildApprovalManifest(source);
  if (stableStringify(manifest.files) !== stableStringify(expected.files)) {
    throw new Error('approval manifest semantic source hash mismatch');
  }
  if (manifest.approval_scope_sha256 !== expected.approval_scope_sha256) {
    throw new Error(
      `approval decision signature mismatch: `
      + `expected=${expected.approval_scope_sha256} actual=${manifest.approval_scope_sha256}`,
    );
  }
  if (stableStringify(manifest.decision_summary) !== stableStringify(expected.decision_summary)) {
    throw new Error('approval manifest decision summary mismatch');
  }
  verifyApprovedContentCommitAnchors(source);
  return manifest;
}

export function verifyApprovedContentCommitAnchors(source: ApprovalSource): void {
  const approvals = parseBaselineApprovals(parseJson(
    source.read(BASELINE_APPROVALS_PATH),
    BASELINE_APPROVALS_PATH,
  ));
  const approved = approvals.records.filter((record) => record.status === 'approved');
  if (approved.length > 0 && (!source.revisionExists || !source.isAncestor)) {
    throw new Error('approved content commit validation requires commit existence and HEAD ancestry support');
  }
  for (const record of approved) {
    const revision = record.approved_content_commit;
    if (!source.revisionExists!(revision)) {
      throw new Error(
        `approved content commit does not exist: baseline=${record.baseline_id} commit=${revision}`,
      );
    }
    if (!source.isAncestor!(revision)) {
      throw new Error(
        `approved content commit is not an ancestor of current HEAD: `
        + `baseline=${record.baseline_id} commit=${revision}`,
      );
    }
  }
}

function gitExitStatus(root: string, args: string[]): number {
  const result = spawnSync('git', args, {
    cwd: root,
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`git ${args[0]} terminated without an exit status`);
  return result.status;
}

export function worktreeSource(root: string): ApprovalSource {
  const repositoryRoot = resolve(root);
  return {
    read(path: string) {
      return readFileSync(resolve(repositoryRoot, path));
    },
    list(directory: string) {
      return readdirSync(resolve(repositoryRoot, directory)).sort();
    },
    revisionExists(revision: string) {
      return gitExitStatus(repositoryRoot, ['cat-file', '-e', `${revision}^{commit}`]) === 0;
    },
    isAncestor(revision: string) {
      return gitExitStatus(
        repositoryRoot,
        ['merge-base', '--is-ancestor', revision, 'HEAD'],
      ) === 0;
    },
  };
}

export const COMPOUND_APPROVAL_ID_ALGORITHM = 'sha256-scope-and-package-components-v1';
const approvalReceiptSchema = z.object({
  protocol: z.literal('forgeax-phase2-approval-receipt-v1'),
  status: z.enum(['pending', 'approved']),
  compound_algorithm: z.literal(COMPOUND_APPROVAL_ID_ALGORITHM),
  source_head_binding: z.literal('provenance-only-not-approval-binding'),
  package_hash_semantics: z.enum([
    'validator-computed-pending-package-raw-bytes',
    'replayed-pending-package-raw-bytes',
  ]),
  approved_content_commit: z.string().regex(COMMIT_RE).nullable(),
  approval_manifest_raw_sha256: z.string().regex(SHA256_RE).nullable(),
  approval_scope_sha256: z.string().regex(SHA256_RE),
  approval_package_raw_sha256: z.string().regex(SHA256_RE).nullable(),
  compound_approval_id: z.string().regex(SHA256_RE).nullable(),
}).strict();

export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;

export interface ApprovedReceiptValues {
  approved_content_commit: string;
  approval_manifest_raw_sha256: string;
  approval_scope_sha256: string;
  approval_package_raw_sha256: string;
}

export function compoundApprovalIdentifier(
  approvalScopeSha256: string,
  approvalPackageRawSha256: string,
): string {
  if (!SHA256_RE.test(approvalScopeSha256) || !SHA256_RE.test(approvalPackageRawSha256)) {
    throw new Error('compound approval identifier requires two lowercase SHA-256 components');
  }
  return canonicalSha256({
    algorithm: COMPOUND_APPROVAL_ID_ALGORITHM,
    approval_package_raw_sha256: approvalPackageRawSha256,
    approval_scope_sha256: approvalScopeSha256,
  });
}

export function pendingApprovalReceipt(approvalScopeSha256: string): ApprovalReceipt {
  return approvalReceiptSchema.parse({
    protocol: 'forgeax-phase2-approval-receipt-v1',
    status: 'pending',
    compound_algorithm: COMPOUND_APPROVAL_ID_ALGORITHM,
    source_head_binding: 'provenance-only-not-approval-binding',
    package_hash_semantics: 'validator-computed-pending-package-raw-bytes',
    approved_content_commit: null,
    approval_manifest_raw_sha256: null,
    approval_scope_sha256: approvalScopeSha256,
    approval_package_raw_sha256: null,
    compound_approval_id: null,
  });
}

export function approvedApprovalReceipt(record: ApprovedReceiptValues): ApprovalReceipt {
  return approvalReceiptSchema.parse({
    protocol: 'forgeax-phase2-approval-receipt-v1',
    status: 'approved',
    compound_algorithm: COMPOUND_APPROVAL_ID_ALGORITHM,
    source_head_binding: 'provenance-only-not-approval-binding',
    package_hash_semantics: 'replayed-pending-package-raw-bytes',
    approved_content_commit: record.approved_content_commit,
    approval_manifest_raw_sha256: record.approval_manifest_raw_sha256,
    approval_scope_sha256: record.approval_scope_sha256,
    approval_package_raw_sha256: record.approval_package_raw_sha256,
    compound_approval_id: compoundApprovalIdentifier(
      record.approval_scope_sha256,
      record.approval_package_raw_sha256,
    ),
  });
}

export function renderApprovalReceipt(receipt: ApprovalReceipt): string {
  return `${RECEIPT_MARKER}\n\n\`\`\`json\n${JSON.stringify(approvalReceiptSchema.parse(receipt), null, 2)}\n\`\`\``;
}

export function parseApprovalReceipt(markdown: string): ApprovalReceipt {
  const escapedMarker = RECEIPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escapedMarker}\\s*\\n\\s*` + '```json\\n([\\s\\S]*?)\\n```',
    'g',
  );
  const matches = [...markdown.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'approval package is missing the authoritative approval receipt'
        : 'approval package contains duplicate authoritative approval receipts',
    );
  }
  return approvalReceiptSchema.parse(JSON.parse(matches[0]![1]!));
}

export function isPullRequestWorkflowUnconditional(workflow: string): boolean {
  const lines = workflow.split('\n');
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onIndex < 0) return false;
  const onLines = lines.slice(onIndex + 1);
  const end = onLines.findIndex((line) => /^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(line));
  const triggerLines = end < 0 ? onLines : onLines.slice(0, end);
  const pullIndex = triggerLines.findIndex((line) => /^\s+pull_request:\s*(?:\{\})?\s*$/.test(line));
  if (pullIndex < 0) return false;
  const pullIndent = /^\s*/.exec(triggerLines[pullIndex]!)![0].length;
  for (const line of triggerLines.slice(pullIndex + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = /^\s*/.exec(line)![0].length;
    if (indent <= pullIndent) break;
    if (/^\s+paths(?:-ignore)?:\s*/.test(line)) return false;
  }
  return true;
}

function usage(): never {
  console.error('usage: bun scripts/ai-native/verify-approval-manifest.ts [--write]');
  process.exit(2);
}

function main(argv: string[]): void {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--write')) usage();
  const source = worktreeSource(ROOT);
  if (argv[0] === '--write') {
    const manifest = buildApprovalManifest(source);
    writeFileSync(resolve(ROOT, APPROVAL_MANIFEST_PATH), renderApprovalManifest(manifest));
    process.stdout.write(
      `[approval-manifest] WROTE decisions=${manifest.decision_summary.effect_adjudications} `
      + `ratchet=${manifest.decision_summary.unmigrated_controls} `
      + `scope=${manifest.approval_scope_sha256}\n`,
    );
    return;
  }
  const value = parseJson(source.read(APPROVAL_MANIFEST_PATH), APPROVAL_MANIFEST_PATH);
  const manifest = verifyApprovalManifest(value, source);
  process.stdout.write(
    `[approval-manifest] PASS decisions=${manifest.decision_summary.effect_adjudications} `
    + `ratchet=${manifest.decision_summary.unmigrated_controls} `
    + `scope=${manifest.approval_scope_sha256}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[approval-manifest] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
