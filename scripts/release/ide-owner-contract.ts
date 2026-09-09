// Consumer adapter for the public forgeax-ide release/contract.json v1 semantics.
// Studio owns orchestration only; IDE owns candidate production and publication.
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const IDE_RELEASE_REPOSITORY = 'ForgeaX-Games/forgeax-ide';
export const STUDIO_PRODUCT_RELEASE_REPOSITORY = 'ForgeaX-Games/forgeax-studio';
export const IDE_INTEGRATION_REPOSITORY = 'ForgeaX-Games/forgeax-studio';
export const IDE_RELEASE_WORKFLOW = 'release.yml';
export const IDE_RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';
export const IDE_CANDIDATE_SCHEMA = 'forgeax-ide-release-candidate/v1';
export const IDE_PLATFORM_SCHEMA = 'forgeax-ide-platform-evidence/v1';
export const IDE_RECOVERY_SCHEMA = 'forgeax-ide-release-recovery/v1';
export const IDE_RELEASE_PLATFORMS = ['macos-arm64', 'macos-x64', 'windows-x64'] as const;
const IDE_PLATFORM_TRANSPORT = {
  'macos-arm64': { targetTriple: 'aarch64-apple-darwin', artifactLogicalIds: ['macos-arm64-dmg'] },
  'macos-x64': { targetTriple: 'x86_64-apple-darwin', artifactLogicalIds: ['macos-x64-dmg'] },
  'windows-x64': { targetTriple: 'x86_64-pc-windows-msvc', artifactLogicalIds: ['windows-x64-msi', 'windows-x64-nsis'] },
} as const;

export type ReleaseIntentName = 'dry-run' | 'publish';
export type ReleaseIntent = {
  version: string;
  intent: ReleaseIntentName;
  ideSourceTag: string;
  ideRevision: string;
  integrationRevision: string;
  sidecarCandidateManifestUrl: string;
  sidecarCandidateManifestSha256: string;
  mirror: boolean;
};

type UnknownRecord = Record<string, unknown>;

type FileRecord = {
  logicalId: string;
  fileName: string;
  mediaType: string;
  sha256: string;
  size: number;
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`missing or invalid ${key}`);
  return value;
}

function requireString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing or invalid ${key}`);
  return value;
}

function requireBoolean(record: UnknownRecord, key: string, fallback = false): boolean {
  const value = record[key];
  if (value === undefined || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`invalid boolean ${key}`);
}

function assertKeys(record: UnknownRecord, name: string, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${name} fields do not match the IDE public schema`);
  }
}

function assertSemver(version: string): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`version must be an exact semver: ${version}`);
  }
}

function assertRevision(name: string, revision: string): void {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`${name} must be a lowercase 40-character commit SHA`);
}

function assertIdeSourceTag(version: string, tag: string): void {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^ide-source-v${escapedVersion}-r[1-9]\\d*$`).test(tag)) {
    throw new Error(`ide_source_tag must match ide-source-v${version}-rN`);
  }
}

function assertDigest(name: string, digest: string): void {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function assertImmutableHttpsUrl(name: string, value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an unauthenticated immutable HTTPS URL`);
  }
}

export function resolveReleaseIntent(options: {
  eventName: string;
  event: unknown;
  integrationRevision: string;
  scheduledVersion?: string;
  scheduledIdeSourceTag?: string;
  scheduledIdeRevision?: string;
  scheduledSidecarManifestUrl?: string;
  scheduledSidecarManifestSha256?: string;
}): ReleaseIntent {
  if (!isRecord(options.event)) throw new Error('GitHub event payload must be an object');
  let source: UnknownRecord;
  if (options.eventName === 'workflow_dispatch') {
    source = isRecord(options.event.inputs) ? options.event.inputs : {};
  } else if (options.eventName === 'repository_dispatch') {
    source = isRecord(options.event.client_payload) ? options.event.client_payload : {};
  } else if (options.eventName === 'schedule') {
    source = {
      version: options.scheduledVersion,
      ide_source_tag: options.scheduledIdeSourceTag,
      ide_revision: options.scheduledIdeRevision,
      sidecar_candidate_manifest_url: options.scheduledSidecarManifestUrl,
      sidecar_candidate_manifest_sha256: options.scheduledSidecarManifestSha256,
      intent: 'dry-run',
      mirror: false,
    };
  } else {
    throw new Error(`unsupported release event: ${options.eventName}`);
  }

  const version = requireString(source, 'version');
  const ideSourceTag = requireString(source, 'ide_source_tag');
  const ideRevision = requireString(source, 'ide_revision');
  const sidecarCandidateManifestUrl = requireString(source, 'sidecar_candidate_manifest_url');
  const sidecarCandidateManifestSha256 = requireString(source, 'sidecar_candidate_manifest_sha256');
  const intentValue = source.intent === undefined || source.intent === '' ? 'dry-run' : source.intent;
  if (intentValue !== 'dry-run' && intentValue !== 'publish') throw new Error('intent must be dry-run or publish');
  assertSemver(version);
  assertIdeSourceTag(version, ideSourceTag);
  assertRevision('ide_revision', ideRevision);
  assertRevision('integration_revision', options.integrationRevision);
  assertImmutableHttpsUrl('sidecar_candidate_manifest_url', sidecarCandidateManifestUrl);
  assertDigest('sidecar_candidate_manifest_sha256', sidecarCandidateManifestSha256);
  const mirror = intentValue === 'publish' && requireBoolean(source, 'mirror');
  return {
    version,
    intent: intentValue,
    ideSourceTag,
    ideRevision,
    integrationRevision: options.integrationRevision,
    sidecarCandidateManifestUrl,
    sidecarCandidateManifestSha256,
    mirror,
  };
}

export function missingReleaseSecrets(intent: ReleaseIntentName, mirror: boolean, env: NodeJS.ProcessEnv): string[] {
  const required = ['INTERNAL_TOKEN'];
  if (intent === 'publish' && mirror) required.push('MIRROR_TOKEN');
  return required.filter((name) => !env[name]);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function candidateDigest(candidate: UnknownRecord): string {
  const { digest: _digest, ...material } = candidate;
  return createHash('sha256').update(Buffer.from(canonical(material))).digest('hex');
}

function findFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? findFiles(path) : entry.isFile() ? [path] : [];
  });
}

function parseFileRecord(value: unknown, owner: string): FileRecord {
  if (!isRecord(value)) throw new Error(`${owner} file record is invalid`);
  assertKeys(value, `${owner} file`, ['logicalId', 'fileName', 'mediaType', 'sha256', 'size']);
  const logicalId = requireString(value, 'logicalId');
  const fileName = requireString(value, 'fileName');
  const mediaType = requireString(value, 'mediaType');
  const sha256 = requireString(value, 'sha256');
  if (basename(fileName) !== fileName || !/^[a-z0-9][a-z0-9-]*$/.test(logicalId)) throw new Error(`${owner} file identity is invalid`);
  assertDigest(`${owner} file digest`, sha256);
  if (!Number.isSafeInteger(value.size) || Number(value.size) <= 0) throw new Error(`${owner} file size is invalid`);
  return { logicalId, fileName, mediaType, sha256, size: Number(value.size) };
}

function verifyDeclaredFile(record: FileRecord, files: readonly string[], owner: string): string {
  const matches = files.filter((path) => basename(path) === record.fileName);
  if (matches.length !== 1 || statSync(matches[0]).size !== record.size || sha256File(matches[0]) !== record.sha256) {
    throw new Error(`${owner} transport bytes mismatch: ${record.fileName}`);
  }
  return matches[0];
}

export type VerifyCandidateOptions = ReleaseIntent & {
  orchestrationId: string;
  candidatePath: string;
  assetsDirectory: string;
  evidenceDirectory: string;
  recoveryJournalPath: string;
  tag: string;
  publisherRunId: string;
  publisherRunAttempt: number;
};

export function verifyIdeReleaseCandidate(options: VerifyCandidateOptions): { candidateDigest: string } {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(options.orchestrationId) || options.orchestrationId.includes('--')) {
    throw new Error('invalid orchestration ID');
  }
  if (!/^[1-9]\d*$/.test(options.publisherRunId) || !Number.isInteger(options.publisherRunAttempt) || options.publisherRunAttempt < 1) {
    throw new Error('invalid observed publisher run identity');
  }
  if (options.tag !== `v${options.version}`) throw new Error('Studio product release tag does not match version');

  const candidateValue: unknown = JSON.parse(readFileSync(options.candidatePath, 'utf8'));
  if (!isRecord(candidateValue)) throw new Error('candidate must be an object');
  assertKeys(candidateValue, 'candidate', [
    'schema', 'digest', 'orchestrationId', 'mode', 'source', 'target', 'publisher', 'sidecarManifest', 'platforms',
  ]);
  const digest = requireString(candidateValue, 'digest');
  assertDigest('candidate digest', digest);
  if (candidateValue.schema !== IDE_CANDIDATE_SCHEMA || candidateValue.orchestrationId !== options.orchestrationId ||
    candidateValue.mode !== options.intent || candidateDigest(candidateValue) !== digest) {
    throw new Error('candidate shape, mode, orchestration, or digest mismatch');
  }

  const source = requireRecord(candidateValue, 'source');
  assertKeys(source, 'candidate source', ['ide', 'integration']);
  const ideSource = requireRecord(source, 'ide');
  const integrationSource = requireRecord(source, 'integration');
  assertKeys(ideSource, 'IDE source', ['repository', 'revision']);
  assertKeys(integrationSource, 'integration source', ['repository', 'revision']);
  if (ideSource.repository !== IDE_RELEASE_REPOSITORY || ideSource.revision !== options.ideRevision ||
    integrationSource.repository !== IDE_INTEGRATION_REPOSITORY || integrationSource.revision !== options.integrationRevision) {
    throw new Error('candidate source binding mismatch');
  }

  const target = requireRecord(candidateValue, 'target');
  assertKeys(target, 'candidate target', ['repository', 'tag', 'commit']);
  if (target.repository !== STUDIO_PRODUCT_RELEASE_REPOSITORY || target.tag !== options.tag || target.commit !== options.integrationRevision) {
    throw new Error('candidate target binding mismatch');
  }

  const publisher = requireRecord(candidateValue, 'publisher');
  assertKeys(publisher, 'candidate publisher', ['workflowPath', 'workflowRunId', 'workflowRunAttempt', 'workflowDefinitionRevision']);
  if (publisher.workflowPath !== IDE_RELEASE_WORKFLOW_PATH || publisher.workflowRunId !== options.publisherRunId ||
    publisher.workflowRunAttempt !== String(options.publisherRunAttempt) || publisher.workflowDefinitionRevision !== options.ideRevision) {
    throw new Error('candidate publisher binding mismatch');
  }

  const sidecar = requireRecord(candidateValue, 'sidecarManifest');
  assertKeys(sidecar, 'candidate sidecar manifest', ['url', 'sha256']);
  if (sidecar.url !== options.sidecarCandidateManifestUrl || sidecar.sha256 !== options.sidecarCandidateManifestSha256) {
    throw new Error('candidate sidecar manifest binding mismatch');
  }

  if (!Array.isArray(candidateValue.platforms) || candidateValue.platforms.length !== IDE_RELEASE_PLATFORMS.length) {
    throw new Error('candidate platform roster mismatch');
  }
  const assetFiles = findFiles(resolve(options.assetsDirectory));
  const evidenceFiles = findFiles(resolve(options.evidenceDirectory));
  const declaredAssets: FileRecord[] = [];
  const declaredEvidence: FileRecord[] = [];
  const seenPlatforms = new Set<string>();

  for (const value of candidateValue.platforms) {
    if (!isRecord(value)) throw new Error('platform record is invalid');
    assertKeys(value, 'platform record', ['logicalId', 'targetTriple', 'trust', 'artifacts', 'evidence']);
    const logicalId = requireString(value, 'logicalId');
    if (!(IDE_RELEASE_PLATFORMS as readonly string[]).includes(logicalId) || seenPlatforms.has(logicalId)) {
      throw new Error(`unexpected or duplicate platform: ${logicalId}`);
    }
    seenPlatforms.add(logicalId);
    const transport = IDE_PLATFORM_TRANSPORT[logicalId as keyof typeof IDE_PLATFORM_TRANSPORT];
    const expectedTrust = options.intent === 'dry-run' ? 'suppressed-not-applicable' : 'unsigned-user-authorized';
    if (value.targetTriple !== transport.targetTriple || value.trust !== expectedTrust ||
      !Array.isArray(value.artifacts) || !Array.isArray(value.evidence) || value.evidence.length !== 1) {
      throw new Error(`platform transport declaration is invalid: ${logicalId}`);
    }
    const artifacts = value.artifacts.map((item) => parseFileRecord(item, logicalId));
    const evidenceRecords = value.evidence.map((item) => parseFileRecord(item, logicalId));
    if (JSON.stringify(artifacts.map((item) => item.logicalId).sort()) !== JSON.stringify([...transport.artifactLogicalIds].sort()) ||
      evidenceRecords[0].logicalId !== `${logicalId}-evidence`) {
      throw new Error(`platform fileName/logicalId association is invalid: ${logicalId}`);
    }
    artifacts.forEach((record) => verifyDeclaredFile(record, assetFiles, `${logicalId} asset`));
    const evidencePath = verifyDeclaredFile(evidenceRecords[0], evidenceFiles, `${logicalId} evidence`);
    const evidenceValue: unknown = JSON.parse(readFileSync(evidencePath, 'utf8'));
    if (!isRecord(evidenceValue)) throw new Error(`platform evidence is invalid: ${logicalId}`);
    assertKeys(evidenceValue, 'platform evidence', ['schema', 'orchestrationId', 'mode', 'logicalId', 'targetTriple', 'trust', 'signer', 'checks', 'artifacts']);
    if (evidenceValue.schema !== IDE_PLATFORM_SCHEMA || evidenceValue.orchestrationId !== options.orchestrationId ||
      evidenceValue.mode !== options.intent || evidenceValue.logicalId !== logicalId || evidenceValue.targetTriple !== value.targetTriple ||
      evidenceValue.trust !== expectedTrust || canonical(evidenceValue.artifacts) !== canonical(value.artifacts)) {
      throw new Error(`platform evidence binding mismatch: ${logicalId}`);
    }
    if (!Array.isArray(evidenceValue.checks) || evidenceValue.checks.length === 0) throw new Error(`platform checks are missing: ${logicalId}`);
    if (options.intent === 'dry-run') {
      if (evidenceValue.signer !== null || evidenceValue.checks.some((check) => !isRecord(check) || check.status !== 'suppressed-not-applicable')) {
        throw new Error(`dry-run platform trust is not suppressed/not-applicable: ${logicalId}`);
      }
    } else if (evidenceValue.signer !== null || evidenceValue.checks.some((check) => !isRecord(check) || check.status !== 'unsigned-user-authorized')) {
      throw new Error(`publish platform unsigned authorization evidence is invalid: ${logicalId}`);
    }
    declaredAssets.push(...artifacts);
    declaredEvidence.push(...evidenceRecords);
  }
  if (assetFiles.length !== declaredAssets.length || evidenceFiles.length !== declaredEvidence.length) {
    throw new Error('transport contains undeclared files');
  }
  if (new Set(declaredAssets.map((file) => file.fileName)).size !== declaredAssets.length ||
    new Set(declaredAssets.map((file) => file.logicalId)).size !== declaredAssets.length) {
    throw new Error('flat owner asset fileName/logicalId association is ambiguous');
  }

  const recoveryLines = readFileSync(options.recoveryJournalPath, 'utf8').trim().split('\n').filter(Boolean);
  if (recoveryLines.length === 0) throw new Error('recovery journal is empty');
  const recovery = recoveryLines.map((line) => JSON.parse(line) as unknown);
  for (const value of recovery) {
    if (!isRecord(value)) throw new Error('recovery record is invalid');
    assertKeys(value, 'recovery', ['schema', 'orchestrationId', 'candidateDigest', 'mode', 'state', 'mutation', 'verified', 'releaseId', 'releaseUrl']);
    if (value.schema !== IDE_RECOVERY_SCHEMA || value.orchestrationId !== options.orchestrationId ||
      value.candidateDigest !== digest || value.mode !== options.intent || value.verified !== true) {
      throw new Error('recovery binding mismatch');
    }
  }
  const terminal = recovery.at(-1) as UnknownRecord;
  if (options.intent === 'dry-run') {
    if (recovery.length !== 1 || terminal.state !== 'candidate-verified' || terminal.mutation !== 'suppressed' ||
      terminal.releaseId !== null || terminal.releaseUrl !== null) {
      throw new Error('dry-run recovery does not prove suppressed mutation');
    }
  } else if (terminal.state !== 'completed' || terminal.mutation !== 'published' ||
    !Number.isSafeInteger(terminal.releaseId) || typeof terminal.releaseUrl !== 'string' || terminal.releaseUrl.length === 0) {
    throw new Error('publish recovery is not terminal completed/published evidence');
  }

  return { candidateDigest: digest };
}

function output(values: Record<string, string | boolean | number>): void {
  const text = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    if (command === 'resolve-intent') {
      const eventPath = option('event') ?? process.env.GITHUB_EVENT_PATH;
      if (!eventPath) throw new Error('event payload path is required');
      const intent = resolveReleaseIntent({
        eventName: option('event-name') ?? process.env.GITHUB_EVENT_NAME ?? '',
        event: JSON.parse(readFileSync(eventPath, 'utf8')),
        integrationRevision: option('integration-revision') ?? process.env.GITHUB_SHA ?? '',
        scheduledVersion: process.env.SCHEDULED_VERSION,
        scheduledIdeSourceTag: process.env.SCHEDULED_IDE_SOURCE_TAG,
        scheduledIdeRevision: process.env.SCHEDULED_IDE_REVISION,
        scheduledSidecarManifestUrl: process.env.SCHEDULED_SIDECAR_MANIFEST_URL,
        scheduledSidecarManifestSha256: process.env.SCHEDULED_SIDECAR_MANIFEST_SHA256,
      });
      const missing = missingReleaseSecrets(intent.intent, intent.mirror, process.env);
      if (missing.length > 0) throw new Error(`missing required release secrets: ${missing.join(', ')}`);
      output({
        version: intent.version,
        intent: intent.intent,
        ide_source_tag: intent.ideSourceTag,
        ide_revision: intent.ideRevision,
        integration_revision: intent.integrationRevision,
        sidecar_candidate_manifest_url: intent.sidecarCandidateManifestUrl,
        sidecar_candidate_manifest_sha256: intent.sidecarCandidateManifestSha256,
        mirror: intent.mirror,
      });
    } else if (command === 'verify-candidate') {
      const required = (name: string): string => option(name) ?? (() => { throw new Error(`--${name} is required`); })();
      const result = verifyIdeReleaseCandidate({
        version: required('version'),
        intent: required('intent') as ReleaseIntentName,
        ideRevision: required('ide-revision'),
        integrationRevision: required('integration-revision'),
        sidecarCandidateManifestUrl: required('sidecar-candidate-manifest-url'),
        sidecarCandidateManifestSha256: required('sidecar-candidate-manifest-sha256'),
        mirror: false,
        orchestrationId: required('orchestration-id'),
        tag: required('tag'),
        publisherRunId: required('publisher-run-id'),
        publisherRunAttempt: Number(required('publisher-run-attempt')),
        candidatePath: required('candidate'),
        assetsDirectory: required('assets'),
        evidenceDirectory: required('evidence'),
        recoveryJournalPath: required('recovery'),
      });
      output({ candidate_digest: result.candidateDigest, ready: true });
    } else {
      throw new Error(`unknown command: ${command ?? ''}`);
    }
  } catch (error) {
    console.error(`IDE_RELEASE_CONTRACT: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(3);
  }
}
