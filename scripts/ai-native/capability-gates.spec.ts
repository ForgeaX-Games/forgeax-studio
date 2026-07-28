import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HEADLESS_ACTION_GRANDFATHER_IDS } from '../../packages/orchestrator/src';
import {
  buildActionCatalog,
  catalogAll,
} from '../../packages/orchestrator/src/kernel/action-catalog';
import { listBuiltinHeadlessUiActionIds } from '../../packages/orchestrator/src/kernel/ui-headless-actions';
import {
  CAPABILITY_RATCHET_GENESIS_PATH,
  validateCapabilityRatchet,
  validateDeclaredHeadlessHandlers,
} from './capability-ratchet';
import { calculateRepositoryR6Coverage } from './r6-coverage';
import { verifyR6Artifact } from './verify-r6-ci';
import { loadCurrentBaselineState } from './baseline-state.ts';

const ROOT = resolve(import.meta.dir, '../..');
const BASELINE_STATE = loadCurrentBaselineState(ROOT);
const BASELINE_DIR = resolve(ROOT, 'docs/ai-native/baseline', BASELINE_STATE.currentBaselineId);
const PREVIOUS_BASELINE_DIR = resolve(ROOT, 'docs/ai-native/baseline', BASELINE_STATE.previousBaselineId);
const PREVIOUS_RATCHET_NAMES = readdirSync(resolve(ROOT, 'scripts/ai-native/capability-baseline-history'))
  .filter((name) => name.startsWith(`${BASELINE_STATE.previousBaselineId}-`) && name.endsWith('.json'));
if (PREVIOUS_RATCHET_NAMES.length !== 1) {
  throw new Error(`expected one previous capability ratchet for ${BASELINE_STATE.previousBaselineId}`);
}
const PREVIOUS_RATCHET = `scripts/ai-native/capability-baseline-history/${PREVIOUS_RATCHET_NAMES[0]!}`;
const INTERMEDIATE_RATCHETS = readdirSync(resolve(ROOT, 'scripts/ai-native/capability-baseline-history'))
  .filter((name) => name.endsWith('.json'))
  .filter((name) => name !== CAPABILITY_RATCHET_GENESIS_PATH.split('/').at(-1))
  .filter((name) => name !== PREVIOUS_RATCHET_NAMES[0])
  .sort()
  .map((name) => json(`scripts/ai-native/capability-baseline-history/${name}`));

function json(path: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as unknown;
}

function jsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function repositoryCoverage() {
  buildActionCatalog();
  // Unit-only seam: ratchet behavior is isolated from child-process execution.
  // CI does not use this stub; verify-r6-ci.ts consumes the calculator's real JSON.
  return calculateRepositoryR6Coverage(ROOT, {
    catalogEntries: catalogAll(),
    handlerIds: [...listBuiltinHeadlessUiActionIds()],
    runTest: async () => ({ ok: true, output: '1 pass (ratchet contract fixture)' }),
  });
}

describe('R6 real-artifact CI guard', () => {
  const artifact = {
    baseline_id: 'b1-2026-07-24-0.6.2',
    baseline_approval: 'approved' as 'approved' | 'pending' | 'unverified-diagnostic',
    baseline_bytes_sha256: 'a'.repeat(64),
    baseline_governance_verification: {
      status: 'verified' as 'verified' | 'unverified-diagnostic',
      path: 'governance.json',
      reasons: [] as string[],
      committed_sha: 'HEAD' as 'HEAD' | null,
    },
    governance_reason_codes: [] as string[],
    result_status: 'final' as 'final' | 'draft',
    coverage_tier: 'formal-with-waiver',
    exclusion_disclosure: {
      included_dispositions: ['tool', 'read'] as ['tool', 'read'],
      excluded_effects_by_disposition: { 'view-opt': 1 },
    },
    numerator: 1,
    denominator: 2,
    coverage_percent: 50,
    domains: [{
      domain: 'role',
      migrated: 1,
      denominator: 2,
      tool: 1,
      read: 1,
      coverage_percent: 50,
    }],
    migrated_effect_ids: ['role.create'],
    migrated_control_ids: ['ctl_6121eb75db55845a85fabc07'],
    equivalence: { verified: 1, declared: 0, none: 1 },
    equivalence_all_effects: { verified: 1, declared: 0, none: 1 },
    evaluations: [{
      effect_id: 'role.create',
      domain: 'role',
      agent_equiv: 'verified',
      status: 'migrated',
      manifest_id: 'm2-r6-role-create',
      reasons: [] as string[],
    }],
    test_runs: [{ test_id: 'role.test.ts#works', ok: true, output: '1 pass' }],
  };

  it('accepts a real passing artifact whose decision matches the checked artifact', () => {
    expect(verifyR6Artifact(artifact, structuredClone(artifact)).numerator).toBe(1);
  });

  it('rejects failed real tests and a stale checked numerator', () => {
    const failed = structuredClone(artifact);
    failed.test_runs[0]!.ok = false;
    expect(() => verifyR6Artifact(failed, artifact)).toThrow(/failed evidence tests/);

    const stale = structuredClone(artifact);
    stale.numerator = 0;
    stale.migrated_effect_ids = [];
    expect(() => verifyR6Artifact(artifact, stale)).toThrow(/differs from checked artifact/);

    const staleEquivalence = structuredClone(artifact);
    staleEquivalence.equivalence = { verified: 0, declared: 1, none: 1 };
    staleEquivalence.evaluations[0]!.agent_equiv = 'declared';
    expect(() => verifyR6Artifact(artifact, staleEquivalence)).toThrow(/differs from checked artifact/);

    const staleDisclosure = structuredClone(artifact);
    staleDisclosure.exclusion_disclosure.excluded_effects_by_disposition['view-opt'] = 2;
    expect(() => verifyR6Artifact(artifact, staleDisclosure)).toThrow(/differs from checked artifact/);

    const staleDomain = structuredClone(artifact);
    staleDomain.domains[0]!.denominator = 3;
    expect(() => verifyR6Artifact(artifact, staleDomain)).toThrow(/differs from checked artifact/);
  });

  it('projects governance and rejects a diagnostic verdict against a verified checked artifact', () => {
    const diagnostic = structuredClone(artifact);
    diagnostic.baseline_approval = 'unverified-diagnostic';
    diagnostic.result_status = 'draft';
    diagnostic.coverage_tier = 'provisional';
    diagnostic.baseline_governance_verification = {
      status: 'unverified-diagnostic',
      path: 'governance.json',
      reasons: ['worktree-path-is-dirty-or-untracked'],
      committed_sha: null,
    };
    diagnostic.governance_reason_codes = ['baseline-governance-unverified'];
    expect(() => verifyR6Artifact(diagnostic, artifact)).toThrow(/differs from checked artifact/);
  });
});

describe('M2 capability baseline ratchet', () => {
  it('accepts the seed-anchored continuation shrink and rejects orphans', async () => {
    const coverage = await repositoryCoverage();
    const sourceIds = jsonLines(resolve(BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const previousSourceIds = jsonLines(resolve(PREVIOUS_BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const balance = json('scripts/ai-native/r4r5-balance.json') as { seed_sha256: string };
    const active = json('scripts/ai-native/capability-baseline.json');
    expect(validateCapabilityRatchet({
      active,
      previous: json(PREVIOUS_RATCHET),
      genesis: json(CAPABILITY_RATCHET_GENESIS_PATH),
      history: INTERMEDIATE_RATCHETS,
      sourceControlIds: sourceIds,
      previousSourceControlIds: previousSourceIds,
      calculatorMigratedControlIds: coverage.migrated_control_ids,
      recordedSeedSha256: balance.seed_sha256,
    }).control_count).toBe(sourceIds.length - coverage.migrated_control_ids.length);
  });

  it('injected growth by restoring a migrated line is red', async () => {
    const coverage = await repositoryCoverage();
    const sourceIds = jsonLines(resolve(BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const previousSourceIds = jsonLines(resolve(PREVIOUS_BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const balance = json('scripts/ai-native/r4r5-balance.json') as { seed_sha256: string };
    const active = structuredClone(json('scripts/ai-native/capability-baseline.json')) as {
      control_count: number;
      unmigrated_control_ids: string[];
    };
    active.unmigrated_control_ids.push(coverage.migrated_control_ids[0]);
    active.control_count += 1;
    expect(() => validateCapabilityRatchet({
      active,
      previous: json(PREVIOUS_RATCHET),
      genesis: json(CAPABILITY_RATCHET_GENESIS_PATH),
      history: INTERMEDIATE_RATCHETS,
      sourceControlIds: sourceIds,
      previousSourceControlIds: previousSourceIds,
      calculatorMigratedControlIds: coverage.migrated_control_ids,
      recordedSeedSha256: balance.seed_sha256,
    })).toThrow(/grew after previous shrink|exact seed-minus-calculator/);
  });

  it('injected orphan control is red', async () => {
    const coverage = await repositoryCoverage();
    const sourceIds = jsonLines(resolve(BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const previousSourceIds = jsonLines(resolve(PREVIOUS_BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const balance = json('scripts/ai-native/r4r5-balance.json') as { seed_sha256: string };
    const active = structuredClone(json('scripts/ai-native/capability-baseline.json')) as {
      control_count: number;
      unmigrated_control_ids: string[];
    };
    active.unmigrated_control_ids.push('ctl_ffffffffffffffffffffffff');
    active.control_count += 1;
    expect(() => validateCapabilityRatchet({
      active,
      previous: json(PREVIOUS_RATCHET),
      genesis: json(CAPABILITY_RATCHET_GENESIS_PATH),
      history: INTERMEDIATE_RATCHETS,
      sourceControlIds: sourceIds,
      previousSourceControlIds: previousSourceIds,
      calculatorMigratedControlIds: coverage.migrated_control_ids,
      recordedSeedSha256: balance.seed_sha256,
    })).toThrow(/orphan/);
  });

  it('rejects a broken previous_sha256 continuation link', async () => {
    const coverage = await repositoryCoverage();
    const sourceIds = jsonLines(resolve(BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const previousSourceIds = jsonLines(resolve(PREVIOUS_BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const balance = json('scripts/ai-native/r4r5-balance.json') as { seed_sha256: string };
    const active = structuredClone(json('scripts/ai-native/capability-baseline.json')) as { previous_sha256: string };
    active.previous_sha256 = '0'.repeat(64);
    expect(() => validateCapabilityRatchet({
      active,
      previous: json(PREVIOUS_RATCHET),
      genesis: json(CAPABILITY_RATCHET_GENESIS_PATH),
      history: INTERMEDIATE_RATCHETS,
      sourceControlIds: sourceIds,
      previousSourceControlIds: previousSourceIds,
      calculatorMigratedControlIds: coverage.migrated_control_ids,
      recordedSeedSha256: balance.seed_sha256,
    })).toThrow(/previous ratchet SHA/);
  });

  it('rejects a rewritten history archive even when builder-owned outer hashes are recomputed', async () => {
    const coverage = await repositoryCoverage();
    const sourceIds = jsonLines(resolve(BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const previousSourceIds = jsonLines(resolve(PREVIOUS_BASELINE_DIR, 'controls.jsonl')).map((row) => String(row.control_id));
    const previous = structuredClone(json(PREVIOUS_RATCHET)) as { previous_sha256: string };
    previous.previous_sha256 = '0'.repeat(64);
    const recomputedPreviousSha = createHash('sha256')
      .update(`${JSON.stringify(previous, null, 2)}\n`)
      .digest('hex');
    const active = structuredClone(json('scripts/ai-native/capability-baseline.json')) as { previous_sha256: string };
    active.previous_sha256 = recomputedPreviousSha;

    expect(() => validateCapabilityRatchet({
      active,
      previous,
      genesis: json(CAPABILITY_RATCHET_GENESIS_PATH),
      history: INTERMEDIATE_RATCHETS,
      sourceControlIds: sourceIds,
      previousSourceControlIds: previousSourceIds,
      calculatorMigratedControlIds: coverage.migrated_control_ids,
      recordedSeedSha256: recomputedPreviousSha,
    })).toThrow(/history link mismatch|genesis.*SHA|independent.*anchor/i);
  });
});

describe('Studio declaration-handler gate', () => {
  function current() {
    buildActionCatalog();
    return {
      declarations: catalogAll(),
      handlers: [...listBuiltinHeadlessUiActionIds()],
    };
  }

  it('single-sources the public orchestrator grandfather list and passes current composition', () => {
    const { declarations, handlers } = current();
    expect(() => validateDeclaredHeadlessHandlers(
      declarations,
      handlers,
      HEADLESS_ACTION_GRANDFATHER_IDS,
    )).not.toThrow();
  });

  it('injected missing handler is red', () => {
    const { declarations, handlers } = current();
    expect(() => validateDeclaredHeadlessHandlers(
      declarations,
      handlers.filter((id) => id !== 'role.list'),
      HEADLESS_ACTION_GRANDFATHER_IDS,
    )).toThrow(/missing handler.*role\.list/);
  });

  it('injected duplicate handler is red', () => {
    const { declarations, handlers } = current();
    expect(() => validateDeclaredHeadlessHandlers(
      declarations,
      [...handlers, 'role.list'],
      HEADLESS_ACTION_GRANDFATHER_IDS,
    )).toThrow(/duplicate handler.*role\.list/);
  });

  it('injected orphan handler is red', () => {
    const { declarations, handlers } = current();
    expect(() => validateDeclaredHeadlessHandlers(
      declarations,
      [...handlers, 'outside.catalog'],
      HEADLESS_ACTION_GRANDFATHER_IDS,
    )).toThrow(/orphan handler.*outside\.catalog/);
  });
});
