import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalSha256, stableStringify } from './runtime-snapshot-core.ts';
import {
  computeScannerProductTreeFingerprint,
  type ScannerFingerprintBoundaryInput,
  type ScannerProductTreeFingerprint,
} from './product-tree-fingerprint.ts';
import {
  assertIntegrityDomainGenerated,
  SCANNER_CONFIGURATION_INPUT_FILES,
} from './integrity-domain.ts';
import {
  BASELINE_APPROVALS_PATH,
  RUNTIME_PIN_PATH,
  RUNTIME_PROFILE_TERMINALS_PATH,
  mergeGovernanceVerifications,
  verifyGovernanceArtifact,
  type GovernanceVerification,
} from './governance-git.ts';

export { BASELINE_APPROVALS_PATH, RUNTIME_PIN_PATH, RUNTIME_PROFILE_TERMINALS_PATH } from './governance-git.ts';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const nonEmptyString = z.string().trim().min(1);

export const EVIDENCE_MANIFEST_DIRECTORY = 'scripts/ai-native/evidence-manifests-v1';

export interface ScannerConfigurationFingerprint {
  schema_version: 1;
  algorithm: 'sha256-derived-domain-path-content-v2';
  domains: Array<{ domain: string; path: string; sha256: string }>;
  bound_sha256: string;
}

export interface EvidenceManifestSetFingerprint {
  schema_version: 1;
  algorithm: 'sha256-sorted-path-raw-content-v1';
  directory: string;
  file_count: number;
  files: Array<{ path: string; sha256: string }>;
  bound_sha256: string;
}

export interface OrchestratorAncestryProof {
  schema_version: 1;
  required_ancestor: string;
  verified_gitlink: string;
  verification: 'git-merge-base-is-ancestor';
}

export interface RuntimePin {
  schema_version: 3;
  pin_id: string;
  baseline_id: string;
  dirty: boolean;
  scanned_product_combo: Record<string, string>;
  orchestrator_ancestry_proof: OrchestratorAncestryProof;
  scanner_input_fingerprint: ScannerProductTreeFingerprint;
  runtime_environment: { bun_version: string };
  scanner_configuration_fingerprint: ScannerConfigurationFingerprint;
  governance_artifacts: {
    baseline_approvals: { path: string; sha256: string };
    runtime_profile_terminals: { path: string; sha256: string };
    evidence_manifests: EvidenceManifestSetFingerprint;
  };
}

const scannerProductTreeFingerprintSchema = z.object({
  schema_version: z.literal(1),
  algorithm: z.literal('sha256-path-content-v2'),
  file_count: z.number().int().nonnegative(),
  content_sha256: sha256Schema,
  combo_sha256: sha256Schema,
  bound_sha256: sha256Schema,
}).strict();

const scannerConfigurationFingerprintSchema = z.object({
  schema_version: z.literal(1),
  algorithm: z.literal('sha256-derived-domain-path-content-v2'),
  domains: z.array(z.object({
    domain: nonEmptyString,
    path: nonEmptyString,
    sha256: sha256Schema,
  }).strict()).min(1),
  bound_sha256: sha256Schema,
}).strict().superRefine((value, ctx) => {
  const paths = value.domains.map((row) => row.path);
  if (new Set(paths).size !== paths.length || stableStringify(paths) !== stableStringify([...paths].sort())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains'], message: 'paths must be unique and code-point sorted' });
  }
});

const evidenceManifestSetFingerprintSchema = z.object({
  schema_version: z.literal(1),
  algorithm: z.literal('sha256-sorted-path-raw-content-v1'),
  directory: z.literal(EVIDENCE_MANIFEST_DIRECTORY),
  file_count: z.number().int().nonnegative(),
  files: z.array(z.object({ path: nonEmptyString, sha256: sha256Schema }).strict()),
  bound_sha256: sha256Schema,
}).strict().superRefine((value, ctx) => {
  if (value.files.length !== value.file_count) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['file_count'], message: 'must match files length' });
  }
  const paths = value.files.map((row) => row.path);
  if (new Set(paths).size !== paths.length || stableStringify(paths) !== stableStringify([...paths].sort())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'paths must be unique and sorted' });
  }
});

const orchestratorAncestryProofSchema = z.object({
  schema_version: z.literal(1),
  required_ancestor: commitSchema,
  verified_gitlink: commitSchema,
  verification: z.literal('git-merge-base-is-ancestor'),
}).strict();

const runtimePinSchema = z.object({
  schema_version: z.literal(3),
  pin_id: nonEmptyString,
  baseline_id: nonEmptyString,
  base_main_sha: commitSchema,
  base_main_sha_abbrev: z.string().regex(/^[0-9a-f]{7,12}$/),
  erratum: nonEmptyString,
  head_sha: commitSchema,
  head_tree_sha: commitSchema,
  dirty: z.boolean(),
  dirty_proof: z.object({
    captured_before_task_writes: z.boolean(),
    method: nonEmptyString,
    repository_count: z.number().int().positive(),
    combo_entry_count: z.number().int().positive(),
    computed_tracked_or_gitlink_failures: z.number().int().nonnegative(),
    evidence_handoff: nonEmptyString,
  }).strict(),
  scanned_product_combo: z.record(commitSchema).refine((value) => Object.keys(value).length > 0),
  orchestrator_ancestry_proof: orchestratorAncestryProofSchema,
  scanner_input_fingerprint: scannerProductTreeFingerprintSchema,
  runtime_environment: z.object({ bun_version: nonEmptyString }).strict(),
  scanner_configuration_fingerprint: scannerConfigurationFingerprintSchema,
  governance_artifacts: z.object({
    baseline_approvals: z.object({
      path: z.literal(BASELINE_APPROVALS_PATH),
      sha256: sha256Schema,
    }).strict(),
    runtime_profile_terminals: z.object({
      path: z.literal(RUNTIME_PROFILE_TERMINALS_PATH),
      sha256: sha256Schema,
    }).strict(),
    evidence_manifests: evidenceManifestSetFingerprintSchema,
  }).strict(),
}).strict();

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function repositoryPath(repoRoot: string, input: string): string {
  if (isAbsolute(input) || input.includes('\\') || posix.normalize(input) !== input) {
    throw new Error(`runtime artifact path is not canonical: ${input}`);
  }
  const root = resolve(repoRoot);
  const target = resolve(root, input);
  const rel = relative(root, target).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`runtime artifact path escapes repository: ${input}`);
  }
  return target;
}

export function computeScannerConfigurationFingerprint(repoRoot: string): ScannerConfigurationFingerprint {
  const root = resolve(repoRoot);
  const derived = assertIntegrityDomainGenerated(root);
  return configurationFingerprint(root, derived.scanner_configuration_files);
}

function configurationFingerprint(root: string, paths: readonly string[]): ScannerConfigurationFingerprint {
  const domains = paths.map((path) => {
    const target = repositoryPath(root, path);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`scanner configuration input must be a regular file: ${path}`);
    }
    const domain = path === 'scripts/ai-native/alias-map.json'
      ? 'identity-aliases'
      : path === 'docs/ai-native/other-team-gap-ownership.md'
        ? 'ownership-adjudication'
        : 'scanner-configuration';
    return { domain, path, sha256: sha256Bytes(readFileSync(target)) };
  });
  const binding = {
    schema_version: 1 as const,
    algorithm: 'sha256-derived-domain-path-content-v2' as const,
    domains,
  };
  return { ...binding, bound_sha256: canonicalSha256(binding) };
}

/** Inventory-only configuration domain used in frozen scanner metadata.
 * Downstream adjudication, evidence, coordinates, and checked projections are
 * intentionally absent so one baseline cut does not become self-invalidating
 * while those artifacts are derived from it. The full runtime pin continues to
 * bind the complete machine-derived integrity domain above. */
export function computeInventoryScannerConfigurationFingerprint(repoRoot: string): ScannerConfigurationFingerprint {
  return computeScannerConfigurationFingerprint(repoRoot);
}

export function projectScannerConfigurationFingerprint(
  fingerprint: ScannerConfigurationFingerprint,
): ScannerConfigurationFingerprint {
  const wanted = new Set<string>(SCANNER_CONFIGURATION_INPUT_FILES);
  const domains = fingerprint.domains.filter((row) => wanted.has(row.path));
  const paths = domains.map((row) => row.path);
  const missing = SCANNER_CONFIGURATION_INPUT_FILES.filter((path) => !paths.includes(path));
  if (missing.length > 0) {
    throw new Error(`scanner configuration fingerprint is missing inputs: ${missing.join(', ')}`);
  }
  const binding = {
    schema_version: 1 as const,
    algorithm: 'sha256-derived-domain-path-content-v2' as const,
    domains,
  };
  return { ...binding, bound_sha256: canonicalSha256(binding) };
}

function runtimePinBoundaryInputs(pin: RuntimePin): ScannerFingerprintBoundaryInput[] {
  const liveInputs = new Set<string>(SCANNER_CONFIGURATION_INPUT_FILES);
  return [
    ...pin.scanner_configuration_fingerprint.domains.map((row) => ({
      path: row.path,
      ...(!liveInputs.has(row.path) ? { sha256: row.sha256 } : {}),
    })),
    { path: 'bun.lock' },
  ];
}

export function computeEvidenceManifestSetFingerprint(repoRoot: string): EvidenceManifestSetFingerprint {
  const root = resolve(repoRoot);
  const directory = repositoryPath(root, EVIDENCE_MANIFEST_DIRECTORY);
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = `${EVIDENCE_MANIFEST_DIRECTORY}/${name}`;
      const target = repositoryPath(root, path);
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`evidence manifest must be a regular file: ${path}`);
      }
      return { path, sha256: sha256Bytes(readFileSync(target)) };
    });
  const binding = {
    schema_version: 1 as const,
    algorithm: 'sha256-sorted-path-raw-content-v1' as const,
    directory: EVIDENCE_MANIFEST_DIRECTORY,
    file_count: files.length,
    files,
  };
  return { ...binding, bound_sha256: canonicalSha256(binding) };
}

export function deriveRuntimePinV3Bindings(
  repoRoot: string,
  scannedProductCombo: Readonly<Record<string, string>>,
): Pick<RuntimePin, 'scanner_input_fingerprint' | 'scanner_configuration_fingerprint' | 'governance_artifacts'> {
  const root = resolve(repoRoot);
  return {
    scanner_input_fingerprint: computeScannerProductTreeFingerprint(root, scannedProductCombo),
    scanner_configuration_fingerprint: computeScannerConfigurationFingerprint(root),
    governance_artifacts: {
      baseline_approvals: {
        path: BASELINE_APPROVALS_PATH,
        sha256: sha256Bytes(readFileSync(repositoryPath(root, BASELINE_APPROVALS_PATH))),
      },
      runtime_profile_terminals: {
        path: RUNTIME_PROFILE_TERMINALS_PATH,
        sha256: sha256Bytes(readFileSync(repositoryPath(root, RUNTIME_PROFILE_TERMINALS_PATH))),
      },
      evidence_manifests: computeEvidenceManifestSetFingerprint(root),
    },
  };
}

export function deriveOrchestratorAncestryProof(
  repoRoot: string,
  requiredAncestor: string,
  scannedProductCombo: Readonly<Record<string, string>>,
): OrchestratorAncestryProof {
  if (!commitSchema.safeParse(requiredAncestor).success) {
    throw new Error(`required orchestrator ancestor is not a full commit SHA: ${requiredAncestor}`);
  }
  const verifiedGitlink = scannedProductCombo.orchestrator;
  if (!verifiedGitlink || !commitSchema.safeParse(verifiedGitlink).success) {
    throw new Error(`scanned product combo has no valid orchestrator gitlink: ${String(verifiedGitlink)}`);
  }
  const result = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', requiredAncestor, verifiedGitlink],
    { cwd: resolve(repoRoot, 'packages/orchestrator'), stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `orchestrator gitlink is not derived from the required ancestor: `
      + `required=${requiredAncestor} gitlink=${verifiedGitlink}${stderr ? ` (${stderr})` : ''}`,
    );
  }
  return {
    schema_version: 1,
    required_ancestor: requiredAncestor,
    verified_gitlink: verifiedGitlink,
    verification: 'git-merge-base-is-ancestor',
  };
}

export function immutablePinProvesOrchestratorAncestry(
  pin: RuntimePin,
  requiredAncestor: string,
  orchestratorGitlink: string,
): boolean {
  const proof = pin.orchestrator_ancestry_proof;
  return proof.required_ancestor === requiredAncestor
    && proof.verified_gitlink === orchestratorGitlink
    && pin.scanned_product_combo.orchestrator === orchestratorGitlink;
}

export function resolveRuntimePinSource(_repoRoot: string, explicit?: string): string {
  if (explicit !== undefined && explicit !== RUNTIME_PIN_PATH) {
    throw new Error(`runtime pin path is code-owned and fixed at ${RUNTIME_PIN_PATH}`);
  }
  return RUNTIME_PIN_PATH;
}

export function loadRuntimePin(repoRoot: string, pinSource: string): RuntimePin {
  if (pinSource !== RUNTIME_PIN_PATH) {
    throw new Error(`runtime pin path is code-owned and fixed at ${RUNTIME_PIN_PATH}`);
  }
  const target = repositoryPath(repoRoot, pinSource);
  return runtimePinSchema.parse(JSON.parse(readFileSync(target, 'utf8')) as unknown) as RuntimePin;
}

export function assertPinnedGovernanceArtifact(
  repoRoot: string,
  pinSource: string,
  key: 'baseline_approvals' | 'runtime_profile_terminals',
): { path: string; governanceVerification: GovernanceVerification } {
  const pin = loadRuntimePin(repoRoot, pinSource);
  const expected = pin.governance_artifacts[key];
  const target = repositoryPath(repoRoot, expected.path);
  const actual = sha256Bytes(readFileSync(target));
  if (actual !== expected.sha256) {
    const label = key === 'baseline_approvals' ? 'baseline approvals' : 'runtime profile terminals';
    throw new Error(`pinned ${label} SHA-256 mismatch: expected=${expected.sha256} actual=${actual}`);
  }
  return {
    path: expected.path,
    governanceVerification: mergeGovernanceVerifications([
      verifyGovernanceArtifact(repoRoot, RUNTIME_PIN_PATH),
      verifyGovernanceArtifact(repoRoot, expected.path),
    ]),
  };
}

export function assertPinnedEvidenceManifestSet(repoRoot: string, pinSource: string): void {
  const pin = loadRuntimePin(repoRoot, pinSource);
  const actual = computeEvidenceManifestSetFingerprint(repoRoot);
  const expected = pin.governance_artifacts.evidence_manifests;
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(
      `pinned evidence manifest set SHA-256 mismatch: expected=${expected.bound_sha256} actual=${actual.bound_sha256}`,
    );
  }
}

export interface RuntimePinObservations {
  pin: RuntimePin;
  expectedBunVersion: string;
  bunVersionMatches: boolean;
  scannerInputFingerprintMatches: boolean;
  scannerConfigurationFingerprintMatches: boolean;
  reasonCodes: string[];
}

export function observeRuntimePin(repoRoot: string, pinSource: string): RuntimePinObservations {
  const pin = loadRuntimePin(repoRoot, pinSource);
  const liveProduct = computeScannerProductTreeFingerprint(
    repoRoot,
    pin.scanned_product_combo,
    runtimePinBoundaryInputs(pin),
  );
  const productMatches = stableStringify(liveProduct) === stableStringify(pin.scanner_input_fingerprint);
  const liveConfiguration = computeScannerConfigurationFingerprint(repoRoot);
  const pinnedConfiguration = projectScannerConfigurationFingerprint(pin.scanner_configuration_fingerprint);
  const configurationMatches = stableStringify(liveConfiguration) === stableStringify(pinnedConfiguration);
  const bunVersionMatches = pin.runtime_environment.bun_version === Bun.version;
  const reasonCodes = [
    ...(!bunVersionMatches ? ['formal-bun-version-mismatch'] : []),
    ...(!productMatches ? ['formal-scanner-input-fingerprint-mismatch'] : []),
    ...(!configurationMatches ? ['formal-scanner-configuration-fingerprint-mismatch'] : []),
  ];
  return {
    pin,
    expectedBunVersion: pin.runtime_environment.bun_version,
    bunVersionMatches,
    scannerInputFingerprintMatches: productMatches,
    scannerConfigurationFingerprintMatches: configurationMatches,
    reasonCodes,
  };
}
