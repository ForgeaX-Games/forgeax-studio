#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveOrchestratorAncestryProof,
  deriveRuntimePinV3Bindings,
  loadRuntimePin,
  observeRuntimePin,
  RUNTIME_PIN_PATH,
} from './runtime-artifact-integrity.ts';
import { parseRuntimeSnapshotProfile, stableStringify } from './runtime-snapshot-core.ts';
import {
  GOVERNANCE_ARTIFACT_PATHS,
  mergeGovernanceVerifications,
  verifyGovernanceArtifact,
  type GovernanceVerification,
} from './governance-git.ts';

function parseArgs(argv: string[]): void {
  if (argv.length !== 1 || argv[0] !== '--verify') {
    throw new Error('usage: verify-runtime-pin.ts --verify');
  }
}

export function verifyRuntimePin(repoRoot: string): GovernanceVerification {
  const pin = loadRuntimePin(repoRoot, RUNTIME_PIN_PATH);
  const derived = deriveRuntimePinV3Bindings(repoRoot, pin.scanned_product_combo);
  const profile = parseRuntimeSnapshotProfile(JSON.parse(readFileSync(
    resolve(repoRoot, 'scripts/ai-native/profiles/main.json'),
    'utf8',
  )) as unknown);
  const ancestryProof = deriveOrchestratorAncestryProof(
    repoRoot,
    profile.formal_gate.required_orchestrator_ancestor,
    pin.scanned_product_combo,
  );
  const observation = observeRuntimePin(repoRoot, RUNTIME_PIN_PATH);
  if (observation.reasonCodes.length > 0) {
    throw new Error(`runtime pin scan bindings are stale: ${observation.reasonCodes.join(',')}`);
  }
  if (stableStringify(pin.governance_artifacts) !== stableStringify(derived.governance_artifacts)) {
    throw new Error('runtime pin governance bindings are stale');
  }
  if (stableStringify(pin.orchestrator_ancestry_proof) !== stableStringify(ancestryProof)) {
    throw new Error('runtime pin orchestrator ancestry proof is stale');
  }
  return mergeGovernanceVerifications(
    GOVERNANCE_ARTIFACT_PATHS.map((path) => verifyGovernanceArtifact(repoRoot, path)),
  );
}

export function assertRuntimePinGovernanceVerified(verification: GovernanceVerification): void {
  if (verification.status !== 'verified') {
    throw new Error(
      `runtime pin governance is not verified: ${verification.reasons.join(',') || 'unknown diagnostic'}`,
    );
  }
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, '../..');
    parseArgs(process.argv.slice(2));
    const verification = verifyRuntimePin(root);
    assertRuntimePinGovernanceVerified(verification);
    process.stdout.write(`[runtime-pin] PASS ${RUNTIME_PIN_PATH}\n`);
  } catch (error) {
    console.error(`[runtime-pin] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
