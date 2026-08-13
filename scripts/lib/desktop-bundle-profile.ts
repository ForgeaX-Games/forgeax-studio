/**
 * The desktop bundle profile is resolved once at the build boundary. The
 * manifest contract can be materialized in Resources after resource selection
 * is wired; until then, the builder must not claim capabilities it has not
 * actually selected.
 *
 * This module deliberately owns only the profile contract. It does not decide
 * which files a builder copies; resource selection can consume this contract
 * in a later change without creating another profile/config source of truth.
 */

export const DESKTOP_BUNDLE_ENV = 'FORGEAX_DESKTOP_BUNDLE' as const;
export const DESKTOP_BUNDLE_PROFILE_ENV = DESKTOP_BUNDLE_ENV;

export const DESKTOP_BUNDLE_PROFILES = ['lite', 'full'] as const;
export type DesktopBundleProfile = (typeof DESKTOP_BUNDLE_PROFILES)[number];

/** The server role selected for a desktop bundle at the build boundary. */
export type DesktopServerProfile = 'base' | 'auto';

export interface DesktopBundleCapabilities {
  readonly sampleGames: boolean;
  readonly productExtensions: boolean;
  readonly productWorkbenchHost: boolean;
  readonly agentExtensions: boolean;
}

export interface DesktopBundleManifest {
  readonly schemaVersion: 1;
  readonly id: DesktopBundleProfile;
  readonly capabilities: DesktopBundleCapabilities;
}

const CAPABILITY_KEYS = [
  'sampleGames',
  'productExtensions',
  'productWorkbenchHost',
  'agentExtensions',
] as const satisfies readonly (keyof DesktopBundleCapabilities)[];

const PROFILE_CAPABILITIES: Record<DesktopBundleProfile, DesktopBundleCapabilities> = {
  lite: {
    sampleGames: false,
    productExtensions: false,
    productWorkbenchHost: false,
    agentExtensions: true,
  },
  full: {
    sampleGames: true,
    productExtensions: true,
    productWorkbenchHost: true,
    agentExtensions: true,
  },
};

const PROFILE_SERVER_PROFILES: Record<DesktopBundleProfile, DesktopServerProfile> = {
  lite: 'base',
  full: 'auto',
};

function isDesktopBundleProfile(value: unknown): value is DesktopBundleProfile {
  return typeof value === 'string'
    && (DESKTOP_BUNDLE_PROFILES as readonly string[]).includes(value);
}

export function resolveDesktopBundleProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DesktopBundleProfile {
  const value = env[DESKTOP_BUNDLE_ENV]?.trim() || 'full';
  if (!isDesktopBundleProfile(value)) {
    throw new Error(
      `${DESKTOP_BUNDLE_ENV} must be one of ${DESKTOP_BUNDLE_PROFILES.join(', ')}; received ${value}`,
    );
  }
  return value;
}

export function desktopBundleCapabilities(
  profile: DesktopBundleProfile,
): DesktopBundleCapabilities {
  if (!isDesktopBundleProfile(profile)) {
    throw new Error(
      `desktop bundle profile must be one of ${DESKTOP_BUNDLE_PROFILES.join(', ')}; received ${String(profile)}`,
    );
  }
  return { ...PROFILE_CAPABILITIES[profile] };
}

/**
 * Map the user-facing desktop bundle to the server role staged into its payload.
 *
 * This is deliberately a pure mapping: source/dev startup continues to read
 * FORGEAX_SERVER_PROFILE directly, while desktop assembly derives its role from
 * the already-resolved bundle profile.
 */
export function desktopBundleServerProfile(
  profile: DesktopBundleProfile,
): DesktopServerProfile {
  if (!isDesktopBundleProfile(profile)) {
    throw new Error(
      `desktop bundle profile must be one of ${DESKTOP_BUNDLE_PROFILES.join(', ')}; received ${String(profile)}`,
    );
  }
  return PROFILE_SERVER_PROFILES[profile];
}

export function desktopBundleManifest(
  profile: DesktopBundleProfile,
): DesktopBundleManifest {
  return {
    schemaVersion: 1,
    id: profile,
    capabilities: desktopBundleCapabilities(profile),
  };
}

export function assertDesktopBundleManifest(value: unknown): asserts value is DesktopBundleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('desktop bundle manifest must be an object');
  }

  const manifest = value as Record<string, unknown>;
  const expectedManifestKeys = ['schemaVersion', 'id', 'capabilities'].sort();
  const actualManifestKeys = Object.keys(manifest).sort();
  if (actualManifestKeys.length !== expectedManifestKeys.length
    || actualManifestKeys.some((key, index) => key !== expectedManifestKeys[index])) {
    throw new Error('desktop bundle manifest is invalid');
  }
  if (manifest.schemaVersion !== 1 || !isDesktopBundleProfile(manifest.id)) {
    throw new Error('desktop bundle manifest is invalid');
  }

  const capabilities = manifest.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error('desktop bundle manifest capabilities are invalid');
  }

  const capabilityRecord = capabilities as Record<string, unknown>;
  const actualKeys = Object.keys(capabilityRecord).sort();
  const expectedKeys = [...CAPABILITY_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || CAPABILITY_KEYS.some((key) => typeof capabilityRecord[key] !== 'boolean')) {
    throw new Error('desktop bundle manifest capabilities are invalid');
  }

  const expected = PROFILE_CAPABILITIES[manifest.id];
  if (CAPABILITY_KEYS.some((key) => capabilityRecord[key] !== expected[key])) {
    throw new Error('desktop bundle manifest capabilities do not match its id');
  }
}
