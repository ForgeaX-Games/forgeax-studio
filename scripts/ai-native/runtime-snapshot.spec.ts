import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  accountFinalTools,
  assertNoPluginWireCollisions,
  canonicalSha256,
  formalEligibility,
  normalizeDynamicValues,
  parseRuntimeSnapshotProfile,
  runtimeProfileApprovalSha256,
  sha256,
  stablePrettyJson,
  validateRuntimeProfileTransition,
  validateRuntimeProfileState,
  type RuntimeSnapshotProfile,
  type RuntimeToolSources,
} from './runtime-snapshot-core.ts';
import {
  assertByteIdentical,
  assertCaptureEligibility,
  captureModeFromTraversedGuard,
  evaluateImmutablePinGate,
  evaluatePinGate,
  normalizeChildSummary,
  parseRuntimeSnapshotRunnerArgs,
  runRuntimeSnapshot,
  sealRuntimeSnapshot,
} from './runtime-snapshot-runner.ts';
import { runtimeSnapshotLayerForOrigin } from './runtime-snapshot-worker.ts';
import {
  assertAncestorPrefixPolicy,
  loadValidatedRuntimeProfile,
  parseRuntimeProfileTerminalRegistry,
  validateRuntimeProfileAgainstTerminalRegistry,
} from './runtime-profile-terminal-registry.ts';
import { RUNTIME_PIN_PATH } from './runtime-artifact-integrity.ts';
import { writeRuntimePinArtifacts } from './build-runtime-pin.ts';

function profile(overrides: Partial<RuntimeSnapshotProfile> = {}): RuntimeSnapshotProfile {
  return {
    schema_version: 1,
    profile_id: 'main',
    status: 'proposed',
    description: 'test profile',
    agent: {
      id: 'forge',
      expected_trust_tier: 'own',
      expected_source: 'forge',
      expected_host_tool_allow: ['team:*'],
      expected_host_tool_deny: [],
    },
    kernel: { provider_id: 'forgeax-core' },
    fixture: {
      game_slug: 'runtime-snapshot',
      session_alias: 'runtime-snapshot-session',
      thread_id: 'runtime-snapshot-thread',
      call_id: 'runtime-snapshot-call',
      message: 'Inspect tools only.',
    },
    ui_state: { lease: 'absent', runtime_manifest: 'absent' },
    plugin_policy: { safe_boot: true, layers: ['L0'] },
    product_shell: {
      host_tools: 'studioHostTools',
      system_prompt_composer: 'GameSystemPromptComposer',
    },
    formal_gate: {
      required_orchestrator_ancestor: '319bc37d5e60a72f660c048f8cc7a381c5fe4037',
    },
    tool_accounting: {},
    ...overrides,
  };
}

function approvalRecord(profilePayload: RuntimeSnapshotProfile) {
  return {
    approver: 'supervisory-lane(orchestration)' as const,
    date: '2026-07-24',
    profile_sha256: runtimeProfileApprovalSha256(profilePayload),
    channel: 'orchestration session 2026-07-23' as const,
    pending_user_ratification: true as const,
  };
}

function withRatificationEvidence<T>(
  run: (fixture: { repoRoot: string; evidencePath: string; evidenceSha256: string }) => T,
): T {
  const repoRoot = mkdtempSync(join(tmpdir(), 'forgeax-ratification-evidence-'));
  const evidencePath = 'docs/ai-native/evidence/runtime-profile-ratification-fixture.md';
  const evidenceTarget = resolve(repoRoot, evidencePath);
  const evidenceBytes = 'synthetic runtime-profile ratification evidence\n';
  try {
    mkdirSync(resolve(repoRoot, 'docs/ai-native/evidence'), { recursive: true });
    writeFileSync(evidenceTarget, evidenceBytes);
    return run({ repoRoot, evidencePath, evidenceSha256: sha256(evidenceBytes) });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const sources: RuntimeToolSources = {
  builtin: new Set(['memory_search']),
  productShell: new Set(['list_games']),
  catalogFirstClass: new Map([['ui_act_role_list', 'role.list']]),
  plugin: new Set(['team_list']),
  soulPack: new Set(['soul_tool']),
  skill: new Set(['skill_design']),
};

const WB_GAME_VIDEO_MANIFEST_ORIGIN =
  'packages/marketplace/extensions/wb-game-video/forgeax-extension.json';
const WB_GAME_VIDEO_LEGACY_TOOL_IDS = [
  'gvid:get-graph',
  'gvid:list-videos',
  'gvid:save-graph',
  'gen:generate-keyframe',
  'gen:generate-node-video',
  'gen:generate-shot-script',
  'gen:generate-video',
  'gen:get-asset',
  'gen:import-character-refs',
  'gen:import-scene-refs',
  'gen:list-assets',
] as const;

describe('runtime snapshot profile', () => {
  test('runtime-pin evidence failure never leaves a half-written anchor', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-pin-write-'));
    try {
      const pinPath = join(root, 'docs/ai-native/pins/pin.json');
      mkdirSync(join(root, 'docs/ai-native/pins'), { recursive: true });
      writeFileSync(pinPath, 'original anchor\n');
      writeFileSync(join(root, 'missing'), 'blocks directory creation\n');
      expect(() => writeRuntimePinArtifacts(pinPath, 'replacement anchor\n', {
        path: join(root, 'missing/evidence/product-combo.json'),
        text: 'evidence\n',
      })).toThrow();
      expect(readFileSync(pinPath, 'utf8')).toBe('original anchor\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runtime-pin writer creates missing evidence directories before publishing the anchor', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-pin-directory-'));
    try {
      const pinPath = join(root, 'docs/ai-native/pins/pin.json');
      const evidencePath = join(root, 'docs/ai-native/evidence/product-combo.json');
      expect(() => writeRuntimePinArtifacts(pinPath, 'complete anchor\n', {
        path: evidencePath,
        text: 'complete evidence\n',
      })).not.toThrow();
      expect(readFileSync(pinPath, 'utf8')).toBe('complete anchor\n');
      expect(readFileSync(evidencePath, 'utf8')).toBe('complete evidence\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('accepts the complete profile contract', () => {
    expect(parseRuntimeSnapshotProfile(profile()).profile_id).toBe('main');
  });

  test('CI consumes prefix diagnostics while permitting only the empty pending genesis', () => {
    const pendingPayload = profile({ status: 'approved' });
    const pending = parseRuntimeSnapshotProfile({
      ...pendingPayload,
      approval_record: approvalRecord(pendingPayload),
    });
    const empty = parseRuntimeProfileTerminalRegistry({
      schema_version: 1,
      hash_algorithm: 'sha256-canonical-record-chain-v1',
      records: [],
    });
    expect(() => assertAncestorPrefixPolicy(pending, empty, {
      status: 'unverified-diagnostic',
      ancestor: 'a'.repeat(40),
      reasons: ['no-ancestor-copy-genesis'],
    }, true)).not.toThrow();
    expect(() => assertAncestorPrefixPolicy(pending, empty, {
      status: 'unverified-diagnostic',
      ancestor: null,
      reasons: ['no-git-ancestor'],
    }, true)).toThrow(/not verified in CI/);
  });

  test('rejects an invalid formal gate and ambiguous accounting', () => {
    expect(() => parseRuntimeSnapshotProfile(profile({
      formal_gate: { required_orchestrator_ancestor: 'short' },
    }))).toThrow('full orchestrator commit SHA');
    expect(() => parseRuntimeSnapshotProfile(profile({
      tool_accounting: {
        memory_search: {
          mapped_effects: ['effect.one'],
          explicit_out_of_scope_reason: 'foundation-memory',
        },
      },
    }))).toThrow('exactly one disposition');
  });

  test('rejects unknown fields recursively, including misspelled allow-list fields', () => {
    const cases: unknown[] = [
      { ...profile(), unexpected_top_level: true },
      profile({ kernel: { provider_id: 'forgeax-core', unexpected_kernel: true } as never }),
      profile({ agent: { ...profile().agent, unexpected_agent: true } as never }),
      profile({
        tool_accounting: {
          memory_search: {
            explicit_out_of_scope_reason: 'foundation-memory',
            unexpected_accounting: true,
          } as never,
        },
      }),
      profile({
        agent: {
          id: 'forge',
          expected_trust_tier: 'own',
          expected_source: 'forge',
          expected_host_tool_alow: ['team:*'],
          expected_host_tool_deny: [],
        } as never,
      }),
    ];
    for (const candidate of cases) {
      expect(() => parseRuntimeSnapshotProfile(candidate)).toThrow(/unrecognized|unknown/i);
    }
  });

  test('keeps the checked-in approved status and description wording aligned', () => {
    const checkedIn = JSON.parse(readFileSync(resolve(import.meta.dir, 'profiles/main.json'), 'utf8')) as {
      status: string;
      description: string;
      approval_record?: ReturnType<typeof approvalRecord>;
    };
    expect(checkedIn.status).toBe('approved');
    expect(checkedIn.description.toLowerCase()).toContain('approved');
    expect(checkedIn.description.toLowerCase()).not.toMatch(/proposed|blocked until approved/);
    expect(checkedIn.approval_record).toMatchObject({
      approver: 'supervisory-lane(orchestration)',
      date: '2026-07-24',
      channel: 'orchestration session 2026-07-23',
      pending_user_ratification: true,
    });
  });

  test('rejects approved profiles without the required approval record', () => {
    expect(() => parseRuntimeSnapshotProfile(profile({ status: 'approved' }))).toThrow(/approval/i);
  });

  test('accepts the named supervisory waiver only on an approved profile', () => {
    const approvalPayload = {
      ...profile({ status: 'approved' }),
      formal_gate: {
        ...profile().formal_gate,
        waiver: {
          waived_blockers: ['extension-kind-issues'],
          waived_instances: ['asset2d:templates.list', 'asset2d:templates.get'],
          max_count: 2,
          reason: 'Third-party plugins expose duplicate tool ids outside this lane.',
          issuer: 'supervisory-lane',
          date: '2026-07-24',
        },
      },
    } as RuntimeSnapshotProfile;
    const approved = {
      ...approvalPayload,
      approval_record: approvalRecord(approvalPayload),
    };
    expect(() => parseRuntimeSnapshotProfile(approved)).not.toThrow();
  });

  test('ratification terminal state is legal only with complete content-addressed evidence', () => {
    withRatificationEvidence(({ repoRoot, evidencePath, evidenceSha256 }) => {
      const approvalPayload = profile({ status: 'approved' });
      const pending = {
        ...approvalPayload,
        approval_record: approvalRecord(approvalPayload),
      };
      const completedWithoutEvidence = structuredClone(pending) as unknown as {
        approval_record: Record<string, unknown>;
      };
      completedWithoutEvidence.approval_record.pending_user_ratification = false;
      expect(() => parseRuntimeSnapshotProfile(completedWithoutEvidence)).toThrow(/ratif/i);

      const pendingWithPrefilledEvidence = structuredClone(pending) as unknown as {
        approval_record: Record<string, unknown>;
      };
      Object.assign(pendingWithPrefilledEvidence.approval_record, {
        ratified_by: 'user',
        ratified_date: '2026-07-24',
        ratification_evidence: evidencePath,
        ratification_evidence_sha256: evidenceSha256,
        ratified_profile_payload_sha256: runtimeProfileApprovalSha256(approvalPayload),
        ratification_decision: 'Approve the synthetic profile fixture.',
      });
      expect(() => parseRuntimeSnapshotProfile(pendingWithPrefilledEvidence)).toThrow(/ratif/i);

      const completed = structuredClone(completedWithoutEvidence);
      Object.assign(completed.approval_record, {
        ratified_by: 'user',
        ratified_date: '2026-07-24',
        ratification_evidence: evidencePath,
        ratification_evidence_sha256: evidenceSha256,
        ratified_profile_payload_sha256: runtimeProfileApprovalSha256(approvalPayload),
        ratification_decision: 'Approve the synthetic profile fixture.',
      });
      const parsed = parseRuntimeSnapshotProfile(completed);
      expect(() => validateRuntimeProfileState(repoRoot, parsed)).not.toThrow();
    });
  });

  test('ratification state rejects missing, escaping, backslash, non-markdown, whitespace, trailing-slash, and symlink evidence paths', () => {
    const repoRoot = resolve(import.meta.dir, '../..');
    const approvalPayload = profile({ status: 'approved' });
    const completed = (evidencePath: string): RuntimeSnapshotProfile => parseRuntimeSnapshotProfile({
      ...approvalPayload,
      approval_record: {
        ...approvalRecord(approvalPayload),
        pending_user_ratification: false,
        ratified_by: 'user',
        ratified_date: '2026-07-24',
        ratification_evidence: evidencePath,
        ratification_evidence_sha256: '0'.repeat(64),
        ratified_profile_payload_sha256: runtimeProfileApprovalSha256(approvalPayload),
        ratification_decision: 'Approve the synthetic profile fixture.',
      },
    });

    expect(() => validateRuntimeProfileState(
      repoRoot,
      completed('docs/ai-native/evidence/missing-ratification.md'),
    )).toThrow(/does not exist/);
    expect(() => validateRuntimeProfileState(
      repoRoot,
      completed('docs/ai-native/evidence/../outside.md'),
    )).toThrow(/canonical|escapes/);
    expect(() => validateRuntimeProfileState(
      repoRoot,
      completed('docs/ai-native/evidence\\outside.md'),
    )).toThrow(/canonical/);

    const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-ratification-'));
    try {
      const evidenceRoot = join(tempRoot, 'docs/ai-native/evidence');
      mkdirSync(evidenceRoot, { recursive: true });
      writeFileSync(join(tempRoot, 'target.md'), 'fixture');
      writeFileSync(join(evidenceRoot, 'not-markdown.txt'), 'fixture');
      writeFileSync(join(evidenceRoot, 'white space.md'), 'fixture');
      mkdirSync(join(evidenceRoot, 'folder.md'), { recursive: true });
      expect(() => validateRuntimeProfileState(
        tempRoot,
        completed('docs/ai-native/evidence/not-markdown.txt'),
      )).toThrow(/canonical/);
      expect(() => validateRuntimeProfileState(
        tempRoot,
        completed('docs/ai-native/evidence/white space.md'),
      )).toThrow(/canonical/);
      expect(() => validateRuntimeProfileState(
        tempRoot,
        completed('docs/ai-native/evidence/folder.md/'),
      )).toThrow(/canonical/);
      symlinkSync(join(tempRoot, 'target.md'), join(evidenceRoot, 'link.md'));
      expect(() => validateRuntimeProfileState(
        tempRoot,
        completed('docs/ai-native/evidence/link.md'),
      )).toThrow(/symlink/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('completed ratification cannot be removed, reverted, or rewritten', () => {
    withRatificationEvidence(({ repoRoot, evidencePath, evidenceSha256 }) => {
      const approvalPayload = profile({ status: 'approved' });
      const completed = parseRuntimeSnapshotProfile({
        ...approvalPayload,
        approval_record: {
          ...approvalRecord(approvalPayload),
          pending_user_ratification: false,
          ratified_by: 'user',
          ratified_date: '2026-07-24',
          ratification_evidence: evidencePath,
          ratification_evidence_sha256: evidenceSha256,
          ratified_profile_payload_sha256: runtimeProfileApprovalSha256(approvalPayload),
          ratification_decision: 'Approve the synthetic profile fixture.',
        },
      });
      const removed = parseRuntimeSnapshotProfile(profile());
      expect(() => validateRuntimeProfileTransition(repoRoot, completed, removed)).toThrow(/cannot be removed/);

      const rewritten = structuredClone(completed);
      rewritten.approval_record!.ratified_by = 'different-user';
      expect(() => validateRuntimeProfileTransition(repoRoot, completed, rewritten)).toThrow(/immutable/);
      expect(() => validateRuntimeProfileTransition(repoRoot, completed, structuredClone(completed))).not.toThrow();
    });
  });
});

describe('runtime tool accounting', () => {
  test('classifies every final tool and requires one accounting disposition', () => {
    const result = accountFinalTools({
      finalTools: [
        { name: 'memory_search' },
        { name: 'list_games' },
        { name: 'ui_act_role_list' },
      ],
      rawPluginTools: [],
      sources,
      accounting: {
        memory_search: { explicit_out_of_scope_reason: 'foundation-memory' },
        list_games: { mapped_effects: ['game.list'] },
        ui_act_role_list: { mapped_effects: ['role.list'] },
      },
    });
    expect(result.unresolved).toEqual([]);
    expect(result.rows.map((row) => row.tool_source)).toEqual([
      'product-shell',
      'builtin',
      'catalog-firstclass',
    ]);
  });

  test('fails closed on unresolved and stale accounting', () => {
    expect(() => accountFinalTools({
      finalTools: [{ name: 'memory_search' }],
      rawPluginTools: [],
      sources,
      accounting: {},
    })).toThrow('incomplete tool accounting');
    expect(() => accountFinalTools({
      finalTools: [{ name: 'memory_search' }],
      rawPluginTools: [],
      sources,
      accounting: {
        memory_search: { explicit_out_of_scope_reason: 'foundation-memory' },
        stale: { explicit_out_of_scope_reason: 'stale' },
      },
    })).toThrow('stale tool accounting');
  });

  test('allows discovery to report unresolved tools without pretending completeness', () => {
    const result = accountFinalTools({
      finalTools: [{ name: 'memory_search' }],
      rawPluginTools: [],
      sources,
      accounting: {},
      allowUnresolved: true,
    });
    expect(result.unresolved).toEqual(['memory_search']);
    expect(result.rows[0]?.unresolved).toBe(true);
  });

  test('rejects exposed plugin wire collisions', () => {
    expect(() => assertNoPluginWireCollisions([
      { id: 'a:b', wireName: 'a_b', extensionId: 'a', exposedToAI: true, hasHandler: true },
      { id: 'a.b', wireName: 'a_b', extensionId: 'b', exposedToAI: true, hasHandler: true },
    ])).toThrow('plugin wire collision');
  });

  test('rejects a final tool claimed by multiple source layers', () => {
    expect(() => accountFinalTools({
      finalTools: [{ name: 'memory_search' }],
      rawPluginTools: [],
      sources: {
        ...sources,
        plugin: new Set([...sources.plugin, 'memory_search']),
      },
      accounting: {
        memory_search: { explicit_out_of_scope_reason: 'foundation-memory' },
      },
    })).toThrow('ambiguous final tool source');
  });
});

describe('checked-in runtime snapshot identity', () => {
  test('classifies the current merged-manifest origin contract for safe boot', () => {
    expect(runtimeSnapshotLayerForOrigin('builtin')).toBe('L0');
    expect(runtimeSnapshotLayerForOrigin('user')).toBeNull();
    expect(runtimeSnapshotLayerForOrigin('project')).toBeNull();
  });

  test.each(['development', 'formal'] as const)(
    '%s snapshot mirrors the wb-game-video manifest without legacy aliases',
    (mode) => {
      const repoRoot = resolve(import.meta.dir, '../..');
      const manifest = JSON.parse(readFileSync(
        resolve(repoRoot, WB_GAME_VIDEO_MANIFEST_ORIGIN),
        'utf8',
      )) as {
        id: string;
        version: string;
        provides: { tools: Array<{ id: string }> };
      };
      const snapshotPath = resolve(
        import.meta.dir,
        `runtime-snapshots/main.${mode}.json`,
      );
      const snapshotText = readFileSync(snapshotPath, 'utf8');
      const snapshot = JSON.parse(snapshotText) as {
        raw_tool_catalog: Array<{ extensionId: string; id: string }>;
        reproduction_key: {
          plugin_combination: {
            manifests: Array<{ id: string; origin: string; version: string }>;
          };
        };
      };
      const snapshotManifest = snapshot.reproduction_key.plugin_combination.manifests.find(
        (item) => item.origin === WB_GAME_VIDEO_MANIFEST_ORIGIN,
      );
      const expectedToolIds = manifest.provides.tools.map((tool) => tool.id).sort();
      const actualToolIds = snapshot.raw_tool_catalog
        .filter((tool) => tool.extensionId === manifest.id)
        .map((tool) => tool.id)
        .sort();

      expect(manifest.id).toBe('@forgeax/wb-game-video');
      expect(snapshotManifest).toMatchObject({
        id: manifest.id,
        version: manifest.version,
      });
      expect(actualToolIds).toEqual(expectedToolIds);
      expect(snapshotText).not.toContain('@forgeax-extension/wb-game-video');
      for (const legacyToolId of WB_GAME_VIDEO_LEGACY_TOOL_IDS) {
        expect(snapshotText).not.toContain(`"${legacyToolId}"`);
      }
    },
  );
});

describe('runtime snapshot determinism and formal gates', () => {
  test('normalizes dynamic roots before stable serialization', () => {
    const left = stablePrettyJson(normalizeDynamicValues(
      { path: '/tmp/a/project/file', nested: ['/tmp/a/project'] },
      [['/tmp/a/project', '<PROJECT_ROOT>']],
    ));
    const right = stablePrettyJson({ nested: ['<PROJECT_ROOT>'], path: '<PROJECT_ROOT>/file' });
    expect(left).toBe(right);
    expect(() => assertByteIdentical(new TextEncoder().encode(left), new TextEncoder().encode(right))).not.toThrow();
  });

  test('rejects byte differences', () => {
    expect(() => assertByteIdentical(new Uint8Array([1]), new Uint8Array([2]))).toThrow('not byte-identical');
  });

  test('formal eligibility names every blocker', () => {
    expect(formalEligibility({
      profileStatus: 'proposed',
      dirty: true,
      unresolvedTools: ['x'],
      scanErrorCount: 1,
      mergeIssueCount: 1,
      kindIssueCount: 1,
    })).toEqual({
      eligible: false,
      blockers: [
        'profile-not-approved',
        'worktree-dirty',
        'tool-accounting-incomplete',
        'extension-scan-errors',
        'extension-merge-issues',
        'extension-kind-issues',
      ],
    });
  });

  test('a named waiver removes only the listed blocker and preserves the audit trail', () => {
    const kindIssues = ['asset2d:templates.list', 'asset2d:templates.get'].map((id) => ({
      kind: 'tool',
      extensionId: '@forgeax-extension/wb-2d-scene-asset-generator',
      reason: `duplicate tool id "${id}" in plugin @forgeax-extension/wb-2d-scene-asset-generator`,
    }));
    expect(formalEligibility({
      profileStatus: 'approved',
      dirty: false,
      unresolvedTools: [],
      scanErrorCount: 0,
      mergeIssueCount: 0,
      kindIssueCount: 2,
      kindIssues,
      waiver: {
        waived_blockers: ['extension-kind-issues'],
        waived_instances: ['asset2d:templates.list', 'asset2d:templates.get'],
        max_count: 2,
        reason: 'Third-party plugins expose duplicate tool ids outside this lane.',
        issuer: 'supervisory-lane',
        date: '2026-07-24',
      },
    } as never)).toEqual({
      eligible: true,
      blockers: [],
      waived_blockers: ['extension-kind-issues'],
    });
  });

  test('an instance waiver fails closed for bulk, changed, or additional kind issues', () => {
    const issue = (id: string) => ({
      kind: 'tool',
      extensionId: '@forgeax-extension/wb-2d-scene-asset-generator',
      reason: `duplicate tool id "${id}" in plugin @forgeax-extension/wb-2d-scene-asset-generator`,
    });
    const waiver = {
      waived_blockers: ['extension-kind-issues'],
      waived_instances: ['asset2d:templates.list', 'asset2d:templates.get'],
      max_count: 2,
      reason: 'Third-party plugins expose two named duplicate tool ids outside this lane.',
      issuer: 'supervisory-lane',
      date: '2026-07-24',
    };
    const eligibility = (kindIssues: unknown[]) => formalEligibility({
      profileStatus: 'approved',
      dirty: false,
      unresolvedTools: [],
      scanErrorCount: 0,
      mergeIssueCount: 0,
      kindIssueCount: kindIssues.length,
      kindIssues,
      waiver,
    } as never);

    expect(eligibility(Array.from({ length: 999 }, () => issue('asset2d:templates.list'))).eligible).toBe(false);
    expect(eligibility([issue('asset2d:templates.list'), issue('asset2d:templates.get')]).eligible).toBe(true);
    expect(eligibility([issue('asset2d:templates.list'), issue('asset2d:templates.list')]).eligible).toBe(false);
    expect(eligibility([
      issue('asset2d:templates.list'),
      issue('asset2d:templates.get'),
      issue('asset2d:templates.new'),
    ]).eligible).toBe(false);
  });

  test('development capture refuses an ineligible result without a complete waiver', () => {
    expect(() => assertCaptureEligibility('development', {
      eligible: false,
      blockers: ['extension-kind-issues'],
    })).toThrow(/development.*not eligible.*no complete waiver/);
    expect(() => assertCaptureEligibility('development', {
      eligible: true,
      blockers: [],
    })).not.toThrow();
  });

  test('runner requires explicit output paths', () => {
    expect(() => parseRuntimeSnapshotRunnerArgs(['--profile', 'main.json'])).toThrow('required');
  });

  test('no-git capture uses the code-owned immutable pin and rejects caller-selected anchors', () => {
    const base = [
      '--profile', 'main.json', '--snapshot', 'snapshot.json', '--report', 'report.json',
    ];
    expect(parseRuntimeSnapshotRunnerArgs([...base, '--no-git'])).toMatchObject({ noGit: true });
    expect(parseRuntimeSnapshotRunnerArgs([
      ...base, '--mode', 'formal', '--no-git',
    ])).toMatchObject({ mode: 'formal', noGit: true });
    expect(() => parseRuntimeSnapshotRunnerArgs([
      ...base, '--no-git', '--pin-source', 'pin.json',
    ])).toThrow(/unknown argument/);
  });

  test('no-git pin gate observes the code-owned version and fingerprints', async () => {
    const repoRoot = resolve(import.meta.dir, '../..');
    const checkedProfile = parseRuntimeSnapshotProfile(JSON.parse(
      readFileSync(resolve(import.meta.dir, 'profiles/main.json'), 'utf8'),
    ) as unknown);
    await expect(evaluateImmutablePinGate(
      repoRoot,
      checkedProfile.formal_gate.required_orchestrator_ancestor,
      RUNTIME_PIN_PATH,
    )).resolves.toMatchObject({
      arrived: true,
      bunVersionMatches: true,
      scannerInputFingerprintMatches: true,
      reasonCodes: [],
    });
  });

  test('enforces the same immutable pin contract in git and no-git modes', async () => {
    const repoRoot = resolve(import.meta.dir, '../..');
    const pinPath = resolve(repoRoot, 'docs/ai-native/pins/m2-2026-07-23.json');
    const checkedProfile = parseRuntimeSnapshotProfile(JSON.parse(
      readFileSync(resolve(import.meta.dir, 'profiles/main.json'), 'utf8'),
    ) as unknown);
    const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as { baseline_id: string };
    const approvals = JSON.parse(readFileSync(
      resolve(repoRoot, 'docs/ai-native/baseline/approvals.json'),
      'utf8',
    )) as { records: Array<{ baseline_id: string; status: string }> };
    const approval = approvals.records.find((record) => record.baseline_id === pin.baseline_id);
    if (!approval) throw new Error(`missing approval record for ${pin.baseline_id}`);
    const ancestor = checkedProfile.formal_gate.required_orchestrator_ancestor;
    const git = evaluatePinGate(repoRoot, ancestor, RUNTIME_PIN_PATH);
    const noGit = await evaluateImmutablePinGate(repoRoot, ancestor, RUNTIME_PIN_PATH);
    expect(git).toMatchObject({
      arrived: true,
      pinSchemaVersion: 3,
      scannerInputFingerprintMatches: true,
      scannerConfigurationFingerprintMatches: true,
      reasonCodes: [],
      baselineApproval: { baseline_id: pin.baseline_id, status: approval.status },
    });
    expect(noGit).toMatchObject({
      pinSchemaVersion: git.pinSchemaVersion,
      scannerInputFingerprintMatches: git.scannerInputFingerprintMatches,
      scannerConfigurationFingerprintMatches: git.scannerConfigurationFingerprintMatches,
      reasonCodes: git.reasonCodes,
      baselineApproval: git.baselineApproval,
    });
  });

  test('no-git ancestry proof accepts a descendant without redefining ancestor as equality', async () => {
    const repoRoot = resolve(import.meta.dir, '../..');
    const checkedProfile = parseRuntimeSnapshotProfile(JSON.parse(
      readFileSync(resolve(import.meta.dir, 'profiles/main.json'), 'utf8'),
    ) as unknown);
    const ancestor = checkedProfile.formal_gate.required_orchestrator_ancestor;
    const git = evaluatePinGate(repoRoot, ancestor, RUNTIME_PIN_PATH);
    const noGit = await evaluateImmutablePinGate(repoRoot, ancestor, RUNTIME_PIN_PATH);
    expect(git.orchestratorGitlink).not.toBe(ancestor);
    expect(git).toMatchObject({ arrived: true, verification: 'git-ancestry' });
    expect(noGit).toMatchObject({
      arrived: true,
      orchestratorGitlink: git.orchestratorGitlink,
      verification: 'immutable-pin-git-ancestry-proof',
    });
  });

  test('seals a runner-derived content mode into bytes and keeps Bun outside the reproduction key', () => {
    const worker = stablePrettyJson({
      schema_version: 1,
      capture_mode: 'worker-verified',
      reproduction_key: { fixture: 'same', runtime_environment: { bun_version: '1.0.0' } },
      reproduction_key_sha256: '0'.repeat(64),
      runtime_environment: { bun_version: '1.0.0' },
    });
    const development = JSON.parse(new TextDecoder().decode(sealRuntimeSnapshot(
      new TextEncoder().encode(worker),
      captureModeFromTraversedGuard(false),
    ))) as Record<string, any>;
    const formal = JSON.parse(new TextDecoder().decode(sealRuntimeSnapshot(
      new TextEncoder().encode(worker),
      captureModeFromTraversedGuard(true),
    ))) as Record<string, any>;
    expect(development.capture_mode).toBe('development');
    expect(formal.capture_mode).toBe('formal');
    expect(development.reproduction_key).not.toHaveProperty('runtime_environment');
    expect(formal.reproduction_key_sha256).not.toBe(development.reproduction_key_sha256);
    formal.runtime_environment.bun_version = 'different-machine';
    expect(canonicalSha256(formal.reproduction_key)).toBe(formal.reproduction_key_sha256);
    expect(normalizeChildSummary(
      '[12:34:56.789] warning /repo/file\n',
      '/repo',
      '/tmp/isolation-a',
    )).toBe('[<TIME>] warning <REPO_ROOT>/file\n');
  });

  test('append-only terminal registry rejects rollback and malformed chains', () => {
    const approvalPayload = profile({ status: 'approved' });
    const terminal = parseRuntimeSnapshotProfile({
      ...approvalPayload,
      approval_record: {
        ...approvalRecord(approvalPayload),
        pending_user_ratification: false,
        ratified_by: 'user',
        ratified_date: '2026-07-24',
        ratification_evidence: 'docs/ai-native/evidence/runtime-profile-ratification-fixture.md',
        ratification_evidence_sha256: '1'.repeat(64),
        ratified_profile_payload_sha256: runtimeProfileApprovalSha256(approvalPayload),
        ratification_decision: 'fixture',
      },
    });
    const payload = {
      sequence: 1,
      profile_id: terminal.profile_id,
      ratified_profile_payload_sha256: runtimeProfileApprovalSha256(terminal),
      terminal_profile_sha256: canonicalSha256(terminal),
      previous_record_sha256: '0'.repeat(64),
    };
    const registry = parseRuntimeProfileTerminalRegistry({
      schema_version: 1,
      hash_algorithm: 'sha256-canonical-record-chain-v1',
      records: [{ ...payload, record_sha256: canonicalSha256(payload) }],
    });
    expect(() => validateRuntimeProfileAgainstTerminalRegistry(profile(), registry)).toThrow(/cannot leave ratified state/);
    expect(() => validateRuntimeProfileAgainstTerminalRegistry(terminal, registry)).not.toThrow();
    expect(() => parseRuntimeProfileTerminalRegistry({
      schema_version: 1,
      hash_algorithm: 'sha256-canonical-record-chain-v1',
      records: [{ ...payload, previous_record_sha256: 'f'.repeat(64), record_sha256: canonicalSha256(payload) }],
    })).toThrow(/previous_record_sha256|record SHA/);
  });

  test('an empty terminal registry explicitly permits only a still-pending profile', () => {
    const registry = parseRuntimeProfileTerminalRegistry({
      schema_version: 1,
      hash_algorithm: 'sha256-canonical-record-chain-v1',
      records: [],
    });
    expect(() => validateRuntimeProfileAgainstTerminalRegistry(profile(), registry)).not.toThrow();
  });

  test('an empty terminal registry rejects a terminal profile until an append is recorded', () => {
    const approvalPayload = profile({ status: 'approved' });
    const terminal = parseRuntimeSnapshotProfile({
      ...approvalPayload,
      approval_record: {
        ...approvalRecord(approvalPayload),
        pending_user_ratification: false,
        ratified_by: 'user',
        ratified_date: '2026-07-24',
        ratification_evidence: 'docs/ai-native/evidence/runtime-profile-ratification-fixture.md',
        ratification_evidence_sha256: '1'.repeat(64),
        ratified_profile_payload_sha256: runtimeProfileApprovalSha256(approvalPayload),
        ratification_decision: 'fixture',
      },
    });
    const registry = parseRuntimeProfileTerminalRegistry({
      schema_version: 1,
      hash_algorithm: 'sha256-canonical-record-chain-v1',
      records: [],
    });
    expect(() => validateRuntimeProfileAgainstTerminalRegistry(terminal, registry)).toThrow(/missing from the append-only registry/);
  });

  test('a terminal registry record rejects both payload and terminal-byte rewrites', () => {
    const approvalPayload = profile({ status: 'approved' });
    const terminal = parseRuntimeSnapshotProfile({
      ...approvalPayload,
      approval_record: {
        ...approvalRecord(approvalPayload),
        pending_user_ratification: false,
        ratified_by: 'user',
        ratified_date: '2026-07-24',
        ratification_evidence: 'docs/ai-native/evidence/runtime-profile-ratification-fixture.md',
        ratification_evidence_sha256: '1'.repeat(64),
        ratified_profile_payload_sha256: runtimeProfileApprovalSha256(approvalPayload),
        ratification_decision: 'fixture',
      },
    });
    const makeRegistry = (ratifiedProfileSha: string, terminalSha: string) => {
      const payload = {
      sequence: 1,
      profile_id: terminal.profile_id,
      ratified_profile_payload_sha256: ratifiedProfileSha,
      terminal_profile_sha256: terminalSha,
      previous_record_sha256: '0'.repeat(64),
      };
      return parseRuntimeProfileTerminalRegistry({
        schema_version: 1,
        hash_algorithm: 'sha256-canonical-record-chain-v1',
        records: [{ ...payload, record_sha256: canonicalSha256(payload) }],
      });
    };
    expect(() => validateRuntimeProfileAgainstTerminalRegistry(
      terminal,
      makeRegistry('1'.repeat(64), canonicalSha256(terminal)),
    )).toThrow(/payload SHA-256 changed/);
    expect(() => validateRuntimeProfileAgainstTerminalRegistry(
      terminal,
      makeRegistry(runtimeProfileApprovalSha256(terminal), '2'.repeat(64)),
    )).toThrow(/terminal record changed/);
  });

  test('real runner entry rejects a registry-known terminal profile reverted to proposed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-terminal-runner-'));
    try {
      const profilePath = join(root, 'profile.json');
      const registryPath = join(root, 'docs/ai-native/baseline/runtime-profile-terminals.json');
      const pinPath = join(root, RUNTIME_PIN_PATH);
      mkdirSync(join(root, 'docs/ai-native/baseline'), { recursive: true });
      writeFileSync(profilePath, stablePrettyJson(profile()));
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
      mkdirSync(resolve(root, 'docs/ai-native/pins'), { recursive: true });
      writeFileSync(pinPath, stablePrettyJson(pin));
      await expect(runRuntimeSnapshot({
        mode: 'development',
        profilePath,
        snapshotPath: join(root, 'snapshot.json'),
        reportPath: join(root, 'report.json'),
        noGit: true,
      }, { repoRoot: root })).rejects.toThrow(/terminal profile main cannot leave ratified state/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the real profile-loading entry invokes the terminal guard even while the registry is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-terminal-real-entry-'));
    const profilePath = join(root, 'scripts/ai-native/profiles/main.json');
    const registryPath = join(root, 'docs/ai-native/baseline/runtime-profile-terminals.json');
    const pinPath = join(root, RUNTIME_PIN_PATH);
    mkdirSync(resolve(root, 'scripts/ai-native/profiles'), { recursive: true });
    mkdirSync(resolve(root, 'docs/ai-native/baseline'), { recursive: true });
    mkdirSync(resolve(root, 'docs/ai-native/pins'), { recursive: true });
    const profileText = stablePrettyJson(profile());
    const registryText = '{"schema_version":1,"hash_algorithm":"sha256-canonical-record-chain-v1"}\n';
    writeFileSync(profilePath, profileText);
    writeFileSync(registryPath, registryText);
    const pin = JSON.parse(readFileSync(resolve(import.meta.dir, '../../docs/ai-native/pins/m2-2026-07-23.json'), 'utf8'));
    pin.governance_artifacts.runtime_profile_terminals.sha256 = sha256(registryText);
    writeFileSync(pinPath, stablePrettyJson(pin));
    expect(loadValidatedRuntimeProfile(root, profilePath, RUNTIME_PIN_PATH)).toMatchObject({
      registry: { records: [] },
      governanceVerification: { status: 'unverified-diagnostic' },
    });
  });
});
