#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CAPABILITY_RATCHET_GENESIS_PATH,
  validateCapabilityRatchet,
} from './capability-ratchet';
import { loadCurrentBaselineState } from './baseline-state.ts';
import { stableStringify } from './runtime-snapshot-core';

interface R6CiArtifact {
  baseline_id: string;
  baseline_approval: 'approved' | 'pending' | 'unverified-diagnostic';
  baseline_bytes_sha256: string;
  baseline_governance_verification: {
    status: 'verified' | 'unverified-diagnostic';
    path: string;
    reasons: string[];
    committed_sha: 'HEAD' | null;
  };
  governance_reason_codes: string[];
  result_status: 'final' | 'draft';
  coverage_tier: string;
  exclusion_disclosure: {
    included_dispositions: ['tool', 'read'];
    excluded_effects_by_disposition: Record<string, number>;
  };
  numerator: number;
  denominator: number;
  coverage_percent: number;
  domains: Array<{
    domain: string;
    migrated: number;
    denominator: number;
    tool: number;
    read: number;
    coverage_percent: number;
  }>;
  migrated_effect_ids: string[];
  migrated_control_ids: string[];
  equivalence: { verified: number; declared: number; none: number };
  equivalence_all_effects: { verified: number; declared: number; none: number };
  evaluations: Array<{
    effect_id: string;
    domain: string;
    agent_equiv: string;
    status: string;
    manifest_id: string | null;
    reasons: string[];
  }>;
  test_runs: Array<{ test_id: string; ok: boolean; output: string }>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function parseArtifact(value: unknown, label: string): R6CiArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected a JSON object`);
  }
  const artifact = value as Partial<R6CiArtifact>;
  if (
    typeof artifact.baseline_id !== 'string'
    || !['approved', 'pending', 'unverified-diagnostic'].includes(String(artifact.baseline_approval))
    || typeof artifact.baseline_bytes_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(artifact.baseline_bytes_sha256)
    || !artifact.baseline_governance_verification
    || !['verified', 'unverified-diagnostic'].includes(
      String(artifact.baseline_governance_verification.status),
    )
    || typeof artifact.baseline_governance_verification.path !== 'string'
    || !Array.isArray(artifact.baseline_governance_verification.reasons)
    || !Array.isArray(artifact.governance_reason_codes)
    || !['final', 'draft'].includes(String(artifact.result_status))
    || typeof artifact.coverage_tier !== 'string'
    || !artifact.exclusion_disclosure
    || !Array.isArray(artifact.exclusion_disclosure.included_dispositions)
    || !artifact.exclusion_disclosure.excluded_effects_by_disposition
    || !Number.isInteger(artifact.numerator)
    || !Number.isInteger(artifact.denominator)
    || typeof artifact.coverage_percent !== 'number'
    || !Array.isArray(artifact.domains)
    || !Array.isArray(artifact.migrated_effect_ids)
    || !Array.isArray(artifact.migrated_control_ids)
    || !artifact.equivalence
    || !artifact.equivalence_all_effects
    || !Array.isArray(artifact.evaluations)
    || !Array.isArray(artifact.test_runs)
  ) throw new Error(`${label}: incomplete R6 coverage artifact`);
  return artifact as R6CiArtifact;
}

function decisionProjection(artifact: R6CiArtifact): unknown {
  return {
    baseline_id: artifact.baseline_id,
    baseline_approval: artifact.baseline_approval,
    baseline_bytes_sha256: artifact.baseline_bytes_sha256,
    baseline_governance_verification: artifact.baseline_governance_verification,
    governance_reason_codes: artifact.governance_reason_codes,
    result_status: artifact.result_status,
    coverage_tier: artifact.coverage_tier,
    exclusion_disclosure: artifact.exclusion_disclosure,
    numerator: artifact.numerator,
    denominator: artifact.denominator,
    coverage_percent: artifact.coverage_percent,
    domains: artifact.domains,
    migrated_effect_ids: artifact.migrated_effect_ids,
    migrated_control_ids: artifact.migrated_control_ids,
    equivalence: artifact.equivalence,
    equivalence_all_effects: artifact.equivalence_all_effects,
    evaluations: artifact.evaluations.map((row) => ({
      effect_id: row.effect_id,
      domain: row.domain,
      agent_equiv: row.agent_equiv,
      status: row.status,
      manifest_id: row.manifest_id,
      reasons: row.reasons,
    })),
  };
}

export function verifyR6Artifact(actualValue: unknown, expectedValue: unknown): R6CiArtifact {
  const actual = parseArtifact(actualValue, 'actual');
  const expected = parseArtifact(expectedValue, 'expected');
  if (actual.test_runs.length === 0) throw new Error('actual R6 artifact executed no evidence tests');
  const failed = actual.test_runs.filter((run) => run.ok !== true);
  if (failed.length > 0) {
    throw new Error(`actual R6 artifact has failed evidence tests: ${failed.map((run) => run.test_id).join(', ')}`);
  }
  if (actual.numerator !== actual.migrated_effect_ids.length) {
    throw new Error('actual R6 numerator disagrees with migrated_effect_ids');
  }
  if ((actual.baseline_approval !== 'approved') !== (actual.result_status === 'draft')
    || (actual.baseline_approval !== 'approved' && actual.coverage_tier !== 'provisional')) {
    throw new Error('actual R6 baseline approval does not agree with draft/final coverage state');
  }
  if (actual.baseline_governance_verification.status !== 'verified') {
    if (!actual.governance_reason_codes.includes('baseline-governance-unverified')) {
      throw new Error('unverified R6 governance lacks its dedicated reason code');
    }
  }
  if (actual.result_status === 'final'
    && actual.baseline_governance_verification.status !== 'verified') {
    throw new Error('final R6 result requires verified governance');
  }
  if (stableStringify(decisionProjection(actual)) !== stableStringify(decisionProjection(expected))) {
    throw new Error(
      `real R6 decision differs from checked artifact: actual=${actual.numerator}/${actual.denominator} `
      + `expected=${expected.numerator}/${expected.denominator}`,
    );
  }
  return actual;
}

function args(argv: string[]): { actual: string; expected: string } {
  let actual = '';
  let expected = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a path`);
      return value;
    };
    if (arg === '--actual') actual = next();
    else if (arg === '--expected') expected = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!actual || !expected) throw new Error('--actual and --expected are required');
  return { actual: resolve(actual), expected: resolve(expected) };
}

function main(): void {
  const root = resolve(import.meta.dir, '../..');
  const options = args(process.argv.slice(2));
  const actual = verifyR6Artifact(readJson(options.actual), readJson(options.expected));
  const balance = readJson(resolve(root, 'scripts/ai-native/r4r5-balance.json')) as { seed_sha256: string };
  const baselineState = loadCurrentBaselineState(root);
  const active = readJson(resolve(root, 'scripts/ai-native/capability-baseline.json'));
  const historyDirectory = resolve(root, 'scripts/ai-native/capability-baseline-history');
  const previousNames = readdirSync(historyDirectory)
    .filter((name) => name.startsWith(`${baselineState.previousBaselineId}-`) && name.endsWith('.json'));
  if (previousNames.length !== 1) {
    throw new Error(`expected one previous capability ratchet for ${baselineState.previousBaselineId}, found ${previousNames.length}`);
  }
  const previous = readJson(join(historyDirectory, previousNames[0]!));
  const intermediateHistory = readdirSync(historyDirectory)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== CAPABILITY_RATCHET_GENESIS_PATH.split('/').at(-1))
    .filter((name) => name !== previousNames[0])
    .sort()
    .map((name) => readJson(join(historyDirectory, name)));
  const controls = readJsonLines(resolve(root, 'docs/ai-native/baseline', baselineState.currentBaselineId, 'controls.jsonl'));
  const previousControls = readJsonLines(resolve(root, 'docs/ai-native/baseline', baselineState.previousBaselineId, 'controls.jsonl'));
  const ratchet = validateCapabilityRatchet({
    active,
    previous,
    genesis: readJson(resolve(root, CAPABILITY_RATCHET_GENESIS_PATH)),
    history: intermediateHistory,
    sourceControlIds: controls.map((row) => String(row.control_id)),
    previousSourceControlIds: previousControls.map((row) => String(row.control_id)),
    calculatorMigratedControlIds: actual.migrated_control_ids,
    recordedSeedSha256: balance.seed_sha256,
  });
  process.stdout.write(
    `[r6-ci] real tests=${actual.test_runs.length}/${actual.test_runs.length}; `
    + `coverage=${actual.numerator}/${actual.denominator}; tier=${actual.coverage_tier}; `
    + `ratchet-unmigrated=${ratchet.control_count}\n`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`[r6-ci] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
