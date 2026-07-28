import { z } from 'zod';
import {
  LEDGER_V1_AGENT_EQUIV,
  LEDGER_V1_DISPOSITIONS,
  LEDGER_V1_HEADLESS,
} from './ledger-v1.schema';

export const EFFECT_ADJUDICATION_VERSION = 1 as const;

const baselineId = z.string().regex(
  /^b[0-9]+-\d{4}-\d{2}-\d{2}-\d+\.\d+\.\d+$/,
  'baseline_id must match b<series>-YYYY-MM-DD-<semver>',
);

export const EffectAdjudicationV1Schema = z.object({
  schema_version: z.literal(EFFECT_ADJUDICATION_VERSION),
  baseline_id: baselineId,
  effect_id: z.string().trim().min(1),
  domain: z.string().trim().min(1),
  disposition: z.enum(LEDGER_V1_DISPOSITIONS),
  agent_equiv: z.enum(LEDGER_V1_AGENT_EQUIV),
  headless: z.enum(LEDGER_V1_HEADLESS),
  certainty: z.literal('adjudicated'),
  verification_evidence_manifest_id: z.string().trim().min(1).optional(),
  profile_observation: z.object({
    status: z.literal('exposed/reachable'),
    tool_names: z.array(z.string().trim().min(1)).min(1).superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool_names must not contain duplicates' });
      }
    }),
  }).strict().optional(),
  evidence: z.string().regex(
    /^[^\n]+:\d+ — \S.+$/,
    'evidence must be one file:line pointer, an em dash, and a non-empty basis sentence',
  ),
}).strict().superRefine((row, ctx) => {
  if ((row.agent_equiv === 'verified') !== (row.verification_evidence_manifest_id !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verification_evidence_manifest_id'],
      message: 'must be present exactly when agent_equiv is verified',
    });
  }
});

export type EffectAdjudicationV1 = z.infer<typeof EffectAdjudicationV1Schema>;

export function parseEffectAdjudication(value: unknown): EffectAdjudicationV1 {
  return EffectAdjudicationV1Schema.parse(value);
}
