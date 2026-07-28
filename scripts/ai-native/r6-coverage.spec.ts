import { describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildActionCatalog, catalogAll } from '../../packages/orchestrator/src/kernel/action-catalog';
import { listBuiltinHeadlessUiActionIds } from '../../packages/orchestrator/src/kernel/ui-headless-actions';
import {
  canonicalSha256,
  runtimeProfileApprovalSha256,
  sha256,
  stablePrettyJson,
  type RuntimeSnapshotProfile,
} from './runtime-snapshot-core';
import {
  calculateR6Coverage,
  calculateRepositoryR6Coverage,
  type R6CalculatorData,
} from './r6-coverage';
import {
  assertPinnedEvidenceManifestSet,
  RUNTIME_PIN_PATH,
} from './runtime-artifact-integrity.ts';

const OVERLAP_EFFECTS = [
  ['game.create', 'verified'],
  ['game.switch', 'verified'],
  ['role.create', 'verified'],
  ['role.list', 'verified'],
  ['session.rename', 'declared'],
  ['sessions.refresh', 'declared'],
] as const;

function controlId(index: number): string {
  return `ctl_${index.toString(16).padStart(24, '0')}`;
}

function profile(): RuntimeSnapshotProfile {
  const approvalPayload: RuntimeSnapshotProfile = {
    schema_version: 1,
    profile_id: 'main',
    status: 'approved',
    description: 'R6 counterexample fixture',
    agent: {
      id: 'forge',
      expected_trust_tier: 'own',
      expected_source: 'forge',
      expected_host_tool_allow: [],
      expected_host_tool_deny: [],
    },
    kernel: { provider_id: 'forgeax-core' },
    fixture: {
      game_slug: 'r6-fixture',
      session_alias: 'r6-session',
      thread_id: 'r6-thread',
      call_id: 'r6-call',
      message: 'fixture',
    },
    ui_state: { lease: 'absent', runtime_manifest: 'absent' },
    plugin_policy: { safe_boot: true, layers: ['L0'] },
    product_shell: { host_tools: 'studioHostTools', system_prompt_composer: 'GameSystemPromptComposer' },
    formal_gate: {
      required_orchestrator_ancestor: 'a'.repeat(40),
      waiver: {
        waived_blockers: ['extension-kind-issues'],
        waived_instances: ['asset2d:templates.list', 'asset2d:templates.get'],
        max_count: 2,
        reason: 'Fixture waiver for a third-party duplicate tool id.',
        issuer: 'supervisory-lane',
        date: '2026-07-24',
      },
    },
    tool_accounting: Object.fromEntries(
      OVERLAP_EFFECTS.map(([effectId]) => [wireName(effectId), { mapped_effects: [effectId] }]),
    ),
  };
  return {
    ...approvalPayload,
    approval_record: {
      approver: 'supervisory-lane(orchestration)',
      date: '2026-07-24',
      profile_sha256: runtimeProfileApprovalSha256(approvalPayload),
      channel: 'orchestration session 2026-07-23',
      pending_user_ratification: true,
    },
  };
}

function wireName(effectId: string): string {
  return `ui_act_${effectId.replaceAll('.', '_')}`;
}

const FIXTURE_PROFILE = profile();
const FIXTURE_PROFILE_PATH = 'profiles/main.json';
const FIXTURE_PROFILE_TEXT = stablePrettyJson(FIXTURE_PROFILE);
const FIXTURE_PROFILE_SHA256 = sha256(FIXTURE_PROFILE_TEXT);
const FIXTURE_SNAPSHOT_PATH = 'scripts/ai-native/runtime-snapshots/test.development.json';
const FIXTURE_PLUGIN_PATH = 'fixtures/plugin/forgeax-extension.json';
const FIXTURE_PLUGIN_TEXT = '{"id":"fixture-plugin"}\n';
const FROZEN_HISTORY_REPORT = `{
  "byte_identical": true,
  "child_processes": [
    {
      "exit_code": 0,
      "index": 1,
      "stderr_sha256": "8e128fd92778ef90e081aebc5678d4718e19f7ae2d4bcec3f0f6ae79cdb83626",
      "stdout_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    },
    {
      "exit_code": 0,
      "index": 2,
      "stderr_sha256": "0f48231616a4c5d6f61edbd6633a2c66138310712a62b0cd3789e9b6953f3eee",
      "stdout_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ],
  "clean_processes": 2,
  "coverage_tier": "formal-with-waiver",
  "formal_eligibility": {
    "blockers": [],
    "eligible": true,
    "waived_blockers": [
      "extension-kind-issues"
    ]
  },
  "formal_record": true,
  "mode": "formal",
  "pin_gate": {
    "arrived": true,
    "orchestratorGitlink": "5d85c90c89b06a9bdaddc509010e45e2dcb7324d",
    "requiredAncestor": "5d85c90c89b06a9bdaddc509010e45e2dcb7324d",
    "verification": "immutable-pin-exact-only"
  },
  "profile_id": "main",
  "profile_path": "scripts/ai-native/profiles/main.json",
  "profile_sha256": "2ff362060b1f26ea19bdc5980217878ebde24fc277615899a3ee505478196001",
  "profile_status": "approved",
  "reproduction_key_sha256": "28310e9f1e4f298b1e5962b7b03490bfbd16942e5968f22b3c3bb1ec2a3f43e4",
  "schema_version": 1,
  "snapshot_bytes": 98400,
  "snapshot_path": "scripts/ai-native/runtime-snapshots/main.formal.json",
  "snapshot_sha256": "c1ed282eccd8439a35de9334767c681a52d5afc052cabbc59734fcbf12b8a169",
  "status": "FORMAL_CAPTURED"
}
`;
const FIXTURE_PLUGIN_MANIFESTS = [{
  id: '@forgeax-extension/fixture',
  version: '1.0.0',
  layer: 'L0' as const,
  origin: FIXTURE_PLUGIN_PATH,
  content_sha256: sha256(FIXTURE_PLUGIN_TEXT),
}];
const FIXTURE_REPRODUCTION_KEY = {
  profile_id: 'main',
  profile_sha256: FIXTURE_PROFILE_SHA256,
  combination_pin: {
    root: 'f'.repeat(40),
    submodules: { 'packages/orchestrator': 'a'.repeat(40) },
    dirty: false,
  },
  agent: {
    id: 'forge',
    trust_tier: 'own',
    source: 'forge',
    agent_json_sha256: '1'.repeat(64),
    host_tools: { allow: [], deny: [] },
    record_tools: [],
    record_skills: [],
    persona_sha256: '2'.repeat(64),
  },
  plugin_combination: {
    policy: { safe_boot: true, layers: ['L0'] as ['L0'] },
    manifests: FIXTURE_PLUGIN_MANIFESTS,
    manifest_set_sha256: canonicalSha256(FIXTURE_PLUGIN_MANIFESTS),
  },
  product_shell: {
    host_tools: [],
    system_prompt_composer: 'GameSystemPromptComposer',
    host_tools_sha256: '3'.repeat(64),
  },
  action_catalog: { count: 1, content_sha256: '4'.repeat(64) },
  fixture: {
    game_slug: 'r6-fixture',
    session_alias: 'r6-session',
    thread_id: 'r6-thread',
    call_id: 'r6-call',
    ui_state: { lease: 'absent', runtime_manifest: 'absent' },
  },
  capture_mode: 'formal' as const,
};
const FIXTURE_REPRODUCTION_KEY_SHA256 = canonicalSha256(FIXTURE_REPRODUCTION_KEY);
const FIXTURE_ELIGIBILITY = {
  eligible: true,
  blockers: [] as string[],
  waived_blockers: ['extension-kind-issues'],
};
const FIXTURE_SNAPSHOT = {
  schema_version: 2,
  profile_id: 'main',
  profile_sha256: FIXTURE_PROFILE_SHA256,
  capture_mode: 'formal',
  reproduction_key_sha256: FIXTURE_REPRODUCTION_KEY_SHA256,
  reproduction_key: FIXTURE_REPRODUCTION_KEY,
  runtime_environment: { bun_version: Bun.version },
  kernel_selection: { requested_provider_id: 'forgeax-core', resolved_provider_id: 'forgeax-core' },
  execution_boundary: { stopped_before: 'AgentKernel.runTurn', run_turn_invoked: false, model_calls: 0 },
  route_assembly: {
    chain: ['hostToolSpecsForAgent', 'extraTools', 'composeTurnRequest'],
    normalized_turn_request_sha256: '5'.repeat(64),
    normalized_system_prompt_sha256: '6'.repeat(64),
  },
  raw_tool_catalog: [],
  final_tools: [{
    name: 'ui_act_role_create',
    tool_source: 'catalog-firstclass',
    source_id: 'role.create',
    description_sha256: '7'.repeat(64),
    input_schema_sha256: '8'.repeat(64),
    mapped_effects: ['role.create'],
  }],
  raw_final_difference: {
    raw_count: 0,
    final_count: 1,
    allowed_plugin_wire_names: [],
    raw_only: [],
  },
  tool_accounting: { complete: true, unresolved: [] },
  extension_diagnostics: {
    scan_errors: [],
    merge_issues: [],
    kind_issues: [],
    formal_blocking_kind_issues: [],
  },
  formal_eligibility: FIXTURE_ELIGIBILITY,
};
const FIXTURE_SNAPSHOT_TEXT = stablePrettyJson(FIXTURE_SNAPSHOT);
const FIXTURE_BASELINE_APPROVAL = {
  baseline_id: 'b1-2026-07-24-0.6.2',
  baseline_bytes_sha256: 'b'.repeat(64),
  status: 'approved' as const,
  decision_evidence: 'docs/ai-native/evidence/fixture-baseline-approval.md',
  decision_evidence_sha256: 'c'.repeat(64),
  approved_content_commit: 'd'.repeat(40),
  approval_manifest_raw_sha256: 'e'.repeat(64),
  approval_scope_sha256: 'f'.repeat(64),
  approval_package_raw_sha256: 'a'.repeat(64),
};

function manifest(effectId: string, id: string = controlId(1)): Record<string, unknown> {
  return {
    schema_version: 1,
    manifest_id: `m2-r6-${effectId}`,
    baseline_id: 'b1-2026-07-24-0.6.2',
    status: 'migrated',
    mapping: {
      effect_id: effectId,
      control_ids: [id],
      handler_ids: [effectId],
      tests: [{
        test_id: 'tests/role.test.ts#executes the equivalent',
        proves_effect_ids: [effectId],
      }],
    },
    equivalent: { kind: 'action', id: effectId },
    context: { agent_id: 'forge', trust_tier: 'own', session_id: null, game_slug: null },
    wire_name: wireName(effectId),
    direct_call_residual: {
      status: 'none',
      evidence_refs: ['src/role.ts:1 — the control routes through the action declaration'],
    },
    verification_level: 'isolated-fixture-run',
    profile_id: 'main',
    reproduction_key_sha256: FIXTURE_REPRODUCTION_KEY_SHA256,
    tool_source: 'catalog-firstclass',
    qualifies_for_verified_equivalence: true,
    evidence_refs: ['src/role.ts:1 — executable fixture evidence'],
  };
}

function fixture(effectIds: ReadonlyArray<readonly [string, 'verified' | 'declared' | 'none']>): R6CalculatorData {
  const controls = effectIds.map((_, index) => ({
    control_id: controlId(index + 1),
    repo: 'interface',
    surface: 'palette',
    event: 'action',
    component: 'FixtureRole',
    file: 'src/role.ts',
    evidence_line: 1,
    effect_id: effectIds[index]![0],
    propagation: 'direct',
    owner: 'us',
    notes: 'fixture control',
  }));
  return {
    baselineId: 'b1-2026-07-24-0.6.2',
    ledgerRows: effectIds.map(([effectId, agentEquiv], index) => ({
      control_id: controls[index].control_id,
      surface: 'palette',
      effect_id: effectId,
      disposition: effectId.endsWith('.list') || effectId.endsWith('.refresh') ? 'read' : 'tool',
      agent_equiv: agentEquiv,
      headless: 'yes',
      status: 'todo',
      owner: 'us',
      evidence: 'src/role.ts:1 — fixture control',
    })),
    manualPoolAdjudications: [],
    effectRows: effectIds.map(([effectId, agentEquiv]) => ({
      schema_version: 1,
      baseline_id: 'b1-2026-07-24-0.6.2',
      effect_id: effectId,
      domain: effectId.split('.')[0],
      disposition: effectId.endsWith('.list') || effectId.endsWith('.refresh') ? 'read' : 'tool',
      agent_equiv: agentEquiv,
      headless: 'yes',
      certainty: 'adjudicated',
      evidence: 'src/role.ts:1 — fixture adjudication',
      ...(agentEquiv === 'verified'
        ? { verification_evidence_manifest_id: `fixture-verification-${effectId}` }
        : {}),
    })),
    controls,
    edges: effectIds.map(([effectId], index) => ({
      control_id: controls[index].control_id,
      effect_id: effectId,
      propagation: 'direct',
      via: [`action:${effectId}`],
      evidence_line: 1,
    })),
    baselineEffects: effectIds.map(([effectId]) => ({
      effect_id: effectId,
      repo: ['interface'],
      vocab: { setters: [], commands: [], actions: [effectId] },
      agent_equiv: {
        action: { id: effectId, capability: 'fixture', surface: 'both', firstClass: true },
        headless: 'yes',
      },
      server_endpoints: [],
      domain: effectId.split('.')[0],
    })),
    snapshotReports: [{
      schema_version: 2,
      mode: 'formal',
      status: 'FORMAL_CAPTURED',
      formal_record: true,
      coverage_tier: 'formal-with-waiver',
      profile_id: 'main',
      profile_status: 'approved',
      profile_path: FIXTURE_PROFILE_PATH,
      snapshot_path: FIXTURE_SNAPSHOT_PATH,
      profile_sha256: FIXTURE_PROFILE_SHA256,
      reproduction_key_sha256: FIXTURE_REPRODUCTION_KEY_SHA256,
      snapshot_sha256: sha256(FIXTURE_SNAPSHOT_TEXT),
      snapshot_bytes: new TextEncoder().encode(FIXTURE_SNAPSHOT_TEXT).byteLength,
      byte_identical: true,
      clean_processes: 2,
      pin_gate: {
        requiredAncestor: 'a'.repeat(40),
        orchestratorGitlink: 'a'.repeat(40),
        arrived: true,
        verification: 'git-ancestry',
        pinSchemaVersion: 3,
        ancestryProof: {
          requiredAncestor: 'a'.repeat(40),
          verifiedGitlink: 'a'.repeat(40),
          verification: 'git-merge-base-is-ancestor',
        },
        expectedBunVersion: Bun.version,
        bunVersionMatches: true,
        scannerInputFingerprintMatches: true,
        scannerConfigurationFingerprintMatches: true,
        reasonCodes: [],
      },
      child_processes: [1, 2].map((index) => ({
        index,
        exit_code: 0,
        stdout_sha256: 'd'.repeat(64),
        stderr_sha256: 'e'.repeat(64),
      })),
      formal_eligibility: FIXTURE_ELIGIBILITY,
      runtime_environment: { bun_version: Bun.version },
      baseline_approval: FIXTURE_BASELINE_APPROVAL,
    }],
    manifests: [],
    baselineApproval: FIXTURE_BASELINE_APPROVAL,
    testBindingRegistry: {
      schema_version: 1,
      bindings: effectIds.map(([effectId]) => ({
        effect_id: effectId,
        test_id: 'tests/role.test.ts#executes the equivalent',
        binding_evidence: {
          test_call: 'tests/role.test.ts:1 — the fixture test invokes the equivalent',
          handler: 'src/role.ts:1 — the fixture registers the equivalent action handler',
        },
      })),
    },
    profile: structuredClone(FIXTURE_PROFILE),
    profileSha256: FIXTURE_PROFILE_SHA256,
    inventoryProductCombo: { studio: 'f'.repeat(40), orchestrator: 'a'.repeat(40) },
    catalogEntries: effectIds.map(([id]) => ({ id, surface: 'both' as const })),
    handlerIds: effectIds.map(([id]) => id),
    rawWireNames: effectIds.map(([id]) => wireName(id)),
    sourceText: (path) => path === 'src/role.ts'
      ? effectIds.map(([id]) => `registerAction({ id: '${id}' });`).join('\n')
      : path === 'tests/role.test.ts'
        ? "test('executes the equivalent', () => {});"
        : path === FIXTURE_PLUGIN_PATH
          ? FIXTURE_PLUGIN_TEXT
        : path === FIXTURE_PROFILE_PATH
          ? FIXTURE_PROFILE_TEXT
          : path === FIXTURE_SNAPSHOT_PATH
            ? FIXTURE_SNAPSHOT_TEXT
        : undefined,
    runTest: async () => ({ ok: true, output: '1 pass' }),
    inputSources: { profile: FIXTURE_PROFILE_PATH },
  };
}

function status(result: Awaited<ReturnType<typeof calculateR6Coverage>>, effectId: string): string {
  return result.evaluations.find((row) => row.effect_id === effectId)?.status ?? 'missing';
}

function attachRawSnapshot(data: R6CalculatorData): { path: string; reproductionKeySha256: string } {
  return {
    path: String((data.snapshotReports[0] as Record<string, unknown>).snapshot_path),
    reproductionKeySha256: String(
      (data.snapshotReports[0] as Record<string, unknown>).reproduction_key_sha256,
    ),
  };
}

function replaceRawSnapshot(data: R6CalculatorData, raw: unknown): void {
  const report = data.snapshotReports[0] as Record<string, unknown>;
  const path = String(report.snapshot_path);
  const text = stablePrettyJson(raw);
  report.snapshot_sha256 = sha256(text);
  report.snapshot_bytes = new TextEncoder().encode(text).byteLength;
  const previousSourceText = data.sourceText;
  data.sourceText = (candidate) => candidate === path ? text : previousSourceText(candidate);
}

function refreshProfileApproval(data: R6CalculatorData): void {
  const runtimeProfile = data.profile as RuntimeSnapshotProfile;
  runtimeProfile.approval_record = {
    ...runtimeProfile.approval_record!,
    profile_sha256: runtimeProfileApprovalSha256(runtimeProfile),
  };
}

function promoteFixtureSnapshotV2(
  data: R6CalculatorData,
  captureMode: 'development' | 'formal' = 'formal',
): string {
  const raw = structuredClone(FIXTURE_SNAPSHOT) as Record<string, any>;
  raw.capture_mode = captureMode;
  raw.reproduction_key.capture_mode = captureMode;
  raw.reproduction_key_sha256 = canonicalSha256(raw.reproduction_key);
  replaceRawSnapshot(data, raw);
  const report = data.snapshotReports[0] as Record<string, any>;
  Object.assign(report, {
    mode: captureMode,
    status: captureMode === 'formal' ? 'FORMAL_CAPTURED' : 'DEVELOPMENT_VERIFIED',
    formal_record: captureMode === 'formal',
    coverage_tier: captureMode === 'formal' ? 'formal-with-waiver' : 'provisional',
    reproduction_key_sha256: raw.reproduction_key_sha256,
  });
  Object.assign(report.pin_gate, {
    pinSchemaVersion: 3,
    ancestryProof: {
      requiredAncestor: 'a'.repeat(40),
      verifiedGitlink: 'a'.repeat(40),
      verification: 'git-merge-base-is-ancestor',
    },
    expectedBunVersion: Bun.version,
    bunVersionMatches: true,
    scannerInputFingerprintMatches: true,
    scannerConfigurationFingerprintMatches: true,
    reasonCodes: [],
  });
  return raw.reproduction_key_sha256 as string;
}

function bindManifestToFormalReport(claim: Record<string, any>, data: R6CalculatorData, key: string): void {
  const report = data.snapshotReports[0] as Record<string, any>;
  claim.reproduction_key_sha256 = key;
  claim.formal_capture = {
    child_stderr_sha256: report.child_processes.map((child: Record<string, unknown>) => ({
      index: child.index,
      sha256: child.stderr_sha256,
    })),
  };
}

describe('R6 six counterexample acceptance guards', () => {
  it('① raw catalog presence without a final wire is not coverage', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.manifests = [manifest('role.create')];
    (data.profile as { tool_accounting: Record<string, unknown> }).tool_accounting = {};
    refreshProfileApproval(data);
    const result = await calculateR6Coverage(data);
    expect(status(result, 'role.create')).toBe('unmigrated');
    expect(result.numerator).toBe(0);
  });

  it('② a missing test or a direct-call residual is not migrated', async () => {
    const missingTest = fixture([['role.create', 'verified']]);
    const missingTestManifest = manifest('role.create');
    (missingTestManifest.mapping as { tests: Array<{ test_id: string; proves_effect_ids: string[] }> }).tests = [{
      test_id: 'tests/missing.test.ts#never existed',
      proves_effect_ids: ['role.create'],
    }];
    missingTest.manifests = [missingTestManifest];
    expect(status(await calculateR6Coverage(missingTest), 'role.create')).toBe('unmigrated');

    const residual = fixture([['role.create', 'verified']]);
    residual.manifests = [manifest('role.create')];
    (residual.edges[0] as { via: string[] }).via = ['endpoint:POST /api/tools/call'];
    expect(status(await calculateR6Coverage(residual), 'role.create')).toBe('unmigrated');
  });

  it('③ a conflicting wire is not callable and is not migrated', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.manifests = [manifest('role.create')];
    (data.profile as { tool_accounting: Record<string, unknown> }).tool_accounting[wireName('role.create')] = {
      mapped_effects: ['role.create', 'game.create'],
    };
    refreshProfileApproval(data);
    const result = await calculateR6Coverage(data);
    expect(status(result, 'role.create')).toBe('unmigrated');
    expect(result.numerator).toBe(0);
  });

  it('④ a missing manifest field makes the calculator fail closed', async () => {
    const data = fixture([['role.create', 'verified']]);
    const incomplete = manifest('role.create');
    delete incomplete.verification_level;
    data.manifests = [incomplete];
    await expect(calculateR6Coverage(data)).rejects.toThrow();
  });

  it('⑤ declared or verified equivalence alone never enters the main numerator', async () => {
    const result = await calculateR6Coverage(fixture(OVERLAP_EFFECTS));
    expect(result.equivalence).toEqual({ verified: 0, declared: 6, none: 0 });
    expect(result.migrated_effect_ids).toEqual([]);
    expect(result.numerator).toBe(0);
  });

  it('⑥ a hand-written ledger status=migrated is rejected instead of trusted', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.manifests = [manifest('role.create')];
    (data.ledgerRows[0] as { status: string }).status = 'migrated';
    await expect(calculateR6Coverage(data)).rejects.toThrow(/migrated|status/);
  });

  it('downgrades stale verified equivalence when the current manifest test fails', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.manifests = [manifest('role.create')];
    data.runTest = async () => ({ ok: false, output: 'fixture failure' });
    const result = await calculateR6Coverage(data);
    expect(result.equivalence).toEqual({ verified: 0, declared: 1, none: 0 });
    expect(result.equivalence_all_effects).toEqual({ verified: 0, declared: 1, none: 0 });
    expect(result.evaluations[0]?.agent_equiv).toBe('declared');
    expect(result.evaluations[0]?.reasons.join('\n')).toContain('stale-evidence');
  });
});

describe('R6 final-audit fail-closed guards', () => {
  it('rejects a development report relabeled as formal with a content-binding reason', async () => {
    const data = fixture([['role.create', 'verified']]);
    const developmentKey = promoteFixtureSnapshotV2(data, 'development');
    const claim = manifest('role.create');
    bindManifestToFormalReport(claim, data, developmentKey);
    data.manifests = [claim];
    Object.assign(data.snapshotReports[0] as Record<string, unknown>, {
      mode: 'formal',
      status: 'FORMAL_CAPTURED',
      formal_record: true,
      coverage_tier: 'formal-with-waiver',
    });
    data.inventoryProductCombo = {
      studio: 'f'.repeat(40),
      orchestrator: 'a'.repeat(40),
    };
    const result = await calculateR6Coverage(data);
    expect(result.numerator).toBe(0);
    expect(result.evaluations[0]?.reasons).toContain('formal-mode-content-binding-mismatch');
  });

  it('rejects formal stderr summaries that disagree with the evidence manifest', async () => {
    const data = fixture([['role.create', 'verified']]);
    const key = promoteFixtureSnapshotV2(data);
    const claim = manifest('role.create');
    bindManifestToFormalReport(claim, data, key);
    (claim.formal_capture as { child_stderr_sha256: Array<{ sha256: string }> })
      .child_stderr_sha256[1]!.sha256 = 'f'.repeat(64);
    data.manifests = [claim];
    data.inventoryProductCombo = { studio: 'f'.repeat(40), orchestrator: 'a'.repeat(40) };
    const result = await calculateR6Coverage(data);
    expect(result.numerator).toBe(0);
    expect(result.evaluations[0]?.reasons).toContain('formal-stderr-summary-mismatch');
  });

  it('downgrades a Bun version mismatch without aborting calculation', async () => {
    const data = fixture([['role.create', 'verified']]);
    const key = promoteFixtureSnapshotV2(data);
    const claim = manifest('role.create');
    bindManifestToFormalReport(claim, data, key);
    data.manifests = [claim];
    (data.effectRows[0] as Record<string, unknown>).verification_evidence_manifest_id = claim.manifest_id;
    data.inventoryProductCombo = { studio: 'f'.repeat(40), orchestrator: 'a'.repeat(40) };
    const report = data.snapshotReports[0] as Record<string, any>;
    report.coverage_tier = 'provisional';
    report.pin_gate.bunVersionMatches = false;
    report.pin_gate.reasonCodes = ['formal-bun-version-mismatch'];
    const result = await calculateR6Coverage(data);
    expect(result.numerator).toBe(0);
    expect(result.coverage_tier).toBe('provisional');
    expect(result.evaluations[0]?.reasons).toContain('formal-bun-version-mismatch');
  });

  it('downgrades a product fingerprint mismatch without aborting calculation', async () => {
    const data = fixture([['role.create', 'verified']]);
    const key = promoteFixtureSnapshotV2(data);
    const claim = manifest('role.create');
    bindManifestToFormalReport(claim, data, key);
    data.manifests = [claim];
    data.inventoryProductCombo = { studio: 'f'.repeat(40), orchestrator: 'a'.repeat(40) };
    const report = data.snapshotReports[0] as Record<string, any>;
    report.coverage_tier = 'provisional';
    report.pin_gate.scannerInputFingerprintMatches = false;
    report.pin_gate.reasonCodes = ['formal-scanner-input-fingerprint-mismatch'];
    const result = await calculateR6Coverage(data);
    expect(result.numerator).toBe(0);
    expect(result.coverage_tier).toBe('provisional');
    expect(result.evaluations[0]?.reasons).toContain('formal-scanner-input-fingerprint-mismatch');
  });

  it('rejects a current inventory with no recursive product combo', async () => {
    const data = fixture([['role.create', 'verified']]);
    promoteFixtureSnapshotV2(data);
    delete data.inventoryProductCombo;
    await expect(calculateR6Coverage(data)).rejects.toThrow(/requires a recursive product combo/);
  });

  it('rejects v2 artifacts relabeled with every JSON v1 spelling and keeps the numerator unchanged', async () => {
    for (const version of [1, 1.0, '1']) {
      const data = fixture([['role.create', 'verified']]);
      const key = promoteFixtureSnapshotV2(data);
      const claim = manifest('role.create');
      bindManifestToFormalReport(claim, data, key);
      data.manifests = [claim];
      data.inventoryProductCombo = { studio: 'f'.repeat(40), orchestrator: 'a'.repeat(40) };
      const relabeledSnapshot = structuredClone(FIXTURE_SNAPSHOT) as Record<string, unknown>;
      relabeledSnapshot.schema_version = version;
      replaceRawSnapshot(data, relabeledSnapshot);
      (data.snapshotReports[0] as Record<string, unknown>).schema_version = version;

      const result = await calculateR6Coverage(data);
      expect(result.numerator, String(version)).toBe(0);
      expect(result.migrated_effect_ids, String(version)).toEqual([]);
      expect(result.evaluations[0]?.reasons.length, String(version)).toBeGreaterThan(0);
      expect(result.runtime_snapshot_diagnostics[0]?.status, String(version)).toBe('rejected-current-schema');
    }
  });

  it('treats an exact frozen historical report as diagnostic-only with zero migration contribution', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.snapshotReports = [{ path: 'frozen-history/main.formal.v1.report.json', rawText: FROZEN_HISTORY_REPORT }];
    data.manifests = [manifest('role.create')];
    const result = await calculateR6Coverage(data);
    expect(result.numerator).toBe(0);
    expect(result.migrated_effect_ids).toEqual([]);
    expect(result.runtime_snapshot_diagnostics).toMatchObject([{
      status: 'frozen-historical-diagnostic',
      contribution: { numerator: 0, migrated_effect_ids: [] },
    }]);
  });

  it('rejects a one-byte rewrite of a frozen historical report', async () => {
    const data = fixture([['role.create', 'verified']]);
    const rawText = FROZEN_HISTORY_REPORT.replace('"schema_version": 1,', '"schema_version": 1 ,');
    data.snapshotReports = [{ path: 'frozen-history/rewritten.json', rawText }];
    const result = await calculateR6Coverage(data);
    expect(result.runtime_snapshot_diagnostics[0]?.status).toBe('rejected-current-schema');
    expect(result.numerator).toBe(0);
  });

  it('does not count development-only evidence in the formal numerator', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.manifests = [manifest('role.create')];
    Object.assign(data.snapshotReports[0] as Record<string, unknown>, {
      mode: 'development',
      status: 'DEVELOPMENT_VERIFIED',
      formal_record: false,
      coverage_tier: 'provisional',
    });
    const result = await calculateR6Coverage(data);
    expect(result.numerator).toBe(0);
    expect(result.coverage_tier).toBe('provisional');
  });

  it('does not count a formal capture whose required pin has not arrived', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.manifests = [manifest('role.create')];
    Object.assign(data.snapshotReports[0] as Record<string, unknown>, {
      mode: 'formal',
      status: 'FORMAL_CAPTURED',
      formal_record: true,
      coverage_tier: 'formal-with-waiver',
    });
    ((data.snapshotReports[0] as Record<string, unknown>).pin_gate as Record<string, unknown>).arrived = false;
    const result = await calculateR6Coverage(data);
    expect(result.numerator).toBe(0);
  });

  it('rejects an unrelated passing test even when the manifest self-claims the effect', async () => {
    const data = fixture([['role.create', 'verified']]);
    const claim = manifest('role.create');
    (claim.mapping as { tests: Array<{ test_id: string; proves_effect_ids: string[] }> }).tests = [{
      test_id: 'tests/role.test.ts#unrelated arithmetic works',
      proves_effect_ids: ['role.create'],
    }];
    data.manifests = [claim];
    const previousSourceText = data.sourceText;
    data.sourceText = (path) => path === 'tests/role.test.ts'
      ? "test('unrelated arithmetic works', () => { expect(1 + 1).toBe(2); });"
      : previousSourceText(path);
    const result = await calculateR6Coverage(data);
    expect(status(result, 'role.create')).toBe('unmigrated');
    expect(result.evaluations[0]?.reasons.join('\n')).toContain('test-binding-registry-mismatch');
  });

  it('derives verified equivalence only from a complete current evidence chain', async () => {
    const cases: Array<{ name: string; mutate: (data: R6CalculatorData) => void }> = [
      { name: 'missing manifest', mutate: () => {} },
      {
        name: 'manifest id mismatch',
        mutate: (data) => {
          data.manifests = [manifest('role.create')];
          (data.effectRows[0] as Record<string, unknown>).verification_evidence_manifest_id = 'wrong-manifest';
        },
      },
      {
        name: 'qualifies false',
        mutate: (data) => {
          const claim = manifest('role.create');
          claim.qualifies_for_verified_equivalence = false;
          data.manifests = [claim];
        },
      },
      {
        name: 'external unverified',
        mutate: (data) => {
          const claim = manifest('role.create');
          claim.qualifies_for_verified_equivalence = false;
          claim.verification_level = 'external-unverified';
          data.manifests = [claim];
        },
      },
      {
        name: 'unresolved test',
        mutate: (data) => {
          const claim = manifest('role.create');
          (claim.mapping as { tests: Array<{ test_id: string; proves_effect_ids: string[] }> }).tests = [{
            test_id: 'tests/missing.test.ts#missing test',
            proves_effect_ids: ['role.create'],
          }];
          data.manifests = [claim];
        },
      },
    ];
    for (const item of cases) {
      const data = fixture([['role.create', 'verified']]);
      item.mutate(data);
      const result = await calculateR6Coverage(data);
      expect(result.evaluations[0]?.agent_equiv, item.name).toBe('declared');
    }
  });

  it('rejects the hollow snapshot shape that the runner cannot produce', async () => {
    const data = fixture([['role.create', 'verified']]);
    const hollow = structuredClone(FIXTURE_SNAPSHOT) as Record<string, unknown>;
    delete hollow.tool_accounting;
    replaceRawSnapshot(data, hollow);
    await expect(calculateR6Coverage(data)).rejects.toThrow(
      /final_tools|tool_accounting|extension_diagnostics/,
    );
  });

  it('rejects discovery snapshots and kernel selections that the verified profile did not request', async () => {
    const discovery = fixture([['role.create', 'verified']]);
    const discoverySnapshot = structuredClone(FIXTURE_SNAPSHOT) as Record<string, unknown>;
    discoverySnapshot.capture_mode = 'discover';
    replaceRawSnapshot(discovery, discoverySnapshot);
    await expect(calculateR6Coverage(discovery)).rejects.toThrow(/capture_mode|verify/);

    const wrongKernel = fixture([['role.create', 'verified']]);
    const wrongKernelSnapshot = structuredClone(FIXTURE_SNAPSHOT) as Record<string, unknown>;
    wrongKernelSnapshot.kernel_selection = {
      requested_provider_id: 'claude-code',
      resolved_provider_id: 'claude-code',
    };
    replaceRawSnapshot(wrongKernel, wrongKernelSnapshot);
    await expect(calculateR6Coverage(wrongKernel)).rejects.toThrow(/kernel selection chain mismatch/);
  });

  it('marks a pending baseline as a draft machine result', async () => {
    const data = fixture([['role.create', 'verified']]);
    data.baselineApproval = {
      ...FIXTURE_BASELINE_APPROVAL,
      status: 'pending',
      decision_evidence: null,
      decision_evidence_sha256: null,
      approved_content_commit: null,
      approval_manifest_raw_sha256: null,
      approval_scope_sha256: null,
      approval_package_raw_sha256: null,
    };
    Object.assign(data.snapshotReports[0] as Record<string, unknown>, {
      coverage_tier: 'provisional',
      baseline_approval: data.baselineApproval,
    });
    const result = await calculateR6Coverage(data);
    expect((result as unknown as Record<string, unknown>).baseline_approval).toBe('pending');
    expect((result as unknown as Record<string, unknown>).result_status).toBe('draft');
  });

  it('makes diagnostic governance readable and prevents a final formal conclusion', async () => {
    const data = fixture([['role.create', 'verified']]);
    const key = promoteFixtureSnapshotV2(data);
    const claim = manifest('role.create');
    bindManifestToFormalReport(claim, data, key);
    data.manifests = [claim];
    (data.effectRows[0] as Record<string, unknown>).verification_evidence_manifest_id = claim.manifest_id;
    data.inventoryProductCombo = { studio: 'f'.repeat(40), orchestrator: 'a'.repeat(40) };
    data.baselineApproval = {
      ...FIXTURE_BASELINE_APPROVAL,
      governance_verification: {
        status: 'unverified-diagnostic',
        path: 'governance.json',
        reasons: ['worktree-path-is-dirty-or-untracked'],
        committed_sha: null,
      },
    };
    const report = data.snapshotReports[0] as Record<string, any>;
    report.baseline_approval = {
      ...report.baseline_approval,
      status: 'unverified-diagnostic',
    };
    report.coverage_tier = 'provisional';
    const result = await calculateR6Coverage(data);
    expect(result.baseline_approval).toBe('unverified-diagnostic');
    expect(result.result_status).toBe('draft');
    expect(result.coverage_tier).toBe('provisional');
    expect(result.evaluations[0]?.reasons).toEqual([]);
    expect(result.numerator).toBe(1);
    expect(result.governance_reason_codes).toEqual(['baseline-governance-unverified']);
  });

  it('rejects a rewritten approval evidence SHA in the report chain', async () => {
    const data = fixture([['role.create', 'verified']]);
    const report = data.snapshotReports[0] as Record<string, any>;
    report.baseline_approval = {
      ...report.baseline_approval,
      decision_evidence_sha256: 'f'.repeat(64),
    };
    await expect(calculateR6Coverage(data)).rejects.toThrow(/baseline approval chain mismatch/);
  });

  it('rejects a plugin manifest whose live bytes no longer match the snapshot', async () => {
    const data = fixture([['role.create', 'verified']]);
    const previousSourceText = data.sourceText;
    data.sourceText = (path) => path === FIXTURE_PLUGIN_PATH
      ? `${FIXTURE_PLUGIN_TEXT} `
      : previousSourceText(path);
    await expect(calculateR6Coverage(data)).rejects.toThrow(/plugin manifest content SHA mismatch/);
  });

  it('runs an existing passing test but rejects it when the claim does not prove the effect', async () => {
    const data = fixture([['role.create', 'verified']]);
    const claim = manifest('role.create');
    (claim.mapping as { tests: Array<{ test_id: string; proves_effect_ids: string[] }> }).tests = [{
      test_id: 'tests/role.test.ts#unrelated arithmetic works',
      proves_effect_ids: ['unrelated.effect'],
    }];
    data.manifests = [claim];
    const previousSourceText = data.sourceText;
    data.sourceText = (path) => path === 'src/role.ts'
      ? "registerAction({ id: 'role.create' });"
      : path === 'tests/role.test.ts'
        ? "test('unrelated arithmetic works', () => { expect(1 + 1).toBe(2); });"
        : previousSourceText(path);
    const result = await calculateR6Coverage(data);
    expect(status(result, 'role.create')).toBe('unmigrated');
    expect(result.test_runs).toMatchObject([{ ok: true }]);
    expect(result.evaluations[0]?.reasons.join('\n')).toContain('test-does-not-prove-effect');
  });

  it('rejects a well-formed but forged reproduction hash with an explicit reason', async () => {
    const data = fixture([['role.create', 'verified']]);
    const claim = manifest('role.create');
    claim.reproduction_key_sha256 = 'f'.repeat(64);
    data.manifests = [claim];
    const result = await calculateR6Coverage(data);
    expect(status(result, 'role.create')).toBe('unmigrated');
    expect(result.evaluations[0]?.reasons).toContain('reproduction-key-sha256-mismatch');
  });

  it('rejects a double-sided forged reproduction key in both report and manifest', async () => {
    const data = fixture([['role.create', 'verified']]);
    attachRawSnapshot(data);
    const claim = manifest('role.create');
    claim.reproduction_key_sha256 = 'f'.repeat(64);
    (data.snapshotReports[0] as Record<string, unknown>).reproduction_key_sha256 = 'f'.repeat(64);
    data.manifests = [claim];
    await expect(calculateR6Coverage(data)).rejects.toThrow(/reproduction.*canonical|reproduction.*snapshot/i);
  });

  it('rejects changed snapshot bytes while the report remains unchanged', async () => {
    const data = fixture([['role.create', 'verified']]);
    const attached = attachRawSnapshot(data);
    const previousSourceText = data.sourceText;
    data.sourceText = (path) => path === attached.path
      ? `${previousSourceText(path)?.trimEnd()} `
      : previousSourceText(path);
    await expect(calculateR6Coverage(data)).rejects.toThrow(/snapshot.*sha|canonical.*bytes/i);
  });

  it('rejects a report that points to a nonexistent raw snapshot entity', async () => {
    const data = fixture([['role.create', 'verified']]);
    attachRawSnapshot(data);
    (data.snapshotReports[0] as Record<string, unknown>).snapshot_path = 'scripts/ai-native/runtime-snapshots/missing.json';
    await expect(calculateR6Coverage(data)).rejects.toThrow(/snapshot.*missing|missing.*snapshot/i);
  });

  it('marks missing and proposed runtime captures unmigrated', async () => {
    const missing = fixture([['role.create', 'verified']]);
    missing.manifests = [manifest('role.create')];
    missing.snapshotReports = [];
    const missingResult = await calculateR6Coverage(missing);
    expect(missingResult.evaluations[0]?.reasons).toContain('runtime-snapshot-report-missing');

    const proposed = fixture([['role.create', 'verified']]);
    proposed.manifests = [manifest('role.create')];
    (proposed.snapshotReports[0] as { status: string }).status = 'PROPOSED';
    const proposedResult = await calculateR6Coverage(proposed);
    expect(proposedResult.evaluations[0]?.reasons).toContain('runtime-snapshot-report-proposed');
  });

  it('requires every inventory and rejects empty, conflicting, duplicate, and orphan rows', async () => {
    const emptyLedger = fixture([['role.create', 'verified']]);
    emptyLedger.ledgerRows = [];
    await expect(calculateR6Coverage(emptyLedger)).rejects.toThrow(/ledgerRows.*must not be empty/);

    const missingEffects = fixture([['role.create', 'verified']]);
    delete (missingEffects as unknown as Record<string, unknown>).baselineEffects;
    await expect(calculateR6Coverage(missingEffects)).rejects.toThrow(/baselineEffects.*missing/);

    const conflicting = fixture([['role.create', 'verified']]);
    (conflicting.ledgerRows[0] as { effect_id: string }).effect_id = 'different.effect';
    await expect(calculateR6Coverage(conflicting)).rejects.toThrow(/not a reached edge/);

    const duplicateControls = fixture([['role.create', 'verified']]);
    duplicateControls.controls.push(structuredClone(duplicateControls.controls[0]));
    await expect(calculateR6Coverage(duplicateControls)).rejects.toThrow(/controls:2: duplicate key/);

    const duplicateEffects = fixture([['role.create', 'verified']]);
    duplicateEffects.effectRows.push(structuredClone(duplicateEffects.effectRows[0]));
    await expect(calculateR6Coverage(duplicateEffects)).rejects.toThrow(/effectRows:2: duplicate key/);

    const duplicateEdges = fixture([['role.create', 'verified']]);
    duplicateEdges.edges.push(structuredClone(duplicateEdges.edges[0]));
    await expect(calculateR6Coverage(duplicateEdges)).rejects.toThrow(/edges:2: duplicate key/);

    const orphan = fixture([['role.create', 'verified']]);
    (orphan.edges[0] as { effect_id: string }).effect_id = 'missing.effect';
    await expect(calculateR6Coverage(orphan)).rejects.toThrow(/orphan effect_id/);
  });

  it('rejects a manual-pool disposition that disagrees with its formal effect adjudication', async () => {
    const data = fixture([['role.create', 'none'], ['role.list', 'none']]);
    const control = data.controls[0] as { effect_id: string | null; propagation: string; control_id: string };
    control.effect_id = null;
    control.propagation = 'manual-pool';
    data.edges = data.edges.filter((edge) => (
      (edge as { control_id: string }).control_id !== control.control_id
    ));
    (data.ledgerRows[0] as { disposition: string }).disposition = 'read';
    data.manualPoolAdjudications = [{
      schema_version: 1,
      baseline_id: data.baselineId,
      manual_id: 1,
      pool_manual_id: 'manual_fixture_role_create',
      kind: 'control',
      control_id: control.control_id,
      effect_id: 'role.create',
      disposition: 'read',
      certainty: 'adjudicated',
      evidence: 'src/role.ts:1 — fixture manual adjudication',
      carry_forward: 'incremental-adjudication',
    }];
    await expect(calculateR6Coverage(data)).rejects.toThrow(/disagrees with formal effect role\.create/);
  });

  it('rejects a callable/read manual-pool capability without a formal effect entity', async () => {
    const data = fixture([['role.create', 'none'], ['role.list', 'none']]);
    const control = data.controls[0] as { effect_id: string | null; propagation: string; control_id: string };
    control.effect_id = null;
    control.propagation = 'manual-pool';
    data.edges = data.edges.filter((edge) => (
      (edge as { control_id: string }).control_id !== control.control_id
    ));
    Object.assign(data.ledgerRows[0]!, {
      effect_id: 'manual.missing_formal_entity',
      disposition: 'tool',
    });
    data.manualPoolAdjudications = [{
      schema_version: 1,
      baseline_id: data.baselineId,
      manual_id: 1,
      pool_manual_id: 'manual_fixture_missing_formal_entity',
      kind: 'control',
      control_id: control.control_id,
      effect_id: 'manual.missing_formal_entity',
      disposition: 'tool',
      certainty: 'adjudicated',
      evidence: 'src/role.ts:1 — fixture manual adjudication',
      carry_forward: 'incremental-adjudication',
    }];
    await expect(calculateR6Coverage(data)).rejects.toThrow(
      /callable\/read manual-pool effect lacks a formal effect entity: manual\.missing_formal_entity/,
    );
  });

  it('rejects illegal disposition, wrong baseline, and unknown fields with file/line/field context', async () => {
    const illegal = fixture([['role.create', 'verified']]);
    illegal.inputSources = { effectRows: 'fixtures/effects.jsonl' };
    (illegal.effectRows[0] as { disposition: string }).disposition = 'toool';
    await expect(calculateR6Coverage(illegal)).rejects.toThrow(/fixtures\/effects\.jsonl:1: disposition:/);

    const wrongBaseline = fixture([['role.create', 'verified']]);
    (wrongBaseline.effectRows[0] as { baseline_id: string }).baseline_id = 'b9-2099-01-01-9.9.9';
    await expect(calculateR6Coverage(wrongBaseline)).rejects.toThrow(/baseline_id=.*does not match/);

    const passthrough = fixture([['role.create', 'verified']]);
    (passthrough.controls[0] as Record<string, unknown>).unexpected = true;
    await expect(calculateR6Coverage(passthrough)).rejects.toThrow(/controls:1: <row>: Unrecognized key/);
  });

  it('validates tool and headless equivalents and rejects UI-only action reachability', async () => {
    const tool = fixture([['role.create', 'verified']]);
    const toolClaim = manifest('role.create');
    toolClaim.equivalent = { kind: 'tool', id: 'unrelated_tool' };
    (toolClaim.mapping as { handler_ids: string[] }).handler_ids = ['unrelated_tool'];
    tool.manifests = [toolClaim];
    const toolResult = await calculateR6Coverage(tool);
    expect(status(toolResult, 'role.create')).toBe('unmigrated');
    expect(toolResult.evaluations[0]?.reasons.join('\n')).toContain('tool-equivalent-wire-mismatch');

    const headless = fixture([['role.create', 'verified']]);
    const headlessClaim = manifest('role.create');
    headlessClaim.equivalent = { kind: 'headless', id: 'missing-handler' };
    (headlessClaim.mapping as { handler_ids: string[] }).handler_ids = ['missing-handler'];
    headless.manifests = [headlessClaim];
    const headlessResult = await calculateR6Coverage(headless);
    expect(status(headlessResult, 'role.create')).toBe('unmigrated');
    expect(headlessResult.evaluations[0]?.reasons).toContain('headless-handler-not-unique-or-missing');

    const uiOnly = fixture([['role.create', 'verified']]);
    uiOnly.manifests = [manifest('role.create')];
    uiOnly.catalogEntries[0]!.surface = 'ui';
    uiOnly.handlerIds = [];
    const uiOnlyResult = await calculateR6Coverage(uiOnly);
    expect(status(uiOnlyResult, 'role.create')).toBe('unmigrated');
    expect(uiOnlyResult.evaluations[0]?.reasons).toContain('action-equivalent-not-headless-reachable');
  });
});

describe('FR7 production integrity entrypoints', () => {
  it('rejects rewritten evidence manifest bytes against the pinned set hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-manifest-pin-'));
    try {
      cpSync(resolve(import.meta.dir, 'evidence-manifests-v1'), join(root, 'scripts/ai-native/evidence-manifests-v1'), { recursive: true });
      const pinPath = join(root, RUNTIME_PIN_PATH);
      mkdirSync(dirname(pinPath), { recursive: true });
      cpSync(resolve(import.meta.dir, '../../docs/ai-native/pins/m2-2026-07-23.json'), pinPath);
      const target = join(root, 'scripts/ai-native/evidence-manifests-v1/role.create.json');
      writeFileSync(target, `${readFileSync(target, 'utf8').trimEnd()} `);
      expect(() => assertPinnedEvidenceManifestSet(root, RUNTIME_PIN_PATH)).toThrow(/pinned evidence manifest set SHA-256 mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('real repository calculator entry rejects a registry-known terminal profile reverted to pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-terminal-calculator-'));
    try {
      const profilePath = join(root, 'scripts/ai-native/profiles/main.json');
      const scannerConfigPath = join(root, 'scripts/ai-native/scanner-config.json');
      const registryPath = join(root, 'docs/ai-native/baseline/runtime-profile-terminals.json');
      const pinPath = join(root, RUNTIME_PIN_PATH);
      mkdirSync(dirname(profilePath), { recursive: true });
      mkdirSync(dirname(registryPath), { recursive: true });
      writeFileSync(profilePath, FIXTURE_PROFILE_TEXT);
      cpSync(resolve(import.meta.dir, 'scanner-config.json'), scannerConfigPath);
      const recordPayload = {
        sequence: 1,
        profile_id: 'main',
        ratified_profile_payload_sha256: '1'.repeat(64),
        terminal_profile_sha256: '2'.repeat(64),
        previous_record_sha256: '0'.repeat(64),
      };
      const registryText = `${JSON.stringify({
        schema_version: 1,
        hash_algorithm: 'sha256-canonical-record-chain-v1',
      })}\n${JSON.stringify({ ...recordPayload, record_sha256: canonicalSha256(recordPayload) })}\n`;
      writeFileSync(registryPath, registryText);
      const pin = JSON.parse(readFileSync(resolve(import.meta.dir, '../../docs/ai-native/pins/m2-2026-07-23.json'), 'utf8'));
      pin.governance_artifacts.runtime_profile_terminals.sha256 = sha256(registryText);
      mkdirSync(dirname(pinPath), { recursive: true });
      writeFileSync(pinPath, stablePrettyJson(pin));
      await expect(calculateRepositoryR6Coverage(root, {
        catalogEntries: [],
        handlerIds: [],
        runTest: async () => ({ ok: true, output: 'not reached' }),
      })).rejects.toThrow(/terminal profile main cannot leave ratified state/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('R6 checked-in repository calculation', () => {
  it('derives role.create and role.list without trusting ledger status', async () => {
    buildActionCatalog();
    const result = await calculateRepositoryR6Coverage(resolve(import.meta.dir, '../..'), {
      catalogEntries: catalogAll(),
      handlerIds: [...listBuiltinHeadlessUiActionIds()],
      runTest: async () => ({ ok: true, output: '1 pass (repository contract fixture)' }),
    });
    const checked = JSON.parse(readFileSync(resolve(import.meta.dir, 'r6-coverage.json'), 'utf8')) as {
      baseline_approval: string;
      result_status: string;
      coverage_tier: string;
      denominator: number;
      equivalence_all_effects: { verified: number; declared: number; none: number };
    };
    expect(result.denominator).toBe(checked.denominator);
    expect(result).toMatchObject({
      baseline_approval: checked.baseline_approval,
      result_status: checked.result_status,
      coverage_tier: checked.coverage_tier,
    });
    expect(result.migrated_effect_ids).toEqual(['role.create', 'role.list']);
    expect(result.migrated_control_ids).toEqual([
      'ctl_24c8ca19a22faec60dd04eb2',
      'ctl_6121eb75db55845a85fabc07',
    ]);
    expect(result.domains.find((row) => row.domain === 'role')).toMatchObject({
      migrated: 2,
      denominator: 3,
    });
    expect(result.equivalence_all_effects).toEqual(checked.equivalence_all_effects);
  });
});
