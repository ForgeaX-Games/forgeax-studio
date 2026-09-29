import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackBuildCatalog } from '../extensions/asset3d/src/pack-readback';
import { sha256 } from '../extensions/asset3d/src/constants';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const guid = '1073cc16-2533-53dc-a63f-cbd45527b75d';
const source = 'assets/3d/ea-3d/counter/source.pack.ts';
function fixture(options: { kind?: string; productGuid?: string; packageUrl?: string; sourcePath?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pack-readback-')); roots.push(root);
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true });
  const kind = options.kind ?? 'scene';
  const files = {
    'pack-index.json': JSON.stringify([{ guid, kind, sourcePath: options.sourcePath ?? source, packageUrl: options.packageUrl ?? '/assets/product.pack.json' }]),
    'assets/product.pack.json': JSON.stringify({ assets: [{ guid: options.productGuid ?? guid, kind }] }),
    'assets/body.bin': 'binary-fixture',
  };
  const artifacts = Object.entries(files).map(([path, bytes]) => {
    writeFileSync(join(root, 'dist', path), bytes);
    return { path, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
  });
  return { root, build: { schemaVersion: '1.0.0', runtime: { packIndexUrl: 'pack-index.json' }, artifacts } };
}
test('uses built catalog and cooked product identities, not native source parsing', () => {
  const { root, build } = fixture();
  const result = readPackBuildCatalog(root, [source], build);
  expect(result.authority).toBe('engine-build-catalog');
  expect(result.rows).toEqual([{ guid, kind: 'scene', source, sourcePath: source, packageUrl: '/assets/product.pack.json' }]);
  expect(result.verify.artifacts).toBe(3);
});
test('rejects a stale or changed built artifact', () => {
  const { root, build } = fixture();
  writeFileSync(join(root, 'dist', 'assets', 'body.bin'), 'changed-binary');
  expect(() => readPackBuildCatalog(root, [source], build)).toThrow(/engine_pack_build_/);
});
test.each([
  { productGuid: '00000000-0000-0000-0000-000000000000' },
  { packageUrl: '/../secret.json' },
  { packageUrl: '//other-service/product.pack.json' },
  { sourcePath: 'assets/unrelated.pack.ts' },
  { kind: 'texture' },
])('rejects mismatched, escaping, unrelated or non-renderable products %j', (options) => {
  const { root, build } = fixture(options);
  expect(() => readPackBuildCatalog(root, [source], build)).toThrow();
});
