import { createHash } from 'node:crypto';

export type RuntimeArtifactKind = 'report' | 'snapshot';

export const FROZEN_HISTORICAL_RUNTIME_ARTIFACT_SHA256 = {
  report: [
    '9346a0c74eea353da9eb19249d8aa333d44b52b5bec8eb0565d343e5e4ff7b54',
    'c953be17e3d5f59163f25554ee396a204ac10598ffeb0d25db7268138fefd3cd',
  ],
  snapshot: [
    'c1ed282eccd8439a35de9334767c681a52d5afc052cabbc59734fcbf12b8a169',
  ],
} as const satisfies Record<RuntimeArtifactKind, readonly string[]>;

export interface RuntimeArtifactDiagnostic {
  path: string;
  kind: RuntimeArtifactKind;
  sha256: string;
  status: 'frozen-historical-diagnostic' | 'rejected-current-schema';
  contribution: { numerator: 0; migrated_effect_ids: [] };
  reason: string;
}

export interface RawRuntimeArtifactInput {
  path: string;
  rawText: string;
}

export function isRawRuntimeArtifactInput(value: unknown): value is RawRuntimeArtifactInput {
  return value !== null
    && typeof value === 'object'
    && typeof (value as Partial<RawRuntimeArtifactInput>).path === 'string'
    && typeof (value as Partial<RawRuntimeArtifactInput>).rawText === 'string';
}

export function runtimeArtifactSha256(rawText: string): string {
  return createHash('sha256').update(rawText).digest('hex');
}

export function historicalRuntimeArtifactDiagnostic(
  kind: RuntimeArtifactKind,
  path: string,
  rawText: string,
): RuntimeArtifactDiagnostic | undefined {
  const sha256 = runtimeArtifactSha256(rawText);
  if (!(FROZEN_HISTORICAL_RUNTIME_ARTIFACT_SHA256[kind] as readonly string[]).includes(sha256)) {
    return undefined;
  }
  return {
    path,
    kind,
    sha256,
    status: 'frozen-historical-diagnostic',
    contribution: { numerator: 0, migrated_effect_ids: [] },
    reason: 'content digest is in the code-owned frozen historical artifact set; bytes were not parsed as a consumable entity',
  };
}

export function rejectedRuntimeArtifactDiagnostic(
  kind: RuntimeArtifactKind,
  path: string,
  rawText: string,
): RuntimeArtifactDiagnostic {
  return {
    path,
    kind,
    sha256: runtimeArtifactSha256(rawText),
    status: 'rejected-current-schema',
    contribution: { numerator: 0, migrated_effect_ids: [] },
    reason: 'artifact failed the single current consumer schema and its exact byte digest is not frozen as historical',
  };
}
