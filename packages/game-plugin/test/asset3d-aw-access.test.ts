import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AW_PUBLIC_SERVICE_ROOT,
  normalizeAssetLibraryServiceRoot,
  resolveAssetLibrarySelection,
} from '../extensions/asset3d/src/aw-access';
import { AW_CREDENTIAL_SCHEMA, AW_KEY_ENV, acquireAwKey, readAwCredential, writeAwCredential } from '../extensions/asset3d/src/credentials';

const roots: string[] = [];
const previousKey = process.env[AW_KEY_ENV];
const previousBase = process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
const previousLibrary = process.env.FORGEAX_ASSET_LIBRARY;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  if (previousKey === undefined) delete process.env[AW_KEY_ENV];
  else process.env[AW_KEY_ENV] = previousKey;
  if (previousBase === undefined) delete process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
  else process.env.FORGEAX_ASSET_LIBRARY_BASE_URL = previousBase;
  if (previousLibrary === undefined) delete process.env.FORGEAX_ASSET_LIBRARY;
  else process.env.FORGEAX_ASSET_LIBRARY = previousLibrary;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-aw-access-'));
  roots.push(root);
  return root;
}

describe('EA Asset3D access', () => {
  test('normalizes either gateway or documented service URL exactly once', () => {
    const expected = 'http://gateway.example.test/root/trpc.oasismetric.omcontentserver.http';
    expect(normalizeAssetLibraryServiceRoot('http://gateway.example.test/root')).toBe(expected);
    expect(normalizeAssetLibraryServiceRoot(expected)).toBe(expected);
    expect(normalizeAssetLibraryServiceRoot(`${expected}/HybridSearch`)).toBe(expected);
  });

  test('defaults to public AW and requires an explicit EA gateway', () => {
    delete process.env.FORGEAX_ASSET_LIBRARY_BASE_URL;
    delete process.env.FORGEAX_ASSET_LIBRARY;
    expect(resolveAssetLibrarySelection()).toEqual({
      library: 'aw',
      serviceRoot: DEFAULT_AW_PUBLIC_SERVICE_ROOT,
    });
    expect(() => resolveAssetLibrarySelection({ library: 'ea' })).toThrow(
      'FORGEAX_ASSET_LIBRARY_BASE_URL is required',
    );
    process.env.FORGEAX_ASSET_LIBRARY = 'ea';
    process.env.FORGEAX_ASSET_LIBRARY_BASE_URL = 'https://gateway.example.test';
    expect(resolveAssetLibrarySelection()).toEqual({
      library: 'ea',
      serviceRoot: 'https://gateway.example.test/trpc.oasismetric.omcontentserver.http',
    });
    expect(resolveAssetLibrarySelection({ library: 'aw', baseUrl: 'https://explicit.example.test/service' })).toEqual({
      library: 'aw',
      serviceRoot: 'https://explicit.example.test/service/trpc.oasismetric.omcontentserver.http',
    });
    expect(() => resolveAssetLibrarySelection({ library: 'auto' })).toThrow('asset3d_library_invalid');
  });

  test('writes a private user credential and can roll it back', () => {
    const root = tempRoot();
    const path = join(root, 'credentials', 'aw.json');
    const transaction = writeAwCredential(path, 'test-placeholder');
    expect(transaction.changed).toBeTrue();
    expect(readAwCredential(path)).toBe('test-placeholder');
    expect(readFileSync(path, 'utf8')).toContain(AW_CREDENTIAL_SCHEMA);
    transaction.rollback();
    expect(() => readFileSync(path)).toThrow();
  });

  test('rejects permissive and symlink credential files', () => {
    const root = tempRoot();
    const record = JSON.stringify({ schemaVersion: AW_CREDENTIAL_SCHEMA, provider: 'aw', sandboxKey: 'placeholder' });
    const target = join(root, 'target.json');
    writeFileSync(target, record, { mode: 0o600 });
    chmodSync(target, 0o644);
    expect(() => readAwCredential(target)).toThrow('asset3d_credential_invalid');
    chmodSync(target, 0o600);
    const link = join(root, 'link.json');
    symlinkSync(target, link);
    expect(() => readAwCredential(link)).toThrow('asset3d_credential_invalid');
  });

  test('accepts a key from the dedicated environment without exposing it', async () => {
    const root = tempRoot();
    process.env[AW_KEY_ENV] = 'environment-placeholder';
    const result = await acquireAwKey(join(root, 'missing.json'));
    expect(result).toEqual({ key: 'environment-placeholder', source: 'environment' });
  });

});
