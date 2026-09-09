import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateArtifactManifest } from './artifact-manifest.ts';

const valid = {
  schemaVersion: 1 as const,
  name: 'forgeax-engine-assets',
  version: '1.0.0',
  url: 'https://artifacts.example.invalid/forgeax-engine-assets-1.0.0.tar.zst',
  sha256: 'a'.repeat(64),
  compressedBytes: 100,
  unpackedBytes: 200,
  licenseInventory: 'licenses.spdx.json',
};

describe('artifact manifest v1', () => {
  test('publishes one closed JSON schema identity', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, '..', 'schema', 'artifact-manifest.v1.schema.json'), 'utf8'));
    expect(schema.$id).toBe('urn:forgeax:artifact-manifest:v1');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'schemaVersion',
      'name',
      'version',
      'url',
      'sha256',
      'compressedBytes',
      'unpackedBytes',
      'licenseInventory',
    ]);
  });

  test('accepts one immutable HTTPS artifact identity', () => {
    expect(validateArtifactManifest(valid)).toEqual({ ok: true, manifest: valid });
  });

  test('rejects mutable/insecure sources and incomplete integrity metadata', () => {
    const result = validateArtifactManifest({
      ...valid,
      version: 'latest',
      url: 'http://artifacts.example.invalid/latest.tar.zst',
      sha256: 'abc',
      compressedBytes: 0,
      licenseInventory: '../licenses.json',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.errors.map((error) => error.code)).toEqual([
      'version-invalid',
      'url-insecure',
      'url-mutable',
      'sha256-invalid',
      'compressed-bytes-invalid',
      'license-inventory-invalid',
    ]);
  });
});
