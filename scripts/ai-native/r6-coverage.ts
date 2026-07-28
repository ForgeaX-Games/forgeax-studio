import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  parseEvidenceManifest,
  type EvidenceManifestV1,
} from './evidence-manifest.schema';
import {
  LEDGER_V1_DISPOSITIONS,
  parseLedgerV1Row,
  type LedgerV1Row,
} from './ledger-v1.schema';
import {
  EffectAdjudicationV1Schema,
  type EffectAdjudicationV1,
} from './effect-adjudication.schema';
import {
  canonicalSha256,
  parseRuntimeSnapshotProfile,
  sha256,
  stablePrettyJson,
  stableStringify,
  validateRuntimeProfileState,
  type RuntimeSnapshotProfile,
} from './runtime-snapshot-core';
import {
  loadBaselineApproval,
  parseBaselineApprovalRecord,
  type BaselineApprovalRecord,
} from './baseline-approval.ts';
import {
  assertPinnedEvidenceManifestSet,
  resolveRuntimePinSource,
} from './runtime-artifact-integrity.ts';
import { loadValidatedRuntimeProfile } from './runtime-profile-terminal-registry.ts';
import {
  historicalRuntimeArtifactDiagnostic,
  isRawRuntimeArtifactInput,
  rejectedRuntimeArtifactDiagnostic,
  type RuntimeArtifactDiagnostic,
} from './runtime-snapshot-history.ts';
import type { GovernanceVerification } from './governance-git.ts';
import { mergeGovernanceVerifications } from './governance-git.ts';
import { loadCurrentBaselineState } from './baseline-state.ts';

const nonEmptyString = z.string().trim().min(1);
function uniqueStrings(minimum: number = 0) {
  return z.array(nonEmptyString).min(minimum).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not contain duplicates' });
    }
  });
}

const controlRowSchema = z.object({
  control_id: z.string().regex(/^ctl_[0-9a-f]{24}$/),
  repo: z.enum(['chat', 'interface', 'studio']),
  surface: z.enum([
    'button', 'palette', 'shortcut', 'menu', 'rpc-handler', 'postmessage-handler',
    'subscription-handler', 'dom', 'link',
  ]),
  event: nonEmptyString,
  component: nonEmptyString,
  file: nonEmptyString,
  evidence_line: z.number().int().positive(),
  effect_id: nonEmptyString.nullable(),
  propagation: z.enum(['direct', 'forwarded', 'manual-pool']),
  owner: z.enum(['us', 'editor', 'marketplace', 'other-team']),
  notes: nonEmptyString,
}).strict();

const edgeRowSchema = z.object({
  control_id: z.string().regex(/^ctl_[0-9a-f]{24}$/),
  effect_id: nonEmptyString,
  propagation: z.enum(['direct', 'forwarded']),
  via: uniqueStrings(1),
  evidence_line: z.number().int().positive(),
}).strict();

const baselineEffectSchema = z.object({
  effect_id: nonEmptyString,
  repo: uniqueStrings(1),
  vocab: z.object({
    setters: uniqueStrings(),
    commands: uniqueStrings(),
    actions: uniqueStrings(),
  }).strict(),
  agent_equiv: z.object({
    action: z.object({
      id: nonEmptyString,
      capability: nonEmptyString,
      surface: z.enum(['ui', 'server', 'both']),
      firstClass: z.boolean(),
    }).strict().optional(),
    tool: z.object({
      ids: uniqueStrings(),
      runtime_fill: z.boolean(),
      source: nonEmptyString,
    }).strict().optional(),
    headless: z.enum(['yes', 'no', 'n-a']),
  }).strict(),
  server_endpoints: uniqueStrings(),
  domain: nonEmptyString,
}).strict();

const manualPoolAdjudicationSchema = z.object({
  schema_version: z.literal(1),
  baseline_id: nonEmptyString,
  manual_id: z.number().int().positive(),
  pool_manual_id: nonEmptyString,
  kind: z.enum(['control', 'vocab', 'route', 'provider-di', 'listener-event', 'menu-command']),
  control_id: z.string().regex(/^ctl_[0-9a-f]{24}$/).nullable(),
  effect_id: nonEmptyString,
  disposition: z.enum(LEDGER_V1_DISPOSITIONS),
  certainty: z.literal('adjudicated'),
  evidence: nonEmptyString,
  carry_forward: z.enum(['control-id+kind+candidate', 'incremental-adjudication']),
}).strict();

const baselineApprovalObservationSchema = z.object({
  baseline_id: nonEmptyString,
  baseline_bytes_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['approved', 'pending', 'unverified-diagnostic']),
  decision_evidence: nonEmptyString.nullable(),
  decision_evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  approved_content_commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  approval_manifest_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  approval_scope_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  approval_package_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status !== 'pending' && value.decision_evidence === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decision_evidence'], message: 'approved or diagnostic baseline requires evidence' });
  }
  if (value.status === 'pending' && value.decision_evidence !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decision_evidence'], message: 'pending baseline must not prefill evidence' });
  }
  const receiptValues = [
    value.approved_content_commit,
    value.approval_manifest_raw_sha256,
    value.approval_scope_sha256,
    value.approval_package_raw_sha256,
  ];
  if (value.status === 'pending' && receiptValues.some((item) => item !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approved_content_commit'], message: 'pending baseline must not prefill receipt fields' });
  }
  if (value.status !== 'pending' && receiptValues.some((item) => item === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approved_content_commit'], message: 'approved or diagnostic baseline requires all receipt fields' });
  }
});

const runtimeEnvironmentSchema = z.object({
  bun_version: nonEmptyString,
}).strict();

const runtimeSnapshotReportSchema = z.object({
  schema_version: z.literal(2),
  mode: z.enum(['development', 'formal']),
  status: z.enum(['PROPOSED', 'DEVELOPMENT_VERIFIED', 'FORMAL_CAPTURED']),
  formal_record: z.boolean(),
  coverage_tier: z.enum(['formal', 'formal-with-waiver', 'provisional']),
  profile_id: nonEmptyString,
  profile_status: z.enum(['proposed', 'approved']),
  profile_path: nonEmptyString,
  snapshot_path: nonEmptyString,
  profile_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reproduction_key_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  snapshot_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  snapshot_bytes: z.number().int().positive(),
  byte_identical: z.boolean(),
  clean_processes: z.literal(2),
  pin_gate: z.object({
    requiredAncestor: z.string().regex(/^[0-9a-f]{40}$/),
    orchestratorGitlink: z.string().regex(/^[0-9a-f]{40}$/),
    arrived: z.boolean(),
    verification: z.enum(['git-ancestry', 'immutable-pin-git-ancestry-proof']),
    pinSchemaVersion: z.literal(3),
    ancestryProof: z.object({
      requiredAncestor: z.string().regex(/^[0-9a-f]{40}$/),
      verifiedGitlink: z.string().regex(/^[0-9a-f]{40}$/),
      verification: z.literal('git-merge-base-is-ancestor'),
    }).strict(),
    expectedBunVersion: nonEmptyString,
    bunVersionMatches: z.boolean(),
    scannerInputFingerprintMatches: z.boolean(),
    scannerConfigurationFingerprintMatches: z.boolean(),
    reasonCodes: uniqueStrings(),
  }).strict(),
  child_processes: z.array(z.object({
    index: z.number().int().min(1).max(2),
    exit_code: z.literal(0),
    stdout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    stderr_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).length(2),
  formal_eligibility: z.object({
    eligible: z.boolean(),
    blockers: uniqueStrings(),
    waived_blockers: uniqueStrings().optional(),
  }).strict(),
  runtime_environment: runtimeEnvironmentSchema,
  baseline_approval: baselineApprovalObservationSchema,
}).strict().superRefine((report, ctx) => {
  if (report.baseline_approval.decision_evidence_sha256 === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseline_approval', 'decision_evidence_sha256'], message: 'current report requires approval evidence SHA observation' });
  }
  const formal = report.mode === 'formal';
  if (report.formal_record !== formal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['formal_record'], message: 'must match mode' });
  }
  if (report.status === 'FORMAL_CAPTURED' && (!formal || !report.formal_eligibility.eligible)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'formal capture must be eligible and formal' });
  }
  if (report.status === 'DEVELOPMENT_VERIFIED' && formal) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'development status requires development mode' });
  }
  if (!formal && report.coverage_tier !== 'provisional') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_tier'], message: 'development capture must be provisional' });
  }
  if (
    formal
    && report.baseline_approval.status === 'approved'
    && report.coverage_tier === 'provisional'
    && report.pin_gate.reasonCodes.length === 0
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_tier'], message: 'approved formal capture cannot be provisional' });
  }
  if (formal && report.baseline_approval.status !== 'approved' && report.coverage_tier !== 'provisional') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_tier'], message: 'unapproved formal capture must remain provisional' });
  }
  if (
    report.coverage_tier === 'formal-with-waiver'
    && !report.formal_eligibility.waived_blockers?.includes('extension-kind-issues')
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['coverage_tier'], message: 'formal-with-waiver requires a named waived blocker' });
  }
});

const runtimeToolAccountingRowSchema = z.object({
  name: nonEmptyString,
  tool_source: z.enum(['builtin', 'product-shell', 'catalog-firstclass', 'plugin', 'soul-pack', 'skill']),
  source_id: nonEmptyString.optional(),
  description_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  input_schema_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  delivery: z.unknown().optional(),
  mapped_effects: uniqueStrings(1).optional(),
  explicit_out_of_scope_reason: nonEmptyString.optional(),
  unresolved: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.mapped_effects === undefined) === (value.explicit_out_of_scope_reason === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'final tool must have exactly one accounting disposition' });
  }
});

const runtimePluginManifestSchema = z.object({
  id: nonEmptyString,
  version: nonEmptyString.nullable(),
  layer: z.literal('L0'),
  origin: nonEmptyString,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const runtimeSnapshotEntitySchema = z.object({
  schema_version: z.literal(2),
  profile_id: nonEmptyString,
  profile_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  capture_mode: z.enum(['development', 'formal']),
  reproduction_key_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reproduction_key: z.object({
    profile_id: nonEmptyString,
    profile_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    combination_pin: z.object({
      root: z.string().regex(/^[0-9a-f]{40}$/),
      submodules: z.record(z.string().regex(/^[0-9a-f]{40}$/)),
      dirty: z.boolean(),
    }).strict(),
    agent: z.object({
      id: nonEmptyString,
      trust_tier: z.enum(['own', 'imported']),
      source: nonEmptyString,
      agent_json_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      host_tools: z.object({ allow: uniqueStrings(), deny: uniqueStrings() }).strict(),
      record_tools: uniqueStrings(),
      record_skills: z.array(z.object({
        skillId: nonEmptyString,
        extensionId: nonEmptyString,
        kind: nonEmptyString,
        description_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }).strict()),
      persona_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    plugin_combination: z.object({
      policy: z.object({ safe_boot: z.literal(true), layers: z.tuple([z.literal('L0')]) }).strict(),
      manifests: z.array(runtimePluginManifestSchema),
      manifest_set_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    product_shell: z.object({
      host_tools: uniqueStrings(),
      system_prompt_composer: z.literal('GameSystemPromptComposer'),
      host_tools_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    action_catalog: z.object({
      count: z.number().int().nonnegative(),
      content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    fixture: z.object({
      game_slug: nonEmptyString,
      session_alias: nonEmptyString,
      thread_id: nonEmptyString,
      call_id: nonEmptyString,
      ui_state: z.object({ lease: z.literal('absent'), runtime_manifest: z.literal('absent') }).strict(),
    }).strict(),
    capture_mode: z.enum(['development', 'formal']),
  }).strict(),
  runtime_environment: runtimeEnvironmentSchema,
  kernel_selection: z.object({
    requested_provider_id: nonEmptyString,
    resolved_provider_id: nonEmptyString,
  }).strict(),
  execution_boundary: z.object({
    stopped_before: z.literal('AgentKernel.runTurn'),
    run_turn_invoked: z.literal(false),
    model_calls: z.literal(0),
  }).strict(),
  route_assembly: z.object({
    chain: z.tuple([
      z.literal('hostToolSpecsForAgent'),
      z.literal('extraTools'),
      z.literal('composeTurnRequest'),
    ]),
    normalized_turn_request_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    normalized_system_prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  raw_tool_catalog: z.array(z.object({
    id: nonEmptyString,
    wireName: nonEmptyString,
    extensionId: nonEmptyString,
    exposedToAI: z.boolean(),
    hasHandler: z.boolean(),
  }).strict()),
  final_tools: z.array(runtimeToolAccountingRowSchema).min(1),
  raw_final_difference: z.object({
    raw_count: z.number().int().nonnegative(),
    final_count: z.number().int().positive(),
    allowed_plugin_wire_names: uniqueStrings(),
    raw_only: uniqueStrings(),
  }).strict(),
  tool_accounting: z.object({
    complete: z.literal(true),
    unresolved: z.array(z.never()).length(0),
  }).strict(),
  extension_diagnostics: z.object({
    scan_errors: z.array(z.unknown()),
    merge_issues: z.array(z.unknown()),
    kind_issues: z.array(z.unknown()),
    formal_blocking_kind_issues: z.array(z.unknown()),
  }).strict(),
  formal_eligibility: z.object({
    eligible: z.boolean(),
    blockers: uniqueStrings(),
    waived_blockers: uniqueStrings().optional(),
  }).strict(),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.reproduction_key.capture_mode !== snapshot.capture_mode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['capture_mode'], message: 'current snapshot capture mode must be sealed into the reproduction key' });
  }
});

const testBindingRegistrySchema = z.object({
  schema_version: z.literal(1),
  bindings: z.array(z.object({
    effect_id: nonEmptyString,
    test_id: nonEmptyString,
    binding_evidence: z.object({
      test_call: nonEmptyString,
      handler: nonEmptyString,
    }).strict(),
  }).strict()).min(1),
}).strict();

type BaselineEffect = z.infer<typeof baselineEffectSchema>;
type RuntimeSnapshotReport = z.infer<typeof runtimeSnapshotReportSchema>;
type TestBindingRegistry = z.infer<typeof testBindingRegistrySchema>;

export type R6EffectRow = EffectAdjudicationV1;

export interface R6CalculatorData {
  baselineId: string;
  ledgerRows: unknown[];
  manualPoolAdjudications: unknown[];
  effectRows: unknown[];
  controls: unknown[];
  edges: unknown[];
  baselineEffects: unknown[];
  snapshotReports: unknown[];
  runtimeArtifactDiagnostics?: RuntimeArtifactDiagnostic[];
  inventoryProvenance?: string;
  inputSources?: Partial<Record<'ledgerRows' | 'manualPoolAdjudications' | 'effectRows' | 'controls' | 'edges' | 'baselineEffects' | 'snapshotReports' | 'manifests' | 'profile' | 'baselineApproval' | 'testBindingRegistry', string>>;
  manifests: unknown[];
  profile: unknown;
  profileSha256: string;
  repoRoot?: string;
  baselineApproval: unknown;
  governanceVerification?: GovernanceVerification;
  testBindingRegistry: unknown;
  inventoryProductCombo?: Record<string, string>;
  catalogEntries: ReadonlyArray<{ id: string; surface?: 'ui' | 'server' | 'both' }>;
  handlerIds: string[];
  rawWireNames?: string[];
  sourceText: (path: string) => string | undefined;
  runTest: (testId: string) => Promise<{ ok: boolean; output: string }>;
}

export interface R6DomainCoverage {
  domain: string;
  migrated: number;
  denominator: number;
  tool: number;
  read: number;
  coverage_percent: number;
}

export interface R6CoverageResult {
  baseline_id: string;
  baseline_approval: 'approved' | 'pending' | 'unverified-diagnostic';
  baseline_bytes_sha256: string;
  baseline_governance_verification?: GovernanceVerification;
  governance_reason_codes: string[];
  result_status: 'final' | 'draft';
  coverage_tier: 'formal' | 'formal-with-waiver' | 'provisional';
  exclusion_disclosure: {
    included_dispositions: readonly ['tool', 'read'];
    excluded_effects_by_disposition: Record<string, number>;
  };
  control_entry_rescan: { provenance: string; controls: number; edges: number };
  numerator: number;
  denominator: number;
  coverage_percent: number;
  domains: R6DomainCoverage[];
  equivalence: { verified: number; declared: number; none: number };
  equivalence_all_effects: { verified: number; declared: number; none: number };
  migrated_effect_ids: string[];
  migrated_control_ids: string[];
  evaluations: Array<{
    effect_id: string;
    domain: string;
    agent_equiv: 'verified' | 'declared' | 'none';
    status: 'migrated' | 'unmigrated';
    manifest_id: string | null;
    reasons: string[];
    warnings: string[];
  }>;
  test_runs: Array<{ test_id: string; ok: boolean; output: string }>;
  runtime_snapshot_diagnostics: RuntimeArtifactDiagnostic[];
}

export interface RepositoryRuntimeRegistry {
  catalogEntries: ReadonlyArray<{ id: string; surface?: 'ui' | 'server' | 'both' }>;
  handlerIds: string[];
  rawWireNames?: string[];
  currentInventory?: {
    baselineId: string;
    controls: unknown[];
    edges: unknown[];
    effects: unknown[];
    productCombo?: Record<string, string>;
  };
  snapshotReports?: unknown[];
  runTest: R6CalculatorData['runTest'];
}

function jsonLines(path: string): unknown[] {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function parseJsonFile<T>(path: string, parser: (value: unknown) => T): T {
  const text = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
    const line = position === undefined ? 1 : text.slice(0, Number(position)).split('\n').length;
    throw new Error(`${path}:${line}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parser(value);
  } catch (error) {
    const firstPath = error instanceof z.ZodError ? error.issues[0]?.path[0] : undefined;
    const key = typeof firstPath === 'string' ? `"${firstPath}"` : '';
    const offset = key ? text.indexOf(key) : -1;
    const line = offset < 0 ? 1 : text.slice(0, offset).split('\n').length;
    throw new Error(`${path}:${line}: ${formattedIssue(error)}`);
  }
}

function formattedIssue(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '<row>';
    return `${field}: ${issue.message}`;
  }).join('; ');
}

function parseInputRows<T>(
  values: unknown[],
  source: string,
  parser: (value: unknown) => T,
): T[] {
  return values.map((value, index) => {
    try {
      return parser(value);
    } catch (error) {
      throw new Error(`${source}:${index + 1}: ${formattedIssue(error)}`);
    }
  });
}

function partitionRuntimeSnapshotReports(
  values: unknown[],
  source: string,
): { reports: RuntimeSnapshotReport[]; diagnostics: RuntimeArtifactDiagnostic[] } {
  const reports: RuntimeSnapshotReport[] = [];
  const diagnostics: RuntimeArtifactDiagnostic[] = [];
  values.forEach((input, index) => {
    const path = isRawRuntimeArtifactInput(input) ? input.path : `${source}:${index + 1}`;
    const rawText = isRawRuntimeArtifactInput(input) ? input.rawText : stablePrettyJson(input);
    let value: unknown = input;
    if (isRawRuntimeArtifactInput(input)) {
      try {
        value = JSON.parse(rawText) as unknown;
      } catch (error) {
        throw new Error(`${path}: invalid JSON: ${formattedIssue(error)}`);
      }
    }
    const schemaVersion = value !== null && typeof value === 'object'
      ? (value as { schema_version?: unknown }).schema_version
      : undefined;
    if (schemaVersion !== 2) {
      const historical = isRawRuntimeArtifactInput(input)
        ? historicalRuntimeArtifactDiagnostic('report', path, rawText)
        : undefined;
      diagnostics.push(historical ?? rejectedRuntimeArtifactDiagnostic('report', path, rawText));
      return;
    }
    try {
      reports.push(runtimeSnapshotReportSchema.parse(value));
    } catch (error) {
      throw new Error(`${path}: current schema rejected report: ${formattedIssue(error)}`);
    }
  });
  return { reports, diagnostics };
}

function requireNonEmpty(label: string, rows: unknown): asserts rows is unknown[] {
  if (!Array.isArray(rows)) throw new Error(`${label}: required inventory array is missing`);
  if (rows.length === 0) throw new Error(`${label}: inventory must not be empty`);
}

function requireUnique<T>(label: string, rows: T[], key: (row: T) => string): void {
  const seen = new Map<string, number>();
  rows.forEach((row, index) => {
    const value = key(row);
    const first = seen.get(value);
    if (first !== undefined) throw new Error(`${label}:${index + 1}: duplicate key ${JSON.stringify(value)}; first seen at line ${first + 1}`);
    seen.set(value, index);
  });
}

function requireExactKeys(label: string, left: Iterable<string>, right: Iterable<string>): void {
  const leftKeys = sorted(new Set(left));
  const rightKeys = sorted(new Set(right));
  if (!sameStrings(leftKeys, rightKeys)) {
    const leftSet = new Set(leftKeys);
    const rightSet = new Set(rightKeys);
    const onlyLeft = leftKeys.filter((key) => !rightSet.has(key));
    const onlyRight = rightKeys.filter((key) => !leftSet.has(key));
    throw new Error(`${label}: key-set mismatch; left-only=${JSON.stringify(onlyLeft)}; right-only=${JSON.stringify(onlyRight)}`);
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function sameStrings(left: Iterable<string>, right: Iterable<string>): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTestId(testId: string): { file: string; title: string } | null {
  const split = testId.indexOf('#');
  if (split <= 0 || split === testId.length - 1 || testId.indexOf('#', split + 1) >= 0) return null;
  const file = testId.slice(0, split);
  const title = testId.slice(split + 1);
  if (!/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file) || !title.trim()) return null;
  return { file, title };
}

function sourceDeclaresExactTest(source: string, title: string): boolean {
  const escapedSingle = title.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const escapedDouble = title.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return source.includes(`'${escapedSingle}'`) || source.includes(`"${escapedDouble}"`);
}

function sourceDeclaresAction(source: string, effectId: string): boolean {
  const id = regexEscape(effectId);
  return new RegExp(`registerAction\\s*\\(\\s*\\{[\\s\\S]{0,12000}?\\bid\\s*:\\s*['"]${id}['"]`).test(source);
}

function pointerIssue(pointer: string, sourceText: R6CalculatorData['sourceText']): string | null {
  const match = pointer.match(/^(.+):(\d+) — \S.+$/);
  if (!match) return `invalid-evidence-pointer:${pointer}`;
  const source = sourceText(match[1]);
  if (source === undefined) return `missing-evidence-file:${match[1]}`;
  if (Number(match[2]) > source.split('\n').length) return `evidence-line-out-of-range:${match[1]}:${match[2]}`;
  return null;
}

function countEquivalence(rows: R6EffectRow[]): { verified: number; declared: number; none: number } {
  return {
    verified: rows.filter((row) => row.agent_equiv === 'verified').length,
    declared: rows.filter((row) => row.agent_equiv === 'declared').length,
    none: rows.filter((row) => row.agent_equiv === 'none').length,
  };
}

function addOnce(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function validateManifestSet(manifests: EvidenceManifestV1[]): void {
  const ids = new Set<string>();
  const effects = new Set<string>();
  for (const manifest of manifests) {
    if (ids.has(manifest.manifest_id)) throw new Error(`duplicate evidence manifest id: ${manifest.manifest_id}`);
    if (effects.has(manifest.mapping.effect_id)) {
      throw new Error(`duplicate evidence manifest effect: ${manifest.mapping.effect_id}`);
    }
    ids.add(manifest.manifest_id);
    effects.add(manifest.mapping.effect_id);
  }
}

function validateSnapshotEntity(
  report: RuntimeSnapshotReport,
  data: R6CalculatorData,
  profile: RuntimeSnapshotProfile,
): string[] {
  const integrityReasons: string[] = [];
  const text = data.sourceText(report.snapshot_path);
  if (text === undefined) throw new Error(`runtime snapshot missing: ${report.snapshot_path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`runtime snapshot invalid JSON: ${report.snapshot_path}: ${formattedIssue(error)}`);
  }
  let snapshot: z.infer<typeof runtimeSnapshotEntitySchema>;
  try {
    snapshot = runtimeSnapshotEntitySchema.parse(raw);
  } catch (error) {
    throw new Error(`runtime snapshot invalid: ${report.snapshot_path}: ${formattedIssue(error)}`);
  }
  const canonical = stablePrettyJson(raw);
  if (text !== canonical) {
    throw new Error(`runtime snapshot canonical bytes mismatch: ${report.snapshot_path}`);
  }
  const canonicalBytes = new TextEncoder().encode(canonical).byteLength;
  const canonicalSnapshotSha = sha256(canonical);
  if (report.snapshot_bytes !== canonicalBytes) {
    throw new Error(`runtime snapshot byte count mismatch: ${report.snapshot_path}`);
  }
  if (report.snapshot_sha256 !== canonicalSnapshotSha) {
    throw new Error(`runtime snapshot SHA mismatch: ${report.snapshot_path}`);
  }
  if (report.mode !== snapshot.capture_mode) {
    addOnce(integrityReasons, 'formal-mode-content-binding-mismatch');
  }
  if (
    report.runtime_environment.bun_version !== snapshot.runtime_environment.bun_version
    || (report.mode === 'formal' && snapshot.runtime_environment.bun_version !== Bun.version)
    || (report.mode === 'formal' && report.pin_gate.expectedBunVersion !== snapshot.runtime_environment.bun_version)
    || report.pin_gate.bunVersionMatches === false
  ) {
    addOnce(integrityReasons, 'formal-bun-version-mismatch');
  }
  for (const reason of report.pin_gate.reasonCodes) addOnce(integrityReasons, reason);
  if (
    snapshot.raw_final_difference.raw_count !== snapshot.raw_tool_catalog.length
    || snapshot.raw_final_difference.final_count !== snapshot.final_tools.length
  ) {
    throw new Error(`runtime snapshot tool counts disagree with their inventories: ${report.snapshot_path}`);
  }
  const pluginManifests = snapshot.reproduction_key.plugin_combination.manifests;
  if (
    snapshot.reproduction_key.plugin_combination.manifest_set_sha256
    !== canonicalSha256(pluginManifests)
  ) {
    throw new Error(`runtime snapshot plugin manifest set SHA mismatch: ${report.snapshot_path}`);
  }
  for (const manifest of pluginManifests) {
    const live = data.sourceText(manifest.origin);
    if (live === undefined) {
      throw new Error(`runtime snapshot plugin manifest missing: ${manifest.origin}`);
    }
    if (sha256(live) !== manifest.content_sha256) {
      throw new Error(`runtime snapshot plugin manifest content SHA mismatch: ${manifest.origin}`);
    }
  }
  if (snapshot.profile_id !== profile.profile_id || report.profile_id !== profile.profile_id) {
    throw new Error(`runtime snapshot profile id chain mismatch: ${report.snapshot_path}`);
  }
  if (
    snapshot.kernel_selection.requested_provider_id !== profile.kernel.provider_id
    || snapshot.kernel_selection.resolved_provider_id !== profile.kernel.provider_id
  ) {
    throw new Error(`runtime snapshot kernel selection chain mismatch: ${report.snapshot_path}`);
  }
  if (
    snapshot.profile_sha256 !== data.profileSha256
    || snapshot.reproduction_key.profile_sha256 !== data.profileSha256
    || report.profile_sha256 !== data.profileSha256
  ) {
    throw new Error(`runtime snapshot profile SHA chain mismatch: ${report.snapshot_path}`);
  }
  const reproductionKeySha = canonicalSha256(snapshot.reproduction_key);
  if (snapshot.reproduction_key_sha256 !== reproductionKeySha) {
    throw new Error(`runtime snapshot reproduction key is not canonical: ${report.snapshot_path}`);
  }
  if (report.reproduction_key_sha256 !== reproductionKeySha) {
    throw new Error(`runtime snapshot report reproduction key disagrees with snapshot: ${report.snapshot_path}`);
  }
  if (snapshot.reproduction_key.profile_id !== profile.profile_id) {
    throw new Error(`runtime snapshot reproduction profile id mismatch: ${report.snapshot_path}`);
  }
  if (report.pin_gate.requiredAncestor !== profile.formal_gate.required_orchestrator_ancestor) {
    throw new Error(`runtime snapshot required pin disagrees with profile: ${report.snapshot_path}`);
  }
  const capturedOrchestrator = snapshot.reproduction_key.combination_pin.submodules['packages/orchestrator'];
  if (!capturedOrchestrator || capturedOrchestrator !== report.pin_gate.orchestratorGitlink) {
    throw new Error(`runtime snapshot orchestrator pin chain mismatch: ${report.snapshot_path}`);
  }
  const ancestryProofMatches = report.pin_gate.ancestryProof.requiredAncestor === report.pin_gate.requiredAncestor
    && report.pin_gate.ancestryProof.verifiedGitlink === report.pin_gate.orchestratorGitlink;
  if (!ancestryProofMatches) {
    throw new Error(`runtime snapshot ancestry proof verdict mismatch: ${report.snapshot_path}`);
  }
  if (stableStringify(report.formal_eligibility) !== stableStringify(snapshot.formal_eligibility)) {
    throw new Error(`runtime snapshot eligibility chain mismatch: ${report.snapshot_path}`);
  }
  if (!data.inventoryProductCombo) {
    throw new Error(`current runtime snapshot requires a recursive product combo: ${report.snapshot_path}`);
  }
  if (data.inventoryProductCombo) {
    const expectedRoot = data.inventoryProductCombo.studio;
    if (!expectedRoot || snapshot.reproduction_key.combination_pin.root !== expectedRoot) {
      throw new Error(`runtime snapshot root pin chain mismatch: ${report.snapshot_path}`);
    }
    const expectedSubmodules = Object.fromEntries(
      Object.entries(data.inventoryProductCombo)
        .filter(([name]) => name !== 'studio')
        .map(([name, commit]) => [`packages/${name.replaceAll(':', '/')}`, commit])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    if (stableStringify(snapshot.reproduction_key.combination_pin.submodules) !== stableStringify(expectedSubmodules)) {
      throw new Error(`runtime snapshot recursive pin chain mismatch: ${report.snapshot_path}`);
    }
  }
  return integrityReasons;
}

export async function calculateR6Coverage(data: R6CalculatorData): Promise<R6CoverageResult> {
  const source = (key: keyof NonNullable<R6CalculatorData['inputSources']>) => data.inputSources?.[key] ?? key;
  requireNonEmpty(source('ledgerRows'), data.ledgerRows);
  requireNonEmpty(source('effectRows'), data.effectRows);
  requireNonEmpty(source('controls'), data.controls);
  requireNonEmpty(source('edges'), data.edges);
  requireNonEmpty(source('baselineEffects'), data.baselineEffects);
  const ledgerRows: LedgerV1Row[] = parseInputRows(data.ledgerRows, source('ledgerRows'), parseLedgerV1Row);
  const manualPoolAdjudications = parseInputRows(
    data.manualPoolAdjudications,
    source('manualPoolAdjudications'),
    (row) => manualPoolAdjudicationSchema.parse(row),
  );
  const effectRows = parseInputRows(data.effectRows, source('effectRows'), (row) => EffectAdjudicationV1Schema.parse(row));
  const controls = parseInputRows(data.controls, source('controls'), (row) => controlRowSchema.parse(row));
  const edges = parseInputRows(data.edges, source('edges'), (row) => edgeRowSchema.parse(row));
  const baselineEffects = parseInputRows(data.baselineEffects, source('baselineEffects'), (row) => baselineEffectSchema.parse(row));
  const partitionedReports = partitionRuntimeSnapshotReports(data.snapshotReports, source('snapshotReports'));
  const snapshotReports = partitionedReports.reports;
  const runtimeArtifactDiagnostics = [
    ...(data.runtimeArtifactDiagnostics ?? []),
    ...partitionedReports.diagnostics,
  ];
  const manifests = parseInputRows(data.manifests, source('manifests'), parseEvidenceManifest);
  let baselineApproval: BaselineApprovalRecord;
  const baselineApprovalInput = data.baselineApproval as Record<string, unknown>;
  const baselineGovernanceVerification = data.governanceVerification
    ?? baselineApprovalInput?.governance_verification as GovernanceVerification | undefined;
  const {
    governance_verification: _governanceVerification,
    recorded_status: recordedStatus,
    ...baselineApprovalRecordInput
  } = baselineApprovalInput ?? {};
  if (baselineApprovalRecordInput.status === 'unverified-diagnostic') {
    baselineApprovalRecordInput.status = recordedStatus;
  }
  try {
    baselineApproval = parseBaselineApprovalRecord(baselineApprovalRecordInput);
  } catch (error) {
    throw new Error(`${source('baselineApproval')}: ${formattedIssue(error)}`);
  }
  if (baselineApproval.status !== 'approved' && baselineApproval.status !== 'pending') {
    throw new Error(
      `${source('baselineApproval')}: current baseline must be pending or approved, got ${baselineApproval.status}`,
    );
  }
  const reportedApprovalStatus = baselineApproval.status === 'approved'
    && baselineGovernanceVerification?.status === 'unverified-diagnostic'
    ? 'unverified-diagnostic' as const
    : baselineApproval.status;
  let testBindingRegistry: TestBindingRegistry;
  try {
    testBindingRegistry = testBindingRegistrySchema.parse(data.testBindingRegistry);
  } catch (error) {
    throw new Error(`${source('testBindingRegistry')}: ${formattedIssue(error)}`);
  }
  let profile: RuntimeSnapshotProfile;
  try {
    profile = parseRuntimeSnapshotProfile(data.profile);
  } catch (error) {
    throw new Error(`${source('profile')}: ${formattedIssue(error)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(data.profileSha256)) {
    throw new Error(`${source('profile')}: missing or invalid profile SHA-256`);
  }
  const profileText = data.sourceText(source('profile'));
  if (profileText === undefined || sha256(profileText) !== data.profileSha256) {
    throw new Error(`${source('profile')}: profile SHA-256 does not match the source entity`);
  }
  validateRuntimeProfileState(data.repoRoot ?? resolve(import.meta.dir, '../..'), profile);
  if (baselineApproval.baseline_id !== data.baselineId) {
    throw new Error(`${source('baselineApproval')}: baseline_id=${baselineApproval.baseline_id} does not match ${data.baselineId}`);
  }
  const bindingKeys = testBindingRegistry.bindings.map((binding) => `${binding.effect_id}\0${binding.test_id}`);
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    throw new Error(`${source('testBindingRegistry')}: duplicate effect/test binding`);
  }
  for (const binding of testBindingRegistry.bindings) {
    for (const pointer of [binding.binding_evidence.test_call, binding.binding_evidence.handler]) {
      const issue = pointerIssue(pointer, data.sourceText);
      if (issue) throw new Error(`${source('testBindingRegistry')}: ${issue}`);
    }
  }
  validateManifestSet(manifests);
  const snapshotIntegrityReasons = new Map<RuntimeSnapshotReport, string[]>();
  for (const report of snapshotReports) {
    const observed = report.baseline_approval;
    if (
      observed.baseline_id !== baselineApproval.baseline_id
      || observed.baseline_bytes_sha256 !== baselineApproval.baseline_bytes_sha256
      || observed.status !== reportedApprovalStatus
      || observed.decision_evidence !== baselineApproval.decision_evidence
      || observed.decision_evidence_sha256 !== baselineApproval.decision_evidence_sha256
      || observed.approved_content_commit !== baselineApproval.approved_content_commit
      || observed.approval_manifest_raw_sha256 !== baselineApproval.approval_manifest_raw_sha256
      || observed.approval_scope_sha256 !== baselineApproval.approval_scope_sha256
      || observed.approval_package_raw_sha256 !== baselineApproval.approval_package_raw_sha256
    ) {
      throw new Error(`runtime snapshot baseline approval chain mismatch: ${report.snapshot_path}`);
    }
    snapshotIntegrityReasons.set(report, validateSnapshotEntity(report, data, profile));
  }

  if (profile.profile_id.trim() === '') throw new Error('runtime profile id is empty');
  requireUnique(source('ledgerRows'), ledgerRows, (row) => row.control_id);
  requireUnique(
    source('manualPoolAdjudications'),
    manualPoolAdjudications.filter((row): row is typeof row & { control_id: string } => row.control_id !== null),
    (row) => row.control_id,
  );
  requireUnique(source('effectRows'), effectRows, (row) => row.effect_id);
  requireUnique(source('controls'), controls, (row) => row.control_id);
  requireUnique(source('edges'), edges, (row) => `${row.control_id}\0${row.effect_id}`);
  requireUnique(source('baselineEffects'), baselineEffects, (row) => row.effect_id);
  requireUnique(source('snapshotReports'), snapshotReports, (row) => `${row.profile_id}\0${row.mode}`);

  for (const effect of effectRows) {
    if (effect.baseline_id !== data.baselineId) {
      throw new Error(`${source('effectRows')}: effect ${effect.effect_id} baseline_id=${effect.baseline_id} does not match ${data.baselineId}`);
    }
  }
  requireExactKeys('ledger↔controls', ledgerRows.map((row) => row.control_id), controls.map((row) => row.control_id));
  requireExactKeys('adjudications↔baseline-effects', effectRows.map((row) => row.effect_id), baselineEffects.map((row) => row.effect_id));

  const effectById = new Map(effectRows.map((row) => [row.effect_id, row]));
  for (const binding of testBindingRegistry.bindings) {
    if (!effectById.has(binding.effect_id)) {
      throw new Error(`${source('testBindingRegistry')}: unknown effect_id ${binding.effect_id}`);
    }
  }
  const controlById = new Map(controls.map((row) => [row.control_id, row]));
  const baselineEffectById = new Map(baselineEffects.map((row) => [row.effect_id, row]));
  for (const effect of effectRows) {
    if (baselineEffectById.get(effect.effect_id)?.domain !== effect.domain) {
      throw new Error(`${source('effectRows')}: ${effect.effect_id}.domain disagrees with baseline effects inventory`);
    }
  }
  const manifestByEffect = new Map(manifests.map((manifest) => [manifest.mapping.effect_id, manifest]));
  const denominatorRows = effectRows.filter((row) => row.disposition === 'tool' || row.disposition === 'read');
  if (denominatorRows.length === 0) throw new Error('effect adjudications: tool/read denominator must not be zero');

  const edgesByControl = new Map<string, typeof edges>();
  for (const edge of edges) {
    const control = controlById.get(edge.control_id);
    if (!control) throw new Error(`${source('edges')}: orphan control_id ${edge.control_id}`);
    if (!baselineEffectById.has(edge.effect_id)) throw new Error(`${source('edges')}: orphan effect_id ${edge.effect_id}`);
    if (edge.evidence_line !== control.evidence_line) {
      throw new Error(`${source('edges')}: ${edge.control_id}/${edge.effect_id} evidence_line=${edge.evidence_line} does not match control line ${control.evidence_line}`);
    }
    edgesByControl.set(edge.control_id, [...(edgesByControl.get(edge.control_id) ?? []), edge]);
  }
  const ledgerByControl = new Map(ledgerRows.map((row) => [row.control_id, row]));
  const manualAdjudicationByControl = new Map(
    manualPoolAdjudications
      .filter((row): row is typeof row & { control_id: string } => row.control_id !== null)
      .map((row) => [row.control_id, row] as const),
  );
  for (const control of controls) {
    const controlEdges = edgesByControl.get(control.control_id) ?? [];
    const ledger = ledgerByControl.get(control.control_id)!;
    if (ledger.surface !== control.surface) throw new Error(`${source('ledgerRows')}: ${control.control_id}.surface disagrees with controls inventory`);
    if (ledger.owner !== control.owner) throw new Error(`${source('ledgerRows')}: ${control.control_id}.owner disagrees with controls inventory`);
    if (!ledger.evidence.startsWith(`${control.file}:${control.evidence_line} — `)) {
      throw new Error(`${source('ledgerRows')}: ${control.control_id}.evidence does not point to ${control.file}:${control.evidence_line}`);
    }
    if (control.propagation === 'manual-pool') {
      if (control.effect_id !== null || controlEdges.length !== 0) {
        throw new Error(`${source('controls')}: manual-pool control ${control.control_id} must have null effect_id and no edges`);
      }
      const manualAdjudication = manualAdjudicationByControl.get(control.control_id);
      if (!manualAdjudication) {
        throw new Error(`${source('manualPoolAdjudications')}: manual-pool control ${control.control_id} has no adjudication`);
      }
      if (manualAdjudication.baseline_id !== data.baselineId) {
        throw new Error(`${source('manualPoolAdjudications')}: ${control.control_id}.baseline_id disagrees with ${data.baselineId}`);
      }
      if (ledger.effect_id !== manualAdjudication.effect_id) {
        throw new Error(`${source('ledgerRows')}: ${control.control_id}.effect_id disagrees with its manual-pool adjudication`);
      }
      const expectedManualDisposition = control.owner === 'editor'
        ? 'exempt:editor-injected'
        : control.owner === 'other-team'
          ? 'exempt:other-team'
          : manualAdjudication.disposition;
      if (ledger.disposition !== expectedManualDisposition) {
        throw new Error(`${source('ledgerRows')}: ${control.control_id}.disposition disagrees with its manual-pool adjudication`);
      }
      const promotedEffect = effectById.get(ledger.effect_id);
      if ((ledger.disposition === 'tool' || ledger.disposition === 'read') && !promotedEffect) {
        throw new Error(`${source('ledgerRows')}: callable/read manual-pool effect lacks a formal effect entity: ${ledger.effect_id}`);
      }
      if (promotedEffect && promotedEffect.disposition !== ledger.disposition) {
        throw new Error(`${source('ledgerRows')}: ${control.control_id}.disposition=${ledger.disposition} disagrees with formal effect ${ledger.effect_id} (${promotedEffect.disposition})`);
      }
      continue;
    }
    if (controlEdges.length === 0) throw new Error(`${source('controls')}: non-manual control ${control.control_id} has no edge`);
    if (control.effect_id === null || !controlEdges.some((edge) => edge.effect_id === control.effect_id)) {
      throw new Error(`${source('controls')}: ${control.control_id}.effect_id is not one of its edges`);
    }
    if (!controlEdges.some((edge) => edge.effect_id === ledger.effect_id)) {
      throw new Error(`${source('ledgerRows')}: ${control.control_id}.effect_id=${ledger.effect_id} is not a reached edge`);
    }
    const adjudication = effectById.get(ledger.effect_id)!;
    const expectedDisposition = control.owner === 'editor'
      ? 'exempt:editor-injected'
      : control.owner === 'other-team'
        ? 'exempt:other-team'
        : adjudication.disposition;
    if (ledger.disposition !== expectedDisposition) {
      throw new Error(`${source('ledgerRows')}: ${control.control_id}.disposition=${ledger.disposition} disagrees with ${ledger.effect_id} (${expectedDisposition})`);
    }
  }
  const rawWireNames = new Set(data.rawWireNames ?? []);
  const handlerCounts = new Map<string, number>();
  const catalogCounts = new Map<string, number>();
  const catalogById = new Map<string, { id: string; surface?: 'ui' | 'server' | 'both' }>();
  for (const id of data.handlerIds) handlerCounts.set(id, (handlerCounts.get(id) ?? 0) + 1);
  for (const entry of data.catalogEntries) {
    catalogCounts.set(entry.id, (catalogCounts.get(entry.id) ?? 0) + 1);
    if (!catalogById.has(entry.id)) catalogById.set(entry.id, entry);
  }

  const testRuns = new Map<string, { test_id: string; ok: boolean; output: string }>();
  const runTest = async (testId: string): Promise<{ test_id: string; ok: boolean; output: string }> => {
    const cached = testRuns.get(testId);
    if (cached) return cached;
    const run = await data.runTest(testId);
    const result = { test_id: testId, ok: run.ok, output: run.output };
    testRuns.set(testId, result);
    return result;
  };

  const evaluations: R6CoverageResult['evaluations'] = [];
  for (const effect of denominatorRows) {
    const manifest = manifestByEffect.get(effect.effect_id);
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (!manifest) {
      reasons.push('missing-evidence-manifest');
    } else {
      if (manifest.baseline_id !== data.baselineId) reasons.push('manifest-baseline-mismatch');
      if (manifest.status !== 'migrated') reasons.push('manifest-status-not-migrated');
      if (manifest.profile_id !== profile.profile_id) reasons.push('manifest-profile-mismatch');
      if (profile.status !== 'approved') reasons.push('runtime-profile-proposed');
      if (
        effect.agent_equiv === 'verified'
        && effect.verification_evidence_manifest_id !== manifest.manifest_id
      ) {
        reasons.push('verified-evidence-manifest-id-mismatch');
      }
      if (effect.agent_equiv === 'verified' && !manifest.qualifies_for_verified_equivalence) {
        reasons.push('verified-equivalence-not-qualified');
      }
      if (
        effect.agent_equiv === 'verified'
        && !['isolated-fixture-run', 'human-authorized-run'].includes(manifest.verification_level)
      ) {
        reasons.push('verified-equivalence-level-not-executable');
      }

      const reports = snapshotReports.filter((report) => report.profile_id === manifest.profile_id);
      const formal = reports.find((report) => (
        report.mode === 'formal'
        && report.status === 'FORMAL_CAPTURED'
        && report.formal_record
        && report.formal_eligibility.eligible
        && report.pin_gate.arrived
      ));
      const development = reports.find((report) => (
        report.mode === 'development'
        && report.status === 'DEVELOPMENT_VERIFIED'
        && !report.formal_record
      ));
      if (reports.length === 0) {
        reasons.push('runtime-snapshot-report-missing');
      } else if (reports.some((report) => report.status === 'PROPOSED')) {
        reasons.push('runtime-snapshot-report-proposed');
      } else if (!formal) {
        if (reports.some((report) => report.mode === 'formal' && !report.pin_gate.arrived)) {
          reasons.push('formal-runtime-snapshot-pin-not-arrived');
        } else if (development) {
          reasons.push('formal-runtime-snapshot-required');
        } else {
          reasons.push('formal-runtime-snapshot-invalid');
        }
      } else {
        if (formal.profile_status !== 'approved') reasons.push('runtime-snapshot-profile-proposed');
        if (formal.profile_sha256 !== data.profileSha256) reasons.push('runtime-snapshot-profile-sha256-mismatch');
        if (!formal.byte_identical) reasons.push('runtime-snapshot-not-byte-identical');
        if (manifest.reproduction_key_sha256 !== formal.reproduction_key_sha256) {
          reasons.push('reproduction-key-sha256-mismatch');
        }
        for (const reason of snapshotIntegrityReasons.get(formal) ?? []) addOnce(reasons, reason);
        const expectedStderr = manifest.formal_capture?.child_stderr_sha256;
        const actualStderr = formal.child_processes.map((child) => ({
          index: child.index,
          sha256: child.stderr_sha256,
        }));
        if (!expectedStderr || stableStringify(expectedStderr) !== stableStringify(actualStderr)) {
          addOnce(reasons, 'formal-stderr-summary-mismatch');
        }
      }

      const effectEdges = edges.filter((edge) => edge.effect_id === effect.effect_id);
      const allControlIds = new Set(effectEdges.map((edge) => edge.control_id));
      if (allControlIds.size === 0) reasons.push('effect-has-no-control-entry');
      if (!sameStrings(allControlIds, manifest.mapping.control_ids)) reasons.push('incomplete-control-entry-rescan');
      const baselineEffect = baselineEffectById.get(effect.effect_id);
      if (!baselineEffect?.vocab.actions.includes(effect.effect_id)) reasons.push('effect-not-action-routed');

      for (const controlId of allControlIds) {
        const control = controlById.get(controlId);
        if (!control) {
          addOnce(reasons, `missing-control:${controlId}`);
          continue;
        }
        const source = data.sourceText(control.file);
        if (source === undefined) {
          addOnce(reasons, `missing-control-source:${control.file}`);
          continue;
        }
        if (control.evidence_line > source.split('\n').length) {
          addOnce(reasons, `control-line-out-of-range:${control.file}:${control.evidence_line}`);
        }
        const edge = effectEdges.find((row) => row.control_id === controlId);
        if (!edge?.via.includes(`action:${effect.effect_id}`) || !sourceDeclaresAction(source, effect.effect_id)) {
          addOnce(reasons, `direct-call-residual:${controlId}`);
        }
      }
      if (manifest.direct_call_residual.status !== 'none') reasons.push('manifest-reports-direct-call-residual');
      if (manifest.direct_call_residual.evidence_refs.length === 0) reasons.push('missing-residual-rescan-evidence');

      const evidencePointers = [
        ...manifest.evidence_refs,
        ...manifest.direct_call_residual.evidence_refs,
      ];
      for (const pointer of evidencePointers) {
        const issue = pointerIssue(pointer, data.sourceText);
        if (issue) addOnce(reasons, issue);
      }

      if (manifest.mapping.tests.length === 0) reasons.push('missing-test-id');
      const registeredTests = new Set(
        testBindingRegistry.bindings
          .filter((binding) => binding.effect_id === effect.effect_id)
          .map((binding) => binding.test_id),
      );
      if (registeredTests.size === 0) reasons.push('missing-test-binding-registry-entry');
      for (const claim of manifest.mapping.tests) {
        const testId = claim.test_id;
        if (!registeredTests.has(testId)) {
          addOnce(reasons, `test-binding-registry-mismatch:${testId}:${effect.effect_id}`);
        }
        if (!claim.proves_effect_ids.includes(effect.effect_id)) {
          addOnce(reasons, `test-does-not-prove-effect:${testId}:${effect.effect_id}`);
        }
        const parsed = parseTestId(testId);
        if (!parsed) {
          addOnce(reasons, `invalid-test-id:${testId}`);
          continue;
        }
        const source = data.sourceText(parsed.file);
        if (source === undefined || !sourceDeclaresExactTest(source, parsed.title)) {
          addOnce(reasons, `unresolved-test-id:${testId}`);
          continue;
        }
        const executed = await runTest(testId);
        if (!executed.ok) {
          addOnce(reasons, `test-failed:${testId}`);
          if (effect.agent_equiv === 'verified') {
            addOnce(reasons, `stale-evidence:verified-test-failed:${testId}`);
          }
        }
      }

      if (manifest.wire_name === null) {
        reasons.push('missing-final-wire-name');
      } else {
        const accounting = profile.tool_accounting[manifest.wire_name];
        if (!accounting) {
          reasons.push(rawWireNames.has(manifest.wire_name) ? 'wire-raw-only-final-missing' : 'final-wire-missing');
        } else if (!sameStrings(accounting.mapped_effects ?? [], [effect.effect_id])) {
          reasons.push('final-wire-conflict');
        }
      }

      switch (manifest.equivalent.kind) {
        case 'action': {
          const actionId = manifest.equivalent.id!;
          if (actionId !== effect.effect_id) reasons.push('action-equivalent-effect-mismatch');
          if (!sameStrings(manifest.mapping.handler_ids, [actionId])) reasons.push('handler-mapping-mismatch');
          if ((catalogCounts.get(actionId) ?? 0) !== 1) reasons.push('catalog-action-not-unique');
          const entry = catalogById.get(actionId);
          if (entry?.surface !== 'both' && entry?.surface !== 'server') reasons.push('action-equivalent-not-headless-reachable');
          if ((handlerCounts.get(actionId) ?? 0) !== 1) reasons.push('headless-handler-not-unique-or-missing');
          if (manifest.tool_source !== 'catalog-firstclass') reasons.push('action-tool-source-mismatch');
          break;
        }
        case 'tool': {
          const toolId = manifest.equivalent.id!;
          if (manifest.wire_name !== toolId) reasons.push('tool-equivalent-wire-mismatch');
          if (!sameStrings(manifest.mapping.handler_ids, [toolId])) reasons.push('handler-mapping-mismatch');
          if (!rawWireNames.has(toolId)) reasons.push('tool-equivalent-not-in-live-registry');
          if ((handlerCounts.get(toolId) ?? 0) !== 1) reasons.push('tool-handler-not-unique-or-missing');
          if (manifest.tool_source === 'catalog-firstclass') reasons.push('tool-source-claims-action-catalog');
          break;
        }
        case 'headless': {
          const handlerId = manifest.equivalent.id!;
          if (!sameStrings(manifest.mapping.handler_ids, [handlerId])) reasons.push('handler-mapping-mismatch');
          if ((handlerCounts.get(handlerId) ?? 0) !== 1) reasons.push('headless-handler-not-unique-or-missing');
          if (manifest.wire_name !== null) {
            const accounting = profile.tool_accounting[manifest.wire_name];
            if (!accounting || !sameStrings(accounting.mapped_effects ?? [], [effect.effect_id])) {
              reasons.push('headless-final-wire-conflict');
            }
          }
          break;
        }
        case 'none':
          reasons.push('missing-equivalent');
          break;
        default: {
          const exhaustive: never = manifest.equivalent.kind;
          throw new Error(`unhandled equivalent kind: ${exhaustive}`);
        }
      }

      if (effect.agent_equiv === 'none' && manifest.qualifies_for_verified_equivalence) {
        warnings.push('manifest-verification-is-newer-than-r4-adjudication');
      }
    }

    const verifiedEvidenceComplete = manifest !== undefined
      && manifest.qualifies_for_verified_equivalence
      && ['isolated-fixture-run', 'human-authorized-run'].includes(manifest.verification_level)
      && effect.verification_evidence_manifest_id === manifest.manifest_id
      && reasons.length === 0;
    evaluations.push({
      effect_id: effect.effect_id,
      domain: effect.domain,
      agent_equiv: effect.agent_equiv === 'verified' && !verifiedEvidenceComplete
        ? 'declared'
        : effect.agent_equiv,
      status: manifest && reasons.length === 0 ? 'migrated' : 'unmigrated',
      manifest_id: manifest?.manifest_id ?? null,
      reasons,
      warnings,
    });
  }

  for (const manifest of manifests) {
    if (!effectById.has(manifest.mapping.effect_id)) {
      throw new Error(`manifest effect does not exist in adjudications: ${manifest.mapping.effect_id}`);
    }
  }

  const migrated = evaluations.filter((row) => row.status === 'migrated');
  const effectiveEquivalence = new Map(evaluations.map((row) => [row.effect_id, row.agent_equiv]));
  const effectiveEffectRows = effectRows.map((row): R6EffectRow => (
    row.agent_equiv === 'verified' && effectiveEquivalence.get(row.effect_id) === 'declared'
      ? { ...row, agent_equiv: 'declared' as const }
      : row
  ));
  const effectiveDenominatorRows = effectiveEffectRows.filter(
    (row) => row.disposition === 'tool' || row.disposition === 'read',
  );
  const migratedEffects = new Set(migrated.map((row) => row.effect_id));
  const migratedControlIds = sorted(
    manifests
      .filter((manifest) => migratedEffects.has(manifest.mapping.effect_id))
      .flatMap((manifest) => manifest.mapping.control_ids),
  );
  const domains = sorted(new Set(denominatorRows.map((row) => row.domain))).map((domain) => {
    const domainRows = denominatorRows.filter((row) => row.domain === domain);
    const migratedCount = migrated.filter((row) => row.domain === domain).length;
    return {
      domain,
      migrated: migratedCount,
      denominator: domainRows.length,
      tool: domainRows.filter((row) => row.disposition === 'tool').length,
      read: domainRows.filter((row) => row.disposition === 'read').length,
      coverage_percent: Number(((migratedCount / domainRows.length) * 100).toFixed(2)),
    };
  });
  const excludedEffectsByDisposition: Record<string, number> = {};
  for (const row of effectRows.filter((effect) => effect.disposition !== 'tool' && effect.disposition !== 'read')) {
    excludedEffectsByDisposition[row.disposition] = (excludedEffectsByDisposition[row.disposition] ?? 0) + 1;
  }
  const formalCoverageReport = snapshotReports.find((report) => (
    report.mode === 'formal'
    && report.status === 'FORMAL_CAPTURED'
    && report.formal_record
    && report.formal_eligibility.eligible
    && report.pin_gate.arrived
    && (snapshotIntegrityReasons.get(report)?.length ?? 0) === 0
  ));

  return {
    baseline_id: data.baselineId,
    baseline_approval: reportedApprovalStatus,
    baseline_bytes_sha256: baselineApproval.baseline_bytes_sha256,
    ...(baselineGovernanceVerification
      ? { baseline_governance_verification: baselineGovernanceVerification }
      : {}),
    governance_reason_codes: baselineGovernanceVerification?.status === 'unverified-diagnostic'
      ? ['baseline-governance-unverified']
      : [],
    result_status: reportedApprovalStatus === 'approved' ? 'final' : 'draft',
    coverage_tier: reportedApprovalStatus === 'approved'
      ? formalCoverageReport?.coverage_tier ?? 'provisional'
      : 'provisional',
    exclusion_disclosure: {
      included_dispositions: ['tool', 'read'],
      excluded_effects_by_disposition: Object.fromEntries(Object.entries(excludedEffectsByDisposition).sort()),
    },
    control_entry_rescan: {
      provenance: data.inventoryProvenance ?? 'supplied-inventory',
      controls: controls.length,
      edges: edges.length,
    },
    numerator: migrated.length,
    denominator: denominatorRows.length,
    coverage_percent: Number(((migrated.length / denominatorRows.length) * 100).toFixed(2)),
    domains,
    equivalence: countEquivalence(effectiveDenominatorRows),
    equivalence_all_effects: countEquivalence(effectiveEffectRows),
    migrated_effect_ids: sorted(migratedEffects),
    migrated_control_ids: migratedControlIds,
    evaluations,
    test_runs: [...testRuns.values()].sort((left, right) => left.test_id.localeCompare(right.test_id)),
    runtime_snapshot_diagnostics: runtimeArtifactDiagnostics,
  };
}

export async function calculateRepositoryR6Coverage(
  root: string,
  runtime: RepositoryRuntimeRegistry,
): Promise<R6CoverageResult> {
  const baselineId = loadCurrentBaselineState(root).currentBaselineId;
  const baselineDir = join(root, 'docs/ai-native/baseline', baselineId);
  const manifestDir = join(root, 'scripts/ai-native/evidence-manifests-v1');
  const snapshotReportDir = join(root, 'scripts/ai-native/runtime-snapshot-reports');
  const testBindingRegistryPath = join(root, 'scripts/ai-native/test-binding-registry.json');
  const baselineApprovalPath = join(root, 'docs/ai-native/baseline/approvals.json');
  const pinSource = resolveRuntimePinSource(root);
  const profilePath = join(root, 'scripts/ai-native/profiles/main.json');
  const loadedProfile = loadValidatedRuntimeProfile(root, profilePath, pinSource);
  assertPinnedEvidenceManifestSet(root, pinSource);
  const manifests = readdirSync(manifestDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseJsonFile(join(manifestDir, name), parseEvidenceManifest));
  const snapshotReports = runtime.snapshotReports ?? readdirSync(snapshotReportDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(snapshotReportDir, name);
      return { path, rawText: readFileSync(path, 'utf8') };
    });
  const runtimeArtifactDiagnostics: RuntimeArtifactDiagnostic[] = [];
  const snapshotDirectory = join(root, 'scripts/ai-native/runtime-snapshots');
  for (const name of readdirSync(snapshotDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(snapshotDirectory, name);
    const rawText = readFileSync(path, 'utf8');
    let schemaVersion: unknown;
    try {
      schemaVersion = (JSON.parse(rawText) as { schema_version?: unknown }).schema_version;
    } catch (error) {
      throw new Error(`${path}: invalid JSON: ${formattedIssue(error)}`);
    }
    if (schemaVersion === 2) continue;
    runtimeArtifactDiagnostics.push(
      historicalRuntimeArtifactDiagnostic('snapshot', path, rawText)
      ?? rejectedRuntimeArtifactDiagnostic('snapshot', path, rawText),
    );
  }
  const rootAbs = resolve(root);
  const profileBytes = new TextEncoder().encode(loadedProfile.profileRaw);
  if (runtime.currentInventory && runtime.currentInventory.baselineId !== baselineId) {
    throw new Error(`current inventory baseline mismatch: ${runtime.currentInventory.baselineId}`);
  }
  const inventory = runtime.currentInventory ?? {
    baselineId,
    controls: jsonLines(join(baselineDir, 'controls.jsonl')),
    edges: jsonLines(join(baselineDir, 'edges.jsonl')),
    effects: jsonLines(join(baselineDir, 'effects.jsonl')),
    productCombo: parseJsonFile(
      join(baselineDir, 'meta.json'),
      (value) => z.object({
        scanned_product_combo: z.record(z.string().regex(/^[0-9a-f]{40}$/)),
      }).passthrough().parse(value).scanned_product_combo,
    ),
  };
  if (runtime.currentInventory && !runtime.currentInventory.productCombo) {
    throw new Error('current inventory requires a recursive product combo');
  }
  const sourceText = (path: string): string | undefined => {
    const target = isAbsolute(path) ? resolve(path) : resolve(rootAbs, path);
    if (relative(rootAbs, target).startsWith('..')) return undefined;
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return undefined;
    }
  };
  const baselineApproval = loadBaselineApproval(root, baselineId, pinSource);
  const governanceVerification = mergeGovernanceVerifications([
    baselineApproval.governance_verification,
    loadedProfile.governanceVerification,
  ]);
  return calculateR6Coverage({
    baselineId,
    ledgerRows: jsonLines(join(root, 'scripts/ai-native/ledger-v1.jsonl')),
    manualPoolAdjudications: jsonLines(join(root, 'scripts/ai-native/manual-pool-adjudications-v1.jsonl')),
    effectRows: jsonLines(join(root, 'scripts/ai-native/effect-adjudications-v1.jsonl')),
    controls: inventory.controls,
    edges: inventory.edges,
    baselineEffects: inventory.effects,
    snapshotReports,
    runtimeArtifactDiagnostics,
    inventoryProvenance: runtime.currentInventory
      ? 'current source rescan under immutable pin (no git)'
      : 'frozen b1 inventory',
    manifests,
    baselineApproval,
    governanceVerification,
    testBindingRegistry: JSON.parse(readFileSync(testBindingRegistryPath, 'utf8')) as unknown,
    profile: loadedProfile.profile,
    profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
    repoRoot: root,
    inventoryProductCombo: inventory.productCombo,
    catalogEntries: runtime.catalogEntries,
    handlerIds: runtime.handlerIds,
    rawWireNames: runtime.rawWireNames,
    sourceText,
    runTest: runtime.runTest,
    inputSources: {
      ledgerRows: join(root, 'scripts/ai-native/ledger-v1.jsonl'),
      manualPoolAdjudications: join(root, 'scripts/ai-native/manual-pool-adjudications-v1.jsonl'),
      effectRows: join(root, 'scripts/ai-native/effect-adjudications-v1.jsonl'),
      controls: join(baselineDir, 'controls.jsonl'),
      edges: join(baselineDir, 'edges.jsonl'),
      baselineEffects: join(baselineDir, 'effects.jsonl'),
      snapshotReports: snapshotReportDir,
      manifests: manifestDir,
      profile: join(root, 'scripts/ai-native/profiles/main.json'),
      baselineApproval: baselineApprovalPath,
      testBindingRegistry: testBindingRegistryPath,
    },
  });
}
