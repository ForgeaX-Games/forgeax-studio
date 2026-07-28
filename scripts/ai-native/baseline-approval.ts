import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { resolveEvidenceFileIfPresent } from './evidence-file.ts';
import { canonicalSha256 } from './runtime-snapshot-core.ts';
import { assertPinnedGovernanceArtifact } from './runtime-artifact-integrity.ts';
import type { GovernanceVerification } from './governance-git.ts';

export const BASELINE_APPROVAL_INPUTS = [
  'controls.jsonl',
  'effects.jsonl',
  'edges.jsonl',
  'manual-classification-pool.jsonl',
  'summary.md',
] as const;

const baselineIdSchema = z.string().regex(/^b[0-9]+-\d{4}-\d{2}-\d{2}-\d+\.\d+\.\d+$/);

const receiptFields = {
  approved_content_commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  approval_manifest_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  approval_scope_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  approval_package_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
} as const;

const baselineApprovalRecordBaseSchema = z.object({
  baseline_id: baselineIdSchema,
  baseline_bytes_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  decision_evidence: z.string().trim().min(1).nullable(),
  decision_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  ...receiptFields,
});

const emptyReceiptFields = {
  approved_content_commit: z.null(),
  approval_manifest_raw_sha256: z.null(),
  approval_scope_sha256: z.null(),
  approval_package_raw_sha256: z.null(),
} as const;

const baselineApprovalRecordSchema = z.discriminatedUnion('status', [
  baselineApprovalRecordBaseSchema.extend({
    status: z.literal('pending'),
    decision_evidence: z.null(),
    decision_evidence_sha256: z.null(),
    ...emptyReceiptFields,
  }).strict(),
  baselineApprovalRecordBaseSchema.extend({
    status: z.literal('approved'),
    decision_evidence: z.string().trim().min(1),
    decision_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    approved_content_commit: z.string().regex(/^[0-9a-f]{40}$/),
    approval_manifest_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    approval_scope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    approval_package_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  baselineApprovalRecordBaseSchema.extend({
    status: z.literal('approved-legacy-pre-receipt'),
    decision_evidence: z.string().trim().min(1),
    decision_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    ...emptyReceiptFields,
    legacy_receipt_reason: z.string().trim().min(1),
  }).strict(),
  baselineApprovalRecordBaseSchema.extend({
    status: z.literal('SUPERSEDED-pre-approval'),
    decision_evidence: z.null(),
    decision_evidence_sha256: z.null(),
    ...emptyReceiptFields,
    superseded_by: baselineIdSchema,
    supersession_reason: z.string().trim().min(1),
  }).strict(),
]);

const baselineApprovalsSchema = z.object({
  schema_version: z.literal(3),
  hash_algorithm: z.literal('sha256-canonical-file-manifest-v1'),
  baseline_files: z.tuple([
    z.literal('controls.jsonl'),
    z.literal('effects.jsonl'),
    z.literal('edges.jsonl'),
    z.literal('manual-classification-pool.jsonl'),
    z.literal('summary.md'),
  ]),
  records: z.array(baselineApprovalRecordSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const ids = value.records.map((record) => record.baseline_id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['records'], message: 'baseline_id values must be unique' });
  }
});

export type BaselineApprovalRecord = z.infer<typeof baselineApprovalRecordSchema>;
export type LoadedBaselineApproval = Omit<BaselineApprovalRecord, 'status'> & {
  status: BaselineApprovalRecord['status'] | 'unverified-diagnostic';
  recorded_status: BaselineApprovalRecord['status'];
  governance_verification: GovernanceVerification;
};

export function parseBaselineApprovalRecord(value: unknown): BaselineApprovalRecord {
  return baselineApprovalRecordSchema.parse(value);
}

export function parseBaselineApprovals(value: unknown): z.infer<typeof baselineApprovalsSchema> {
  return baselineApprovalsSchema.parse(value);
}

export function baselineBytesSha256(repoRoot: string, baselineId: string): string {
  const baselineRoot = join(resolve(repoRoot), 'docs/ai-native/baseline', baselineId);
  const manifest = BASELINE_APPROVAL_INPUTS.map((name) => ({
    path: `docs/ai-native/baseline/${baselineId}/${name}`,
    sha256: createHash('sha256').update(readFileSync(join(baselineRoot, name))).digest('hex'),
  }));
  return canonicalSha256(manifest);
}

export function loadBaselineApproval(
  repoRoot: string,
  baselineId: string,
  pinSource: string,
): LoadedBaselineApproval {
  const pinned = assertPinnedGovernanceArtifact(repoRoot, pinSource, 'baseline_approvals');
  const approvalsPath = join(resolve(repoRoot), pinned.path);
  const parsed = baselineApprovalsSchema.parse(JSON.parse(readFileSync(approvalsPath, 'utf8')) as unknown);
  const record = parsed.records.find((candidate) => candidate.baseline_id === baselineId);
  if (!record) throw new Error(`baseline approval record is missing: ${baselineId}`);
  const actualSha = baselineBytesSha256(repoRoot, baselineId);
  if (record.baseline_bytes_sha256 !== actualSha) {
    throw new Error(
      `baseline approval byte SHA mismatch for ${baselineId}: expected=${record.baseline_bytes_sha256} actual=${actualSha}`,
    );
  }
  if (record.status === 'approved' || record.status === 'approved-legacy-pre-receipt') {
    const evidence = resolveEvidenceFileIfPresent(repoRoot, record.decision_evidence!);
    if (evidence && evidence.sha256 !== record.decision_evidence_sha256) {
      throw new Error(
        `baseline approval decision evidence SHA-256 mismatch for ${baselineId}: `
        + `expected=${record.decision_evidence_sha256} actual=${evidence.sha256}`,
      );
    }
  }
  return {
    ...record,
    recorded_status: record.status,
    status: (record.status === 'approved' || record.status === 'approved-legacy-pre-receipt')
      && pinned.governanceVerification.status !== 'verified'
      ? 'unverified-diagnostic'
      : record.status,
    governance_verification: pinned.governanceVerification,
  };
}
