import { z } from 'zod';

export const LEDGER_V1_SURFACES = [
  'button',
  'dom',
  'link',
  'menu',
  'palette',
  'postmessage-handler',
  'rpc-handler',
  'shortcut',
  'subscription-handler',
] as const;

export const LEDGER_V1_DISPOSITIONS = [
  'tool',
  'read',
  'view-opt',
  'exempt:human-input',
  'exempt:inbound-sink',
  'exempt:editor-injected',
  'exempt:other-team',
] as const;

export const LEDGER_V1_AGENT_EQUIV = ['declared', 'verified', 'none'] as const;
export const LEDGER_V1_HEADLESS = ['yes', 'no', 'n-a'] as const;
export const LEDGER_V1_STATUSES = ['todo', 'exempt'] as const;
export const LEDGER_V1_OWNERS = [
  'us',
  'editor',
  'marketplace',
  'settings',
  'workbench',
  'dashboard',
  'server',
  'orchestrator',
  'other-team',
] as const;

const evidence = z.string().regex(
  /^[^\n]+:\d+ — \S.+$/,
  'evidence must be one file:line pointer, an em dash, and a non-empty basis sentence',
);

export const LedgerV1RowSchema = z.object({
  control_id: z.string().regex(/^ctl_[0-9a-f]{24}$/),
  surface: z.enum(LEDGER_V1_SURFACES),
  effect_id: z.string().trim().min(1),
  disposition: z.enum(LEDGER_V1_DISPOSITIONS),
  agent_equiv: z.enum(LEDGER_V1_AGENT_EQUIV),
  headless: z.enum(LEDGER_V1_HEADLESS),
  status: z.enum(LEDGER_V1_STATUSES),
  owner: z.enum(LEDGER_V1_OWNERS),
  evidence,
}).strict().superRefine((row, ctx) => {
  const excluded = row.disposition === 'view-opt' || row.disposition.startsWith('exempt:');
  const expected = excluded ? 'exempt' : 'todo';
  if (row.status !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: `status must be ${expected} for disposition ${row.disposition}`,
    });
  }
  if (row.effect_id === 'no-effect' && row.disposition !== 'exempt:inbound-sink') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['disposition'],
      message: 'no-effect rows must be audited event/integration sinks',
    });
  }
});

export type LedgerV1Row = z.infer<typeof LedgerV1RowSchema>;

export function parseLedgerV1Row(value: unknown): LedgerV1Row {
  return LedgerV1RowSchema.parse(value);
}
