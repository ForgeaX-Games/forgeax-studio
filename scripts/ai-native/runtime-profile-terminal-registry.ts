import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalSha256,
  parseRuntimeSnapshotProfile,
  runtimeProfileApprovalSha256,
  validateRuntimeProfileState,
  type RuntimeSnapshotProfile,
} from './runtime-snapshot-core.ts';
import {
  assertPinnedGovernanceArtifact,
  loadRuntimePin,
  type RuntimePin,
} from './runtime-artifact-integrity.ts';
import {
  verifyCommittedAncestorPrefix,
  type AncestorPrefixVerification,
  type GovernanceVerification,
} from './governance-git.ts';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const terminalRecordSchema = z.object({
  sequence: z.number().int().positive(),
  profile_id: z.string().trim().min(1),
  ratified_profile_payload_sha256: sha256Schema,
  terminal_profile_sha256: sha256Schema,
  previous_record_sha256: sha256Schema,
  record_sha256: sha256Schema,
}).strict();

const terminalRegistrySchema = z.object({
  schema_version: z.literal(1),
  hash_algorithm: z.literal('sha256-canonical-record-chain-v1'),
  records: z.array(terminalRecordSchema),
}).strict();

export type RuntimeProfileTerminalRecord = z.infer<typeof terminalRecordSchema>;
export type RuntimeProfileTerminalRegistry = z.infer<typeof terminalRegistrySchema>;

const terminalRegistryHeaderSchema = terminalRegistrySchema.omit({ records: true }).strict();

function recordPayload(record: RuntimeProfileTerminalRecord): Omit<RuntimeProfileTerminalRecord, 'record_sha256'> {
  const { record_sha256: _recordSha256, ...payload } = record;
  return payload;
}

export function parseRuntimeProfileTerminalRegistry(value: unknown): RuntimeProfileTerminalRegistry {
  const registry = terminalRegistrySchema.parse(value);
  const profileIds = new Set<string>();
  let previous = '0'.repeat(64);
  registry.records.forEach((record, index) => {
    if (record.sequence !== index + 1) {
      throw new Error(`runtime profile terminal registry sequence gap at record ${index + 1}`);
    }
    if (profileIds.has(record.profile_id)) {
      throw new Error(`runtime profile terminal registry duplicate profile_id: ${record.profile_id}`);
    }
    if (record.previous_record_sha256 !== previous) {
      throw new Error(`runtime profile terminal registry broken previous_record_sha256 at record ${index + 1}`);
    }
    const expectedRecordSha = canonicalSha256(recordPayload(record));
    if (record.record_sha256 !== expectedRecordSha) {
      throw new Error(`runtime profile terminal registry record SHA-256 mismatch at record ${index + 1}`);
    }
    profileIds.add(record.profile_id);
    previous = record.record_sha256;
  });
  return registry;
}

export function parseRuntimeProfileTerminalRegistryText(text: string): RuntimeProfileTerminalRegistry {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new Error('runtime profile terminal registry is empty');
  const parseLine = (line: string, index: number): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`runtime profile terminal registry line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const header = terminalRegistryHeaderSchema.parse(parseLine(lines[0]!, 0));
  const records = lines.slice(1).map((line, index) => terminalRecordSchema.parse(parseLine(line, index + 1)));
  return parseRuntimeProfileTerminalRegistry({ ...header, records });
}

export function validateRuntimeProfileAgainstTerminalRegistry(
  profile: RuntimeSnapshotProfile,
  registry: RuntimeProfileTerminalRegistry,
): void {
  const record = registry.records.find((candidate) => candidate.profile_id === profile.profile_id);
  const currentTerminal = profile.status === 'approved'
    && profile.approval_record?.pending_user_ratification === false;
  if (record && !currentTerminal) {
    throw new Error(`terminal profile ${profile.profile_id} cannot leave ratified state`);
  }
  if (!record && currentTerminal) {
    throw new Error(`terminal profile ${profile.profile_id} is missing from the append-only registry`);
  }
  if (!record) return;
  if (runtimeProfileApprovalSha256(profile) !== record.ratified_profile_payload_sha256) {
    throw new Error(`terminal profile ${profile.profile_id} payload SHA-256 changed`);
  }
  if (canonicalSha256(profile) !== record.terminal_profile_sha256) {
    throw new Error(`terminal profile ${profile.profile_id} terminal record changed`);
  }
}

export interface LoadedRuntimeProfile {
  profile: RuntimeSnapshotProfile;
  profileRaw: string;
  pin: RuntimePin;
  registry: RuntimeProfileTerminalRegistry;
  governanceVerification: GovernanceVerification;
  ancestorPrefixVerification: AncestorPrefixVerification;
}

export function assertAncestorPrefixPolicy(
  profile: RuntimeSnapshotProfile,
  registry: RuntimeProfileTerminalRegistry,
  verification: AncestorPrefixVerification,
  ci: boolean = process.env.CI === 'true',
): void {
  if (verification.status === 'verified') return;
  const isGenesis = verification.reasons.includes('no-ancestor-copy-genesis')
    && registry.records.length === 0
    && profile.approval_record?.pending_user_ratification === true;
  if (isGenesis) return;
  if (ci) {
    throw new Error(
      `runtime profile ancestor prefix is not verified in CI: ${verification.reasons.join(',')}`,
    );
  }
}

export function loadValidatedRuntimeProfile(
  repoRoot: string,
  profilePath: string,
  pinSource: string,
): LoadedRuntimeProfile {
  const root = resolve(repoRoot);
  const absoluteProfilePath = isAbsolute(profilePath) ? resolve(profilePath) : resolve(root, profilePath);
  const profileRaw = readFileSync(absoluteProfilePath, 'utf8');
  const profile = parseRuntimeSnapshotProfile(JSON.parse(profileRaw) as unknown);
  validateRuntimeProfileState(root, profile);
  const pinned = assertPinnedGovernanceArtifact(root, pinSource, 'runtime_profile_terminals');
  const registryPath = resolve(root, pinned.path);
  const registry = parseRuntimeProfileTerminalRegistryText(readFileSync(registryPath, 'utf8'));
  validateRuntimeProfileAgainstTerminalRegistry(profile, registry);
  const ancestorPrefixVerification = verifyCommittedAncestorPrefix(root, pinned.path);
  assertAncestorPrefixPolicy(profile, registry, ancestorPrefixVerification);
  return {
    profile,
    profileRaw,
    pin: loadRuntimePin(root, pinSource),
    registry,
    governanceVerification: pinned.governanceVerification,
    ancestorPrefixVerification,
  };
}
