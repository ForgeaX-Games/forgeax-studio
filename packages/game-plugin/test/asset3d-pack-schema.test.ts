import { RELEASE_IDENTITY } from '../src/install/release-manifest';
import { expect, test } from 'bun:test';
import { parseProviderResult } from '../extensions/asset3d/src/schema';
import {
  PROVIDER_RESULT_SCHEMA,
  PROVIDER_RECEIPT_SCHEMA,
  sha256,
} from '../extensions/asset3d/src/constants';

function result(primaryPath = 'source.pack.json') {
  const content = Buffer.from(
    JSON.stringify({ kind: 'internal-text-package', schemaVersion: '2.0.0', assets: [] }),
  );
  const file = {
    path: primaryPath,
    role: 'primary-pack',
    bytes: content.length,
    sha256: sha256(content),
  };
  const digest = 'c'.repeat(64);
  return {
    schemaVersion: PROVIDER_RESULT_SCHEMA,
    total: 1,
    succeeded: 1,
    failed: 0,
    results: [
      {
        status: 'ok',
        queryIndex: 0,
        query: 'scenery',
        provider: 'ea-3d',
        providerAssetId: 'source',
        assetName: 'Scenery',
        deliveredFormat: 'pack',
        primaryPack: file.path,
        sha256: sha256(`${file.path}\0${file.bytes}\0${file.sha256}\n`),
        bytes: file.bytes,
        manifest: [file],
        originSetDigest: digest,
      },
    ],
    receipt: {
      schemaVersion: PROVIDER_RECEIPT_SCHEMA,
      provider: 'ea-3d',
      adapterVersion: RELEASE_IDENTITY.gameVersion,
      originSetDigest: digest,
    },
  };
}
// This parser validates transport receipts only. Authored content is validated by Engine.
test('accepts an explicit Pack transport receipt without fabricating a GLB identity', () => {
  const parsed = parseProviderResult(JSON.stringify(result()), RELEASE_IDENTITY.gameVersion, 'c'.repeat(64));
  expect(parsed.results[0]).toMatchObject({ deliveredFormat: 'pack', primaryPack: 'source.pack.json' });
  expect(parsed.results[0]).not.toHaveProperty('primaryModel');
});
test('preserves native Pack entry and its source dependency without evaluating either', () => {
  const value = result('source.pack.ts');
  const row = value.results[0]!;
  const bytes = Buffer.from('throw new Error("must not execute in transport parser");');
  row.manifest.unshift({ path: 'geometry-data.ts', role: 'metadata', bytes: bytes.length, sha256: sha256(bytes) });
  row.bytes = row.manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  row.sha256 = sha256(row.manifest.map(entry => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join(''));
  const parsed = parseProviderResult(JSON.stringify(value), RELEASE_IDENTITY.gameVersion, 'c'.repeat(64));
  expect(parsed.results[0]).toMatchObject({ deliveredFormat: 'pack', primaryPack: 'source.pack.ts', manifest: row.manifest });
});
test.each(['source.ts', 'source.pack.js', 'source.pack.ts.js', '../source.pack.ts'])(
  'rejects unsupported or escaping native Pack entry %s', (path) => {
    expect(() => parseProviderResult(JSON.stringify(result(path)), RELEASE_IDENTITY.gameVersion, 'c'.repeat(64)))
      .toThrow(/provider_result_invalid/);
  },
);
test.each(['wrong-primary', 'wrong-role', 'wrong-suffix', 'changed-digest', 'legacy-shape'])(
  'rejects ambiguous Pack transport %s',
  (kind) => {
    const value: any = result();
    const row = value.results[0];
    if (kind === 'wrong-primary') row.primaryModel = row.primaryPack;
    if (kind === 'wrong-role') row.manifest[0].role = 'primary-model';
    if (kind === 'wrong-suffix') row.manifest[0].path = 'source.glb';
    if (kind === 'changed-digest') row.sha256 = '0'.repeat(64);
    if (kind === 'legacy-shape') row.deliveredFormat = 'glb';
    expect(() => parseProviderResult(JSON.stringify(value), RELEASE_IDENTITY.gameVersion, 'c'.repeat(64))).toThrow(
      'provider_result_invalid',
    );
  },
);
