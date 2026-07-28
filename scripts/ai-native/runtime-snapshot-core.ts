import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveEvidenceFile } from './evidence-file.ts';

export type RuntimeProfileStatus = 'proposed' | 'approved';

export interface RuntimeToolAccounting {
  mapped_effects?: string[];
  explicit_out_of_scope_reason?: string;
}

export interface RuntimeFormalWaiver {
  waived_blockers: ['extension-kind-issues'];
  waived_instances: string[];
  max_count: number;
  reason: string;
  issuer: 'supervisory-lane';
  date: string;
}

interface RuntimeProfileApprovalRecordBase {
  approver: 'supervisory-lane(orchestration)';
  date: string;
  profile_sha256: string;
  channel: 'orchestration session 2026-07-23';
}

export type RuntimeProfileApprovalRecord = RuntimeProfileApprovalRecordBase & (
  | {
    pending_user_ratification: true;
    ratified_by?: never;
    ratified_date?: never;
    ratification_evidence?: never;
  }
  | {
    pending_user_ratification: false;
    ratified_by: string;
    ratified_date: string;
    ratification_evidence: string;
    ratification_evidence_sha256: string;
    ratified_profile_payload_sha256: string;
    ratification_decision: string;
  }
);

export interface RuntimeKindIssue {
  kind: string;
  extensionId: string;
  reason: string;
}

export interface RuntimeSnapshotProfile {
  schema_version: 1;
  profile_id: string;
  status: RuntimeProfileStatus;
  description: string;
  agent: {
    id: string;
    expected_trust_tier: 'own' | 'imported';
    expected_source: string;
    expected_host_tool_allow: string[];
    expected_host_tool_deny: string[];
  };
  kernel: { provider_id: string };
  fixture: {
    game_slug: string;
    session_alias: string;
    thread_id: string;
    call_id: string;
    message: string;
  };
  ui_state: {
    lease: 'absent';
    runtime_manifest: 'absent';
  };
  plugin_policy: {
    safe_boot: true;
    layers: ['L0'];
  };
  product_shell: {
    host_tools: 'studioHostTools';
    system_prompt_composer: 'GameSystemPromptComposer';
  };
  formal_gate: {
    required_orchestrator_ancestor: string;
    waiver?: RuntimeFormalWaiver;
  };
  tool_accounting: Record<string, RuntimeToolAccounting>;
  approval_record?: RuntimeProfileApprovalRecord;
}

const runtimeNonEmptyString = z.string().trim().min(1);
const runtimeUniqueStringList = z.array(runtimeNonEmptyString).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain duplicates' });
  }
});
const runtimeNonEmptyUniqueStringList = z.array(runtimeNonEmptyString).min(1).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain duplicates' });
  }
});
const runtimeToolAccountingSchema = z.object({
  mapped_effects: runtimeNonEmptyUniqueStringList.optional(),
  explicit_out_of_scope_reason: runtimeNonEmptyString.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.mapped_effects === undefined) === (value.explicit_out_of_scope_reason === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtime profile tool accounting must choose exactly one disposition',
    });
  }
});
const runtimeDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO calendar date');
const runtimeFormalWaiverSchema = z.object({
  waived_blockers: z.tuple([z.literal('extension-kind-issues')]),
  waived_instances: runtimeNonEmptyUniqueStringList,
  max_count: z.number().int().positive(),
  reason: runtimeNonEmptyString,
  issuer: z.literal('supervisory-lane'),
  date: runtimeDate,
}).strict();
const runtimeApprovalRecordBaseSchema = z.object({
  approver: z.literal('supervisory-lane(orchestration)'),
  date: runtimeDate,
  profile_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256'),
  channel: z.literal('orchestration session 2026-07-23'),
}).strict();
const runtimeApprovalRecordSchema = z.discriminatedUnion('pending_user_ratification', [
  runtimeApprovalRecordBaseSchema.extend({
    pending_user_ratification: z.literal(true),
    ratified_by: z.never().optional(),
    ratified_date: z.never().optional(),
    ratification_evidence: z.never().optional(),
    ratification_evidence_sha256: z.never().optional(),
    ratified_profile_payload_sha256: z.never().optional(),
    ratification_decision: z.never().optional(),
  }).strict(),
  runtimeApprovalRecordBaseSchema.extend({
    pending_user_ratification: z.literal(false),
    ratified_by: runtimeNonEmptyString,
    ratified_date: runtimeDate,
    ratification_evidence: runtimeNonEmptyString,
    ratification_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    ratified_profile_payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    ratification_decision: runtimeNonEmptyString,
  }).strict(),
]);
const RuntimeSnapshotProfileSchema: z.ZodType<RuntimeSnapshotProfile> = z.object({
  schema_version: z.literal(1),
  profile_id: z.string().regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'runtime profile_id must be lowercase kebab-case',
  ),
  status: z.enum(['proposed', 'approved']),
  description: runtimeNonEmptyString,
  agent: z.object({
    id: runtimeNonEmptyString,
    expected_trust_tier: z.enum(['own', 'imported']),
    expected_source: runtimeNonEmptyString,
    expected_host_tool_allow: runtimeUniqueStringList,
    expected_host_tool_deny: runtimeUniqueStringList,
  }).strict(),
  kernel: z.object({
    provider_id: runtimeNonEmptyString,
  }).strict(),
  fixture: z.object({
    game_slug: runtimeNonEmptyString,
    session_alias: runtimeNonEmptyString,
    thread_id: runtimeNonEmptyString,
    call_id: runtimeNonEmptyString,
    message: runtimeNonEmptyString,
  }).strict(),
  ui_state: z.object({
    lease: z.literal('absent'),
    runtime_manifest: z.literal('absent'),
  }).strict(),
  plugin_policy: z.object({
    safe_boot: z.literal(true),
    layers: z.tuple([z.literal('L0')]),
  }).strict(),
  product_shell: z.object({
    host_tools: z.literal('studioHostTools'),
    system_prompt_composer: z.literal('GameSystemPromptComposer'),
  }).strict(),
  formal_gate: z.object({
    required_orchestrator_ancestor: z.string().regex(
      /^[0-9a-f]{40}$/,
      'runtime profile formal gate requires a full orchestrator commit SHA',
    ),
    waiver: runtimeFormalWaiverSchema.optional(),
  }).strict(),
  tool_accounting: z.record(runtimeNonEmptyString, runtimeToolAccountingSchema),
  approval_record: runtimeApprovalRecordSchema.optional(),
}).strict().superRefine((profile, ctx) => {
  if (profile.status === 'approved' && profile.approval_record === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approval_record'],
      message: 'approved runtime profile requires an approval record',
    });
  }
  if (profile.status !== 'approved' && profile.approval_record !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approval_record'],
      message: 'only an approved runtime profile may carry an approval record',
    });
  }
  if (profile.formal_gate.waiver && profile.status !== 'approved') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['formal_gate', 'waiver'],
      message: 'formal waiver requires an approved runtime profile',
    });
  }
  if (
    profile.approval_record
    && profile.approval_record.profile_sha256 !== runtimeProfileApprovalSha256(profile)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approval_record', 'profile_sha256'],
      message: 'does not match the canonical profile payload excluding approval_record',
    });
  }
});

export type RuntimeToolSource =
  | 'builtin'
  | 'product-shell'
  | 'catalog-firstclass'
  | 'plugin'
  | 'soul-pack'
  | 'skill';

export interface RuntimeFinalTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  delivery?: unknown;
}

export interface RuntimeRawPluginTool {
  id: string;
  wireName: string;
  extensionId: string;
  exposedToAI: boolean;
  hasHandler: boolean;
}

export interface RuntimeToolSources {
  builtin: ReadonlySet<string>;
  productShell: ReadonlySet<string>;
  catalogFirstClass: ReadonlyMap<string, string>;
  plugin: ReadonlySet<string>;
  soulPack: ReadonlySet<string>;
  skill: ReadonlySet<string>;
}

export interface RuntimeToolAccountingRow {
  name: string;
  tool_source: RuntimeToolSource;
  source_id?: string;
  description_sha256: string;
  input_schema_sha256: string;
  delivery?: unknown;
  mapped_effects?: string[];
  explicit_out_of_scope_reason?: string;
  unresolved?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

export function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableStringify(value)), null, 2)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalSha256(value: unknown): string {
  return sha256(stableStringify(value));
}

export function runtimeProfileApprovalSha256(profile: RuntimeSnapshotProfile): string {
  const { approval_record: _approvalRecord, ...approvalPayload } = profile;
  return canonicalSha256(approvalPayload);
}

export function validateRuntimeProfileState(repoRoot: string, profile: RuntimeSnapshotProfile): void {
  const record = profile.approval_record;
  if (!record || record.pending_user_ratification) return;
  const completed = record as Extract<RuntimeProfileApprovalRecord, { pending_user_ratification: false }>;
  const payloadSha = runtimeProfileApprovalSha256(profile);
  if (completed.profile_sha256 !== payloadSha || completed.ratified_profile_payload_sha256 !== payloadSha) {
    throw new Error('completed runtime profile ratification is not bound to the current profile payload SHA-256');
  }
  const evidence = resolveEvidenceFile(repoRoot, completed.ratification_evidence);
  if (evidence.sha256 !== completed.ratification_evidence_sha256) {
    throw new Error(
      `runtime profile ratification evidence SHA-256 mismatch: expected=${completed.ratification_evidence_sha256} actual=${evidence.sha256}`,
    );
  }
}

export function validateRuntimeProfileTransition(
  repoRoot: string,
  previous: RuntimeSnapshotProfile,
  next: RuntimeSnapshotProfile,
): void {
  const previousPending = previous.approval_record?.pending_user_ratification;
  const nextPending = next.approval_record?.pending_user_ratification;
  if (previousPending === false) {
    if (nextPending !== false) {
      throw new Error('completed runtime profile ratification cannot be removed or transition back to pending');
    }
    if (canonicalSha256(previous) !== canonicalSha256(next)) {
      throw new Error('completed runtime profile ratification is immutable');
    }
  }
  validateRuntimeProfileState(repoRoot, next);
}

export function normalizeDynamicValues(
  value: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === 'string') {
    return replacements.reduce(
      (current, [actual, replacement]) => actual ? current.split(actual).join(replacement) : current,
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => normalizeDynamicValues(item, replacements));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeDynamicValues(item, replacements)]),
  );
}

export function hostToolWireName(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function firstClassToolName(actionId: string): string {
  return `ui_act_${actionId.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

export function skillToolName(skillId: string): string {
  return `skill_${skillId.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

export function parseRuntimeSnapshotProfile(value: unknown): RuntimeSnapshotProfile {
  return RuntimeSnapshotProfileSchema.parse(value);
}

export function assertNoPluginWireCollisions(rawTools: readonly RuntimeRawPluginTool[]): void {
  const byWire = new Map<string, RuntimeRawPluginTool[]>();
  for (const tool of rawTools.filter((item) => item.exposedToAI && item.hasHandler)) {
    const rows = byWire.get(tool.wireName) ?? [];
    rows.push(tool);
    byWire.set(tool.wireName, rows);
  }
  const collisions = [...byWire.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([wireName, rows]) => ({
      wireName,
      tools: rows.map((row) => ({ id: row.id, extensionId: row.extensionId })),
    }));
  if (collisions.length > 0) {
    throw new Error(`runtime snapshot plugin wire collision: ${stableStringify(collisions)}`);
  }
}

function sourceFor(name: string, sources: RuntimeToolSources): { source: RuntimeToolSource; sourceId?: string } {
  const matches: Array<{ source: RuntimeToolSource; sourceId?: string }> = [];
  if (sources.builtin.has(name)) matches.push({ source: 'builtin' });
  if (sources.productShell.has(name)) matches.push({ source: 'product-shell' });
  const actionId = sources.catalogFirstClass.get(name);
  if (actionId) matches.push({ source: 'catalog-firstclass', sourceId: actionId });
  if (sources.plugin.has(name)) matches.push({ source: 'plugin' });
  if (sources.soulPack.has(name)) matches.push({ source: 'soul-pack' });
  if (sources.skill.has(name)) matches.push({ source: 'skill' });
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `runtime snapshot could not classify final tool source: ${name}`
        : `runtime snapshot found ambiguous final tool source: ${name} (${matches.map((item) => item.source).join(', ')})`,
    );
  }
  return matches[0]!;
}

export function accountFinalTools(input: {
  finalTools: readonly RuntimeFinalTool[];
  rawPluginTools: readonly RuntimeRawPluginTool[];
  sources: RuntimeToolSources;
  accounting: Readonly<Record<string, RuntimeToolAccounting>>;
  allowUnresolved?: boolean;
}): { rows: RuntimeToolAccountingRow[]; unresolved: string[] } {
  assertNoPluginWireCollisions(input.rawPluginTools);
  const seen = new Set<string>();
  const rows: RuntimeToolAccountingRow[] = [];
  const unresolved: string[] = [];
  for (const tool of [...input.finalTools].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!tool.name || seen.has(tool.name)) throw new Error(`duplicate or empty final tool name: ${tool.name}`);
    seen.add(tool.name);
    const source = sourceFor(tool.name, input.sources);
    const declared = input.accounting[tool.name];
    const mapped = declared?.mapped_effects?.filter((effect) => typeof effect === 'string' && effect.length > 0) ?? [];
    const reason = declared?.explicit_out_of_scope_reason?.trim();
    if (mapped.length > 0 && reason) {
      throw new Error(`tool accounting must choose mapped_effects or explicit_out_of_scope_reason: ${tool.name}`);
    }
    const unresolvedRow = mapped.length === 0 && !reason;
    if (unresolvedRow) unresolved.push(tool.name);
    rows.push({
      name: tool.name,
      tool_source: source.source,
      ...(source.sourceId ? { source_id: source.sourceId } : {}),
      description_sha256: canonicalSha256(tool.description ?? ''),
      input_schema_sha256: canonicalSha256(tool.inputSchema ?? null),
      ...(tool.delivery !== undefined ? { delivery: tool.delivery } : {}),
      ...(mapped.length > 0 ? { mapped_effects: [...new Set(mapped)].sort() } : {}),
      ...(reason ? { explicit_out_of_scope_reason: reason } : {}),
      ...(unresolvedRow ? { unresolved: true as const } : {}),
    });
  }
  const staleMappings = Object.keys(input.accounting).filter((name) => !seen.has(name)).sort();
  if (staleMappings.length > 0) {
    throw new Error(`runtime snapshot profile has stale tool accounting: ${staleMappings.join(', ')}`);
  }
  if (unresolved.length > 0 && input.allowUnresolved !== true) {
    throw new Error(`runtime snapshot incomplete tool accounting: ${unresolved.join(', ')}`);
  }
  return { rows, unresolved };
}

export function formalEligibility(input: {
  profileStatus: RuntimeProfileStatus;
  dirty: boolean;
  unresolvedTools: readonly string[];
  scanErrorCount: number;
  mergeIssueCount: number;
  kindIssueCount: number;
  kindIssues?: readonly RuntimeKindIssue[];
  waiver?: RuntimeFormalWaiver;
}): { eligible: boolean; blockers: string[]; waived_blockers?: string[] } {
  const blockers: string[] = [];
  if (input.profileStatus !== 'approved') blockers.push('profile-not-approved');
  if (input.dirty) blockers.push('worktree-dirty');
  if (input.unresolvedTools.length > 0) blockers.push('tool-accounting-incomplete');
  if (input.scanErrorCount > 0) blockers.push('extension-scan-errors');
  if (input.mergeIssueCount > 0) blockers.push('extension-merge-issues');
  if (input.kindIssueCount > 0) blockers.push('extension-kind-issues');
  const kindInstances = input.kindIssues?.map(runtimeWaiverInstanceFingerprint);
  const waiverInstanceCounts = new Map<string, number>();
  for (const instance of input.waiver?.waived_instances ?? []) {
    waiverInstanceCounts.set(instance, (waiverInstanceCounts.get(instance) ?? 0) + 1);
  }
  const actualInstanceCounts = new Map<string, number>();
  for (const instance of kindInstances ?? []) {
    actualInstanceCounts.set(instance, (actualInstanceCounts.get(instance) ?? 0) + 1);
  }
  const kindWaiverEligible = blockers.includes('extension-kind-issues')
    && input.waiver?.waived_blockers.includes('extension-kind-issues') === true
    && kindInstances !== undefined
    && kindInstances.length === input.kindIssueCount
    && kindInstances.length <= input.waiver.max_count
    && [...actualInstanceCounts].every(
      ([instance, count]) => count <= (waiverInstanceCounts.get(instance) ?? 0),
    );
  const waived = kindWaiverEligible ? ['extension-kind-issues'] : [];
  const active = blockers.filter((blocker) => !waived.includes(blocker));
  return {
    eligible: active.length === 0,
    blockers: active,
    ...(waived.length > 0 ? { waived_blockers: waived } : {}),
  };
}

const WAIVED_DUPLICATE_TOOL_EXTENSION = '@forgeax-extension/wb-2d-scene-asset-generator';

export function runtimeWaiverInstanceFingerprint(issue: RuntimeKindIssue): string {
  const match = /^duplicate tool id "([^"]+)" in plugin (\S+)$/.exec(issue.reason);
  if (
    issue.kind === 'tool'
    && issue.extensionId === WAIVED_DUPLICATE_TOOL_EXTENSION
    && match?.[2] === issue.extensionId
  ) {
    return match[1]!;
  }
  return `unrecognized:${canonicalSha256(issue)}`;
}
