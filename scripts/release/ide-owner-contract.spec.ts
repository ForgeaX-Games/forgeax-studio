import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IDE_CANDIDATE_SCHEMA,
  IDE_PLATFORM_SCHEMA,
  IDE_RECOVERY_SCHEMA,
  IDE_RELEASE_REPOSITORY,
  STUDIO_PRODUCT_RELEASE_REPOSITORY,
  resolveReleaseIntent,
  verifyIdeReleaseCandidate,
  type ReleaseIntentName,
} from './ide-owner-contract.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const revision = (character: string): string => character.repeat(40);
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const sidecarUrl = 'https://github.com/ForgeaX-Games/forgeax-server/releases/download/v1.2.3/candidate.json';
const sidecarSha = 'd'.repeat(64);
const orchestrationId = 'studio-123-2';
const ideSourceTag = 'ide-source-v1.2.3-r1';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fixture(mode: ReleaseIntentName = 'dry-run') {
  const root = mkdtempSync(join(tmpdir(), 'ide-owner-contract-'));
  roots.push(root);
  const assets = join(root, 'assets');
  const evidence = join(root, 'evidence');
  mkdirSync(assets);
  mkdirSync(evidence);
  const definitions = [
    { logicalId: 'macos-arm64', targetTriple: 'aarch64-apple-darwin', installers: ['macos-arm64-dmg'] },
    { logicalId: 'macos-x64', targetTriple: 'x86_64-apple-darwin', installers: ['macos-x64-dmg'] },
    { logicalId: 'windows-x64', targetTriple: 'x86_64-pc-windows-msvc', installers: ['windows-x64-msi', 'windows-x64-nsis'] },
  ];
  const platforms = definitions.map((definition) => {
    const artifacts = definition.installers.map((logicalId) => {
      const extension = logicalId.endsWith('dmg') ? 'dmg' : logicalId.endsWith('msi') ? 'msi' : 'exe';
      const fileName = `${logicalId}-ForgeaX.${extension}`;
      const bytes = Buffer.from(`installer-${logicalId}`);
      writeFileSync(join(assets, fileName), bytes);
      return { logicalId, fileName, mediaType: 'application/octet-stream', sha256: sha256(bytes), size: bytes.length };
    });
    const evidenceValue = {
      schema: IDE_PLATFORM_SCHEMA,
      orchestrationId,
      mode,
      logicalId: definition.logicalId,
      targetTriple: definition.targetTriple,
      trust: mode === 'dry-run' ? 'suppressed-not-applicable' : 'unsigned-user-authorized',
      signer: null,
      checks: [{ id: 'native-signing', status: mode === 'dry-run' ? 'suppressed-not-applicable' : 'unsigned-user-authorized' }],
      artifacts,
    };
    const evidenceBytes = `${JSON.stringify(evidenceValue, null, 2)}\n`;
    const evidenceFileName = `${definition.logicalId}.json`;
    writeFileSync(join(evidence, evidenceFileName), evidenceBytes);
    return {
      logicalId: definition.logicalId,
      targetTriple: definition.targetTriple,
      trust: evidenceValue.trust,
      artifacts,
      evidence: [{ logicalId: `${definition.logicalId}-evidence`, fileName: evidenceFileName, mediaType: 'application/json', sha256: sha256(evidenceBytes), size: Buffer.byteLength(evidenceBytes) }],
    };
  });
  const material = {
    schema: IDE_CANDIDATE_SCHEMA,
    orchestrationId,
    mode,
    source: {
      ide: { repository: IDE_RELEASE_REPOSITORY, revision: revision('a') },
      integration: { repository: 'ForgeaX-Games/forgeax-studio', revision: revision('b') },
    },
    target: { repository: STUDIO_PRODUCT_RELEASE_REPOSITORY, tag: 'v1.2.3', commit: revision('b') },
    publisher: {
      workflowPath: '.github/workflows/release.yml',
      workflowRunId: '12345',
      workflowRunAttempt: '2',
      workflowDefinitionRevision: revision('a'),
    },
    sidecarManifest: { url: sidecarUrl, sha256: sidecarSha },
    platforms,
  };
  const candidate = { ...material, digest: sha256(canonical(material)) };
  const candidatePath = join(root, 'candidate.json');
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  const recovery = mode === 'dry-run'
    ? [{ schema: IDE_RECOVERY_SCHEMA, orchestrationId, candidateDigest: candidate.digest, mode, state: 'candidate-verified', mutation: 'suppressed', verified: true, releaseId: null, releaseUrl: null }]
    : [
        { schema: IDE_RECOVERY_SCHEMA, orchestrationId, candidateDigest: candidate.digest, mode, state: 'candidate-verified', mutation: 'suppressed', verified: true, releaseId: null, releaseUrl: null },
        { schema: IDE_RECOVERY_SCHEMA, orchestrationId, candidateDigest: candidate.digest, mode, state: 'completed', mutation: 'published', verified: true, releaseId: 99, releaseUrl: 'https://github.com/ForgeaX-Games/forgeax-studio/releases/tag/v1.2.3' },
      ];
  const recoveryPath = join(root, 'recovery.jsonl');
  writeFileSync(recoveryPath, `${recovery.map((record) => JSON.stringify(record)).join('\n')}\n`);
  const options = {
    version: '1.2.3', intent: mode, ideRevision: revision('a'), integrationRevision: revision('b'), mirror: false,
    sidecarCandidateManifestUrl: sidecarUrl, sidecarCandidateManifestSha256: sidecarSha,
    orchestrationId, tag: 'v1.2.3', publisherRunId: '12345', publisherRunAttempt: 2,
    candidatePath, assetsDirectory: assets, evidenceDirectory: evidence, recoveryJournalPath: recoveryPath,
  };
  return { assets, candidate, candidatePath, recovery, recoveryPath, options };
}

describe('Studio to IDE v1 release contract', () => {
  test('normalizes an omitted repository-dispatch intent to non-mutating dry-run', () => {
    expect(resolveReleaseIntent({
      eventName: 'repository_dispatch',
      event: { client_payload: { version: '1.2.3', ide_source_tag: ideSourceTag, ide_revision: revision('a'), sidecar_candidate_manifest_url: sidecarUrl, sidecar_candidate_manifest_sha256: sidecarSha } },
      integrationRevision: revision('b'),
    })).toMatchObject({ intent: 'dry-run', ideSourceTag });
  });

  test('requires a version-bound, revisioned IDE source tag outside the release trigger namespace', () => {
    expect(() => resolveReleaseIntent({
      eventName: 'workflow_dispatch',
      event: { inputs: { version: '1.2.3', ide_source_tag: 'ide-v1.2.3', ide_revision: revision('a'), sidecar_candidate_manifest_url: sidecarUrl, sidecar_candidate_manifest_sha256: sidecarSha } },
      integrationRevision: revision('b'),
    })).toThrow('ide_source_tag must match ide-source-v1.2.3-rN');
  });

  test('consumes the actual flat IDE candidate transport and suppressed dry-run recovery', () => {
    const data = fixture('dry-run');
    expect(verifyIdeReleaseCandidate(data.options)).toEqual({ candidateDigest: data.candidate.digest });
  });

  test('requires terminal completed/published recovery for publish mode', () => {
    const data = fixture('publish');
    expect(verifyIdeReleaseCandidate(data.options)).toEqual({ candidateDigest: data.candidate.digest });
    writeFileSync(data.recoveryPath, `${JSON.stringify(data.recovery[0])}\n`);
    expect(() => verifyIdeReleaseCandidate(data.options)).toThrow('terminal completed/published');
  });

  test('fails closed when declared installer bytes do not match the flat owner-assets transport', () => {
    const data = fixture('dry-run');
    const fileName = data.candidate.platforms[0].artifacts[0].fileName;
    writeFileSync(join(data.assets, fileName), 'tampered');
    expect(() => verifyIdeReleaseCandidate(data.options)).toThrow('transport bytes mismatch');
  });
});
