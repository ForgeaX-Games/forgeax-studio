/**
 * The release identity is deliberately a data-only module.
 *
 * `forgeax://release-identity` is read before an install transaction acquires a
 * lock.  Keeping the value in one module means the MCP resource and the installer
 * compare exactly the same fields; neither side performs registry discovery or reads
 * a mutable environment variable.  Artifact digests that are not available at this
 * handoff remain explicit sentinels and are not fabricated by the Game Plugin.
 */

import { ENGINE_COMMIT, ENGINE_SDK_PACKAGE, ENGINE_VERSION, PNPM_VERSION } from '../engine/constants';
import packageManifest from '../../package.json';

export const RELEASE_IDENTITY_SCHEMA = 'forgeax.game.release-identity/1' as const;
export const RELEASE_IDENTITY_URI = 'forgeax://release-identity' as const;
export const RELEASE_IDENTITY_MIME =
  'application/vnd.forgeax.game-release-identity+json' as const;

export interface ReleaseIdentity {
  readonly schema: typeof RELEASE_IDENTITY_SCHEMA;
  readonly gamePackage: '@forgeax/game';
  readonly gameVersion: string;
  readonly gameBin: 'forgeax-game';
  readonly engineSdkPackage: typeof ENGINE_SDK_PACKAGE;
  readonly engineSdkVersion: typeof ENGINE_VERSION;
  readonly engineSourceCommit: typeof ENGINE_COMMIT;
  readonly carrierIntegrity: string;
  readonly sdkManifestDigest: string;
  readonly sdkTreeDigest: string;
  readonly fullZipDigest: string;
  readonly pnpmVersion: typeof PNPM_VERSION;
  readonly releaseDigest: string;
}

/**
 * The Engine commit and npm carrier integrity are the reviewed immutable values for
 * this handoff.  Full/offline SDK digests remain zero sentinels until their
 * publication unit supplies evidence; the release gates reject those as publishable.
 */
export const RELEASE_IDENTITY: ReleaseIdentity = Object.freeze({
  schema: RELEASE_IDENTITY_SCHEMA,
  gamePackage: '@forgeax/game',
  gameVersion: packageManifest.version,
  gameBin: 'forgeax-game',
  engineSdkPackage: ENGINE_SDK_PACKAGE,
  engineSdkVersion: ENGINE_VERSION,
  engineSourceCommit: ENGINE_COMMIT,
  carrierIntegrity:
    'sha512-G5ovsbdzkWWeMfFy3MxVk0qcAvWnZxJnlypMGgxFUDaKr3Wv9uVuhPV88LZ1A9mhFJJSfrE1d5R3WvHgulygRQ==',
  sdkManifestDigest: `sha256:${'0'.repeat(64)}`,
  sdkTreeDigest: `sha256:${'0'.repeat(64)}`,
  fullZipDigest: `sha256:${'0'.repeat(64)}`,
  pnpmVersion: PNPM_VERSION,
  releaseDigest: `sha256:${'0'.repeat(64)}`,
});

const RELEASE_KEYS = Object.freeze([
  'schema',
  'gamePackage',
  'gameVersion',
  'gameBin',
  'engineSdkPackage',
  'engineSdkVersion',
  'engineSourceCommit',
  'carrierIntegrity',
  'sdkManifestDigest',
  'sdkTreeDigest',
  'fullZipDigest',
  'pnpmVersion',
  'releaseDigest',
] as const);

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SHA512_SRI_RE = /^sha512-[A-Za-z0-9+/]{86}={0,2}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Stable, compact JSON used by the MCP resource and evidence transcripts. */
export function releaseIdentityJson(identity: ReleaseIdentity = RELEASE_IDENTITY): string {
  return `${JSON.stringify(identity)}\n`;
}

/**
 * Validate an unbound resource response.  Unknown fields are rejected so a launcher
 * cannot silently omit or substitute a release attribute while looking compatible.
 */
export function validateReleaseIdentity(
  value: unknown,
  expected: ReleaseIdentity = RELEASE_IDENTITY,
): value is ReleaseIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...RELEASE_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return false;
  }
  for (const key of RELEASE_KEYS) {
    if (record[key] !== expected[key]) return false;
  }
  if (!COMMIT_RE.test(String(record.engineSourceCommit))) return false;
  if (!SHA512_SRI_RE.test(String(record.carrierIntegrity))) return false;
  for (const key of ['sdkManifestDigest', 'sdkTreeDigest', 'fullZipDigest', 'releaseDigest'] as const) {
    if (!SHA256_RE.test(String(record[key]))) return false;
  }
  return true;
}

export function assertReleaseIdentity(value: unknown): ReleaseIdentity {
  if (!validateReleaseIdentity(value)) {
    throw new Error('INSTALL_LAUNCH_MISMATCH: forgeax://release-identity does not match this release');
  }
  return value;
}
