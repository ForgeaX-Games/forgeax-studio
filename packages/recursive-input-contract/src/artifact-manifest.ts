export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface ArtifactManifestV1 {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly compressedBytes: number;
  readonly unpackedBytes: number;
  readonly licenseInventory: string;
}

export interface ArtifactManifestError {
  readonly code: string;
  readonly message: string;
}

export type ArtifactManifestValidation =
  | { readonly ok: true; readonly manifest: ArtifactManifestV1 }
  | { readonly ok: false; readonly errors: readonly ArtifactManifestError[] };

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function validateArtifactManifest(value: unknown): ArtifactManifestValidation {
  const manifest = record(value);
  const errors: ArtifactManifestError[] = [];
  const add = (code: string, message: string) => errors.push({ code, message });
  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) add('schema-version-invalid', 'schemaVersion must be 1');
  if (typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(manifest.name)) add('name-invalid', 'name must be a stable artifact identity');
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) add('version-invalid', 'version must be semantic');
  if (typeof manifest.url !== 'string' || !manifest.url.startsWith('https://')) add('url-insecure', 'artifact URL must use HTTPS');
  if (typeof manifest.url === 'string' && /(?:^|[/?_.-])latest(?:[/?_.-]|$)/iu.test(manifest.url)) add('url-mutable', 'artifact URL must not use latest');
  if (typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) add('sha256-invalid', 'sha256 must be 64 lowercase hex characters');
  if (!Number.isSafeInteger(manifest.compressedBytes) || Number(manifest.compressedBytes) <= 0) add('compressed-bytes-invalid', 'compressedBytes must be a positive integer');
  if (!Number.isSafeInteger(manifest.unpackedBytes) || Number(manifest.unpackedBytes) <= 0) add('unpacked-bytes-invalid', 'unpackedBytes must be a positive integer');
  if (typeof manifest.licenseInventory !== 'string'
    || !manifest.licenseInventory
    || manifest.licenseInventory.startsWith('/')
    || manifest.licenseInventory.split(/[\\/]/u).includes('..')) {
    add('license-inventory-invalid', 'licenseInventory must be a contained relative path');
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, manifest: manifest as unknown as ArtifactManifestV1 };
}
