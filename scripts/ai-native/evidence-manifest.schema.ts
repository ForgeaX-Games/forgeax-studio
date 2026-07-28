import { z } from 'zod';

export const EVIDENCE_MANIFEST_VERSION = 1 as const;

export const EVIDENCE_STATUSES = ['migrated', 'unmigrated', 'exempt'] as const;
export const EQUIVALENT_KINDS = ['action', 'tool', 'headless', 'none'] as const;
export const TRUST_TIERS = ['own', 'imported'] as const;
export const DIRECT_CALL_RESIDUAL_STATUSES = ['none', 'present', 'unknown'] as const;
export const VERIFICATION_LEVELS = [
  'static-route-proof',
  'isolated-fixture-run',
  'human-authorized-run',
  'external-unverified',
] as const;
export const TOOL_SOURCES = [
  'builtin',
  'product-shell',
  'catalog-firstclass',
  'plugin',
  'soul-pack',
  'skill',
] as const;

const nonEmptyString = z.string().trim().min(1);
const nullableNonEmptyString = nonEmptyString.nullable();
const scannerBaselineId = z.string().regex(
  /^b[0-9]+-\d{4}-\d{2}-\d{2}-\d+\.\d+\.\d+$/,
  'baseline_id must match b<series>-YYYY-MM-DD-<semver>',
);
const uniqueStringArray = z.array(nonEmptyString).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain duplicates' });
  }
});

const testClaimSchema = z.object({
  test_id: nonEmptyString,
  proves_effect_ids: uniqueStringArray,
}).strict();

const mappingSchema = z.object({
  effect_id: nonEmptyString,
  control_ids: uniqueStringArray,
  handler_ids: uniqueStringArray,
  tests: z.array(testClaimSchema).superRefine((values, ctx) => {
    const ids = values.map((value) => value.test_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'test_id values must not contain duplicates' });
    }
  }),
}).strict();

const equivalentSchema = z.object({
  kind: z.enum(EQUIVALENT_KINDS),
  id: nullableNonEmptyString,
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'none') !== (value.id === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'must be null exactly when kind is none',
    });
  }
});

const contextSchema = z.object({
  agent_id: nonEmptyString,
  trust_tier: z.enum(TRUST_TIERS),
  session_id: nullableNonEmptyString,
  game_slug: nullableNonEmptyString,
}).strict();

const residualSchema = z.object({
  status: z.enum(DIRECT_CALL_RESIDUAL_STATUSES),
  evidence_refs: uniqueStringArray,
}).strict();

const formalCaptureSchema = z.object({
  child_stderr_sha256: z.tuple([
    z.object({ index: z.literal(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    z.object({ index: z.literal(2), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  ]),
}).strict();

export const EvidenceManifestV1Schema = z.object({
  schema_version: z.literal(EVIDENCE_MANIFEST_VERSION),
  manifest_id: nonEmptyString,
  baseline_id: scannerBaselineId,
  status: z.enum(EVIDENCE_STATUSES),
  mapping: mappingSchema,
  equivalent: equivalentSchema,
  context: contextSchema,
  wire_name: nullableNonEmptyString,
  direct_call_residual: residualSchema,
  verification_level: z.enum(VERIFICATION_LEVELS),
  profile_id: nonEmptyString,
  reproduction_key_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256'),
  formal_capture: formalCaptureSchema.optional(),
  tool_source: z.enum(TOOL_SOURCES),
  qualifies_for_verified_equivalence: z.boolean(),
  evidence_refs: uniqueStringArray,
}).strict().superRefine((value, ctx) => {
  if (value.status === 'migrated') {
    for (const field of ['control_ids', 'handler_ids', 'tests'] as const) {
      if (value.mapping[field].length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mapping', field],
          message: 'migrated evidence requires a non-empty mapping chain',
        });
      }
    }
    if (value.direct_call_residual.status !== 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direct_call_residual', 'status'],
        message: 'migrated evidence requires direct_call_residual.status none',
      });
    }
    if (value.evidence_refs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence_refs'],
        message: 'migrated evidence requires at least one evidence reference',
      });
    }
  }
  if (value.qualifies_for_verified_equivalence) {
    if (value.equivalent.kind === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['qualifies_for_verified_equivalence'],
        message: 'verified equivalence requires an equivalent',
      });
    }
    if (!['isolated-fixture-run', 'human-authorized-run'].includes(value.verification_level)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verification_level'],
        message: 'verified equivalence requires an isolated-fixture-run or human-authorized-run',
      });
    }
    if (
      (value.equivalent.kind === 'action' || value.equivalent.kind === 'tool')
      && value.wire_name === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['wire_name'],
        message: 'verified action/tool equivalence requires a wire_name',
      });
    }
  }
});

export type EvidenceManifestV1 = z.infer<typeof EvidenceManifestV1Schema>;

export function parseEvidenceManifest(value: unknown): EvidenceManifestV1 {
  return EvidenceManifestV1Schema.parse(value);
}
