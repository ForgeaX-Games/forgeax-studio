import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { checkAssetLibraryAccess, searchLibrary, boundedResponse, publicCandidate } from '../extensions/asset3d/src/aw-access';
import { searchBody, ASSET_TYPES } from '../extensions/asset3d/src/search-contract';
import { writeAwCredential } from '../extensions/asset3d/src/credentials';
import { unpackAsset, manifestFor, parseAsset3dArgs, selectAssetVersion, assertAssetEngineCompatible } from '../extensions/asset3d/src/library';

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function service(handler: (request: Request) => Response | Promise<Response>) {
  const root = mkdtempSync(join(tmpdir(), 'asset-http-')); roots.push(root);
  const credentialFile = join(root, 'credential.json');
  writeAwCredential(credentialFile, 'fixture-key').commit();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler }); servers.push(server);
  return { serviceRoot: server.url.toString().replace(/\/$/, ''), library: 'ea' as const, credentialFile };
}
test('direct HybridSearch uses selected depot and key, preserves explicit candidate IDs', async () => {
  const config = service(async request => {
    expect(new URL(request.url).pathname).toBe('/trpc.oasismetric.omcontentserver.http/HybridSearch');
    expect(request.headers.get('X-Sandbox-Key')).toBe('fixture-key');
    expect(await request.json()).toEqual({ depot_name: 'ea', asset_type: 1,
      content: 'wooden crate', similarity_score: 0.3, page_size: 10 });
    return Response.json({ ret: 0, asset_list: [{ id: 'crate-1', name: 'crate.zip', res_url: 'https://cdn.example.test/crate.zip?download=private' }] });
  });
  expect(await searchLibrary(config, 'wooden crate')).toMatchObject([{
    assetId: 'crate-1', name: 'crate.zip', format: 'zip', downloadUrl: 'https://cdn.example.test/crate.zip?download=private',
  }]);
});
test('valid zero results differs from invalid schema and denied access', async () => {
  let response = Response.json({ ret: 0, asset_list: [] });
  const config = service(() => response.clone() as Response);
  expect(await searchLibrary(config, 'tree')).toEqual([]);
  await expect(checkAssetLibraryAccess(config)).rejects.toThrow('inconclusive');
  response = Response.json({});
  expect(await searchLibrary(config, 'tree')).toEqual([]);
  response = Response.json({ ret: 0 });
  expect(await searchLibrary(config, 'tree')).toEqual([]);
  response = Response.json({ ret: 1 });
  await expect(searchLibrary(config, 'tree')).rejects.toThrow('response_invalid');
  response = Response.json({ asset_list: {} });
  await expect(searchLibrary(config, 'tree')).rejects.toThrow('response_invalid');
  response = new Response('private upstream diagnostics', { status: 401 });
  await expect(searchLibrary(config, 'tree')).rejects.toThrow('asset3d_access_denied');
});
test('API redirects are rejected without forwarding credentials', async () => {
  let hits = 0;
  const target = service(() => { hits++; return Response.json({ asset_list: [] }); });
  const config = service(() => new Response(null, { status: 302, headers: { Location: target.serviceRoot } }));
  await expect(searchLibrary(config, 'tree')).rejects.toThrow('unreachable');
  expect(hits).toBe(0);
});
test('enable discovers exact download origins and strips signed URLs', async () => {
  const config = service(() => Response.json({ asset_list: [{ id: 'one', name: 'tree.zip',
    res_url: 'https://cdn.example.test/tree.zip?secret=private' }] }));
  const result = await checkAssetLibraryAccess(config);
  expect(result.downloadOrigins).toEqual(['https://cdn.example.test:443']);
  expect(JSON.stringify(result)).not.toContain('private');
});
test('bounded response refuses oversized bodies', async () => {
  await expect(boundedResponse(new Response('oversized'), 2)).rejects.toThrow('too_large');
});
test('native Pack helper closure is preserved without executing source', () => {
  const input = {
    'root/model.pack.ts': Buffer.from('throw new Error("do not execute");'),
    'root/geometry-data.ts': Buffer.from('export const geometry = [];'),
    'root/textures/albedo.png': Buffer.from('fixture'),
  };
  const files = unpackAsset(zipSync(input), 'zip');
  expect(Object.keys(files).sort()).toEqual(Object.keys(input).sort());
  const result = manifestFor(files, 'selected-id');
  expect(result.deliveredFormat).toBe('pack');
  expect(result.primary).toBe('selected-id/root/model.pack.ts');
  expect(result.manifest.map(entry => entry.role)).toContain('texture');
});
test('archives reject traversal, ambiguous paths, excessive counts and expansion', () => {
  for (const path of ['../outside.pack.ts', '/absolute.pack.ts', 'C:outside.pack.ts', 'A/../x', 'CON.pack.ts']) {
    expect(() => unpackAsset(zipSync({ [path]: Buffer.from('x') }), 'zip')).toThrow();
  }
  expect(() => unpackAsset(zipSync({ 'A.pack.ts': Buffer.from('x'), 'a.pack.ts': Buffer.from('y') }), 'zip')).toThrow();
  expect(() => unpackAsset(zipSync({ 'x': Buffer.from('x'), 'x/a.pack.ts': Buffer.from('y') }), 'zip')).toThrow();
  const many = Object.fromEntries(Array.from({ length: 1025 }, (_, n) => ['file' + n, Buffer.from('x')]));
  expect(() => unpackAsset(zipSync(many), 'zip')).toThrow();
  const zip = Buffer.from(zipSync({ 'large.pack.ts': Buffer.from('x') }));
  const offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(129 * 1024 * 1024, offset + 24);
  expect(() => unpackAsset(zip, 'zip')).toThrow();
});
test('rejects invalid GLB and unsupported conversion rather than pretending Pack success', () => {
  expect(() => manifestFor({ 'x.glb': Buffer.from('not glb') }, 'asset')).toThrow('glb_invalid');
  expect(() => unpackAsset(Buffer.from('fbx'), 'fbx')).toThrow('format_unsupported');
  expect(() => manifestFor({ 'source.ts': Buffer.from('x') }, 'asset')).toThrow('source_missing');
});
test('minimal command parser requires explicit selected ID and rejects extra switches', () => {
  expect(parseAsset3dArgs(['--query', 'crate', '--asset-id', 'selected', '--json'], true)).toMatchObject({ query: 'crate', assetId: 'selected' });
  expect(() => parseAsset3dArgs(['--query', 'crate'], true)).toThrow();
  expect(() => parseAsset3dArgs(['--query', 'crate', '--output', '/tmp'], false)).toThrow();
});

test('import resolves opaque ID and version from one saved candidate instead of a typed ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-selection-')); roots.push(root);
  const file = join(root, 'candidates.json');
  writeFileSync(file, JSON.stringify({ ok: true, value: { candidates: [
    { assetId: 'crate-aad', name: 'ea/pack/crate.zip', currentVersion: 'v2', versions: [{ versionName: 'v1' }, { versionName: 'v2' }] },
    { assetId: 'tall-aab', name: 'ea/pack/tall-crate.zip', currentVersion: 'v1', versions: [{ versionName: 'v1' }] },
  ] } }));
  expect(parseAsset3dArgs(['--query', 'wooden crate', '--candidate-file', file, '--candidate-name', 'crate.zip'], true))
    .toMatchObject({ assetId: 'crate-aad', versionName: 'v2' });
  expect(parseAsset3dArgs(['--query', 'wooden crate', '--candidate-file', file, '--candidate-name', 'tall-crate.zip'], true))
    .toMatchObject({ assetId: 'tall-aab', versionName: 'v1' });
  expect(() => parseAsset3dArgs(['--candidate-file', file, '--candidate-name', 'crate.zip', '--asset-id', 'crate-aab'], true))
    .toThrow('asset3d_arguments_invalid');
  expect(() => parseAsset3dArgs(['--candidate-file', file, '--candidate-name', 'crate.zip', '--version', 'v3'], true))
    .toThrow('asset3d_version_not_found_in_candidates');
  expect(() => parseAsset3dArgs(['--candidate-file', file, '--candidate-name', 'missing.zip'], true))
    .toThrow('asset3d_candidate_name_not_unique');
  writeFileSync(file, JSON.stringify({ ok: true, value: { candidates: [
    { assetId: 'one', name: 'a/crate.zip' }, { assetId: 'two', name: 'b/crate.zip' },
  ] } }));
  expect(() => parseAsset3dArgs(['--candidate-file', file, '--candidate-name', 'crate.zip'], true))
    .toThrow('asset3d_candidate_name_not_unique');
});

test('search filters follow type applicability, enums and optional content contract', () => {
  for (const assetType of ASSET_TYPES) expect(searchBody('ea', '', { assetType })).toEqual({
    depot_name: 'ea', asset_type: assetType, similarity_score: 0.3, page_size: 10,
  });
  expect(searchBody('ea', '  shed  ', { assetType: 5, category: 'shed', artStyle: 'stylized', themeStyle: 'rural', engineVersion: '0.1.26' })).toEqual({
    depot_name: 'ea', asset_type: 5, content: 'shed', filter: { category: 'shed', art_style: 'stylized', theme_style: 'rural', engine_versions: '0.1.26' }, similarity_score: 0.3, page_size: 10,
  });
  for (const options of [{ assetType: 4 }, { assetType: 3, category: 'x' }, { assetType: 7, artStyle: 'stylized' },
    { assetType: 11, themeStyle: 'rural' }, { artStyle: 'guess' }, { themeStyle: 'guess' }, { engineVersion: '' }]) {
    expect(() => searchBody('ea', '', options)).toThrow();
  }
  expect(() => parseAsset3dArgs(['--asset-type', 'NaN'], false)).toThrow();
  expect(parseAsset3dArgs(['--asset-type', '5', '--engine-version', '0.1.26', '--asset-id', 'one', '--version', 'v1'], true))
    .toMatchObject({ query: '', options: { assetType: 5, engineVersion: '0.1.26' }, versionName: 'v1' });
});

test('candidate metadata and explicit version survive normalization without exposing download URLs', async () => {
  const config = service(() => Response.json({ asset_list: [{ id: 'crate', name: 'crate.zip', file_format: 'ZIP',
    type: 1, description: 'shipping crate', category: ['crate'], art_style: ['voxel art'], theme_style: ['industrial'],
    custom_tags: ['wood'], score: 0.66, extra: { detailed_description: 'Tall crate for warehouses' },
    thumbnail_url: 'https://cdn.example.test/preview.png?signature=preview', current_version: 'v2',
    res_url: 'https://cdn.example.test/new.zip?signature=current-secret', versions: [
      { version_name: 'v1', engine_versions: ['0.1.26'], res_url: 'https://cdn.example.test/old.zip?signature=selected-secret' },
      { version_name: 'v2', engine_versions: ['0.1.34'], res_url: 'https://cdn.example.test/new.zip?signature=current-secret' },
    ] }] }));
  const [candidate] = await searchLibrary(config, 'crate');
  const visible = publicCandidate(candidate!);
  expect(visible).toMatchObject({ description: 'shipping crate', detailedDescription: 'Tall crate for warehouses',
    category: ['crate'], artStyle: ['voxel art'], themeStyle: ['industrial'], currentVersion: 'v2',
    thumbnailUrl: 'https://cdn.example.test/preview.png?signature=preview',
    versions: [{ versionName: 'v1', engineVersions: ['0.1.26'], downloadable: true }, { versionName: 'v2' }] });
  expect(JSON.stringify(visible)).not.toContain('selected-secret');
  expect(JSON.stringify(visible)).not.toContain('current-secret');
  expect(selectAssetVersion(candidate!, 'v1', '0.1.26').downloadUrl).toBe('https://cdn.example.test/old.zip?signature=selected-secret');
  expect(() => selectAssetVersion(candidate!, undefined, '0.1.26')).toThrow('selection_required');
  expect(() => selectAssetVersion(candidate!, 'v2', '0.1.26')).toThrow('selection_required');
  expect(() => selectAssetVersion(candidate!, 'missing')).toThrow('version_not_found');
  expect(() => assertAssetEngineCompatible(candidate!, '0.1.26')).toThrow('asset3d_engine_version_mismatch');
  expect(() => assertAssetEngineCompatible(selectAssetVersion(candidate!, 'v1'), '0.1.26')).not.toThrow();
  expect(() => assertAssetEngineCompatible({ ...candidate!, versions: undefined }, '0.1.26')).not.toThrow();
  expect(() => assertAssetEngineCompatible({ ...candidate!, versions: [{ versionName: 'v2', engineVersions: [] }] }, '0.1.26')).not.toThrow();
});
