import { RELEASE_IDENTITY } from '../src/install/release-manifest';
import { canonicalizeOrigins } from '../extensions/asset3d/src/origins';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_COMMIT, ENGINE_VERSION } from '../src/engine/release';
import { INSTALL_SCHEMA, PROVIDER_RESULT_SCHEMA, sha256 } from '../extensions/asset3d/src/constants';
import {
  abortAsset3d,
  asset3dSearchOutputDir,
  beginAsset3d,
  commitAsset3d,
  doctorAsset3d,
  recordAsset3dProviderResult,
} from '../extensions/asset3d/src/transaction';
import { parseProviderResult } from '../extensions/asset3d/src/schema';
import { installTestCarrier } from './carrier-fixture';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function packageAt(game: string, name: string, manifest: Record<string, unknown>): string {
  const root = join(game, 'node_modules', ...name.split('/'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, version: ENGINE_VERSION, ...manifest })}\n`);
  return root;
}

function gameFixture(): string {
  const game = mkdtempSync(join(tmpdir(), 'forgeax-asset3d-tx-')); roots.push(game);
  mkdirSync(join(game, 'src'), { recursive: true });
  writeFileSync(join(game, 'forge.json'), JSON.stringify({ id: 'fixture', entry: 'src/main.ts' }));
  writeFileSync(join(game, 'package.json'), JSON.stringify({ dependencies: { '@forgeax/engine': ENGINE_VERSION } }));
  writeFileSync(join(game, 'src', 'main.ts'), 'export {};\n');
  const engine = packageAt(game, '@forgeax/engine', { forgeax: { engineCommit: ENGINE_COMMIT } });
  packageAt(game, '@forgeax/engine-devkit', {});
  const carrier = packageAt(game, '@forgeax/engine-sdk', {});
  mkdirSync(join(carrier, 'sdk'), { recursive: true });
  writeFileSync(join(carrier, 'sdk', 'sdk-manifest.json'), JSON.stringify({
    schemaVersion: '1.8.0', sdkVersion: ENGINE_VERSION, engineCommit: ENGINE_COMMIT,
    packages: [{ name: '@forgeax/engine', version: ENGINE_VERSION }, { name: '@forgeax/engine-devkit', version: ENGINE_VERSION }],
  }));
  mkdirSync(join(engine, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(engine, 'dist', 'bin', 'forgeax.mjs'), `
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = realpathSync(process.cwd());
const op = process.argv[2] + '.' + process.argv[3];
const catalogPath = join(root, '.forgeax', 'fixture-catalog.json');
const readCatalog = () => existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : [];
const send = (ok, value, error) => { process.stdout.write(JSON.stringify({ schemaVersion: '1.0.0', command: op, ok, ...(ok ? { value } : { error }) }) + '\\n'); if (!ok) process.exitCode = 1; };
if (op === 'project.build') {
  const dir = join(root, 'assets/3d/ea-3d/tree-1');
  if (existsSync(join(dir, 'fail-engine'))) { console.log(JSON.stringify({command:'build',ok:false,error:{code:'fixture-engine-failure'}})); process.exit(1); }
  const name = readdirSync(dir).find(name => /\\.pack\\.(ts|json)$/.test(name));
  const guid = '019fb7ce-1000-7000-8000-000000000001';
  const files = {'pack-index.json':JSON.stringify([{guid,kind:'scene',sourcePath:'assets/3d/ea-3d/tree-1/'+name,packageUrl:'/assets/result.pack.json'}]),'assets/result.pack.json':JSON.stringify({assets:[{guid,kind:'scene'}]})};
  mkdirSync(join(root,'dist/assets'),{recursive:true});
  const artifacts = Object.entries(files).map(([path,bytes]) => {writeFileSync(join(root,'dist',path),bytes);return {path,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')};});
  console.log(JSON.stringify({artifacts:[],command:'project build',ok:true,value:{schemaVersion:'1.0.0',runtime:{packIndexUrl:'pack-index.json'},artifacts}}));
} else if (op === 'asset.add') {
  const rel = process.argv[4]; const dir = resolve(root, rel);
  if (existsSync(join(dir, 'fail-engine'))) send(false, undefined, { code: 'fixture-engine-failure' });
  else {
    const files = readdirSync(dir).filter((name) => name.endsWith('.glb')).sort();
    const prior = readCatalog().filter((row) => !String(row.sourcePath).startsWith(rel + '/'));
    const subAssets = files.map((name, index) => ({ guid: '019fb7ce-1000-7000-8000-' + String(index + 1).padStart(12, '0'), sourceKey: 'mesh:' + basename(name, '.glb'), kind: 'mesh', name: basename(name, '.glb') }));
    for (const [index, name] of files.entries()) writeFileSync(join(dir, name + '.meta.json'), JSON.stringify({ subAssets: [subAssets[index]] }));
    const rows = subAssets.map((row, index) => ({ ...row, sourcePath: rel + '/' + files[index] }));
    mkdirSync(join(root, '.forgeax'), { recursive: true }); writeFileSync(catalogPath, JSON.stringify([...prior, ...rows]));
    send(true, { root: '.', sourceDirectory: rel, reimportPolicy: 'semantic-only', assets: files.map((name) => ({ source: rel + '/' + name, metaPath: rel + '/' + name + '.meta.json' })) });
  }
} else if (op === 'asset.verify') send(true, { root, assetCount: readCatalog().length });
else if (op === 'asset.list') send(true, readCatalog());
else if (op === 'asset.inspect') { const found = readCatalog().find((row) => row.guid === process.argv[4]); found ? send(true, found) : send(false, undefined, { code: 'asset-not-found' }); }
else send(false, undefined, { code: 'unknown' });
`);
  installTestCarrier(game);
  mkdirSync(join(game, '.forgeax/extensions/asset3d'), { recursive: true });
  writeFileSync(join(game, '.forgeax/extensions/asset3d', 'config.json'), `${JSON.stringify({
    schemaVersion: INSTALL_SCHEMA, adapterVersion: RELEASE_IDENTITY.gameVersion,
    serviceRoot: 'https://example.test/trpc.oasismetric.omcontentserver.http', library: 'ea',
    credentialFile: join(game, 'key.json'), downloadOrigins: ['https://example.test:443'],
    originSetDigest: canonicalizeOrigins(['https://example.test:443']).digest, skills: [],
  }, null, 2)}\n`);
  return game;
}

function carrierPluginRoot(game: string): string {
  return join(game, '.forgeax-test-plugin', 'node_modules', '@forgeax', 'game');
}

function begin(game: string, queries: readonly string[]) {
  return beginAsset3d(game, queries, { carrierPluginRoot: carrierPluginRoot(game) });
}

function commit(options: Parameters<typeof commitAsset3d>[0]) {
  return commitAsset3d({ ...options, carrierPluginRoot: carrierPluginRoot(options.projectRoot) });
}

function doctor(game: string) {
  return doctorAsset3d(game, { carrierPluginRoot: carrierPluginRoot(game) });
}

function providerResult(query: string, files: Readonly<Record<string, { bytes: Buffer; role: string }>>, assetId = 'tree-1') {
  const manifest = Object.entries(files).sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b))).map(([path, file]) => ({ path, role: file.role, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) }));
  const aggregate = sha256(manifest.map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join(''));
  return {
    schemaVersion: PROVIDER_RESULT_SCHEMA, total: 1, succeeded: 1, failed: 0,
    results: [{ status: 'ok', queryIndex: 0, query, provider: 'ea-3d', providerAssetId: assetId,
      assetName: 'Tree', deliveredFormat: 'glb', sha256: aggregate,
      bytes: manifest.reduce((sum, entry) => sum + entry.bytes, 0), primaryModel: 'tree.glb', manifest,
      originSetDigest: canonicalizeOrigins(['https://example.test:443']).digest, downloaded_to: '../../../../ignored', }],
    receipt: {
      schemaVersion: 'forgeax.asset3d-search-receipt/2.0.0', provider: 'ea-3d',
      adapterVersion: RELEASE_IDENTITY.gameVersion, originSetDigest: canonicalizeOrigins(['https://example.test:443']).digest,
    },
  };
}

function populate(game: string, begin: ReturnType<typeof beginAsset3d>, files: Readonly<Record<string, { bytes: Buffer }>>) {
  const root = join(game, '.forgeax/extensions/asset3d/data', 'asset3d-quarantine', begin.output_dir);
  for (const [path, file] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), file.bytes); }
}

describe('Asset3D transaction', () => {
  test.each(['source.pack.ts', 'source.pack.json'])('Pack %s commits, reuses and rolls back failed refresh', (name) => {
    const game = gameFixture();
    const files = { [name]: { bytes: Buffer.from('unchanged authored source'), role: 'primary-pack' } };
    const receipt = (input: typeof files) => {
      const raw = providerResult('counter', input);
      const { primaryModel: _unused, ...row } = raw.results[0]!;
      return JSON.stringify({ ...raw, results: [{ ...row, deliveredFormat: 'pack', primaryPack: name }] });
    };
    for (const reused of [false, true]) {
      const started = begin(game, ['counter']); populate(game, started, files);
      const result = commit({projectRoot:game, execution:started.execution, providerResult:receipt(files)});
      expect(result.failed, JSON.stringify(result)).toBe(0);
      expect((result.results[0] as {reused:boolean}).reused).toBe(reused);
    }
    const broken = {...files, 'fail-engine': {bytes:Buffer.from('intentional failure'), role:'metadata'}};
    const started = begin(game, ['counter']); populate(game, started, broken);
    expect(commit({projectRoot:game, execution:started.execution, providerResult:receipt(broken),refresh:true}).failed).toBe(1);
    expect(readFileSync(join(game,'assets/3d/ea-3d/tree-1',name))).toEqual(files[name]!.bytes);
    expect(existsSync(join(game,'assets/3d/ea-3d/tree-1/fail-engine'))).toBeFalse();
  });
  test('resolves provider output only from a matching begun execution', () => {
    const game = gameFixture();
    const begun = begin(game, ['pine tree', 'stone tower']);

    expect(asset3dSearchOutputDir(game, begun.execution, ['pine tree', 'stone tower']))
      .toBe(begun.output_dir);
    expect(() => asset3dSearchOutputDir(game, begun.execution, ['stone tower', 'pine tree']))
      .toThrow(/query_identity_mismatch/);
    abortAsset3d(game, begun.execution);
    expect(() => asset3dSearchOutputDir(game, begun.execution, ['pine tree', 'stone tower']))
      .toThrow(/execution_state_invalid/);
  });

  test('requires the checked provider receipt identity for every success', () => {
    const files = { 'tree.glb': { bytes: Buffer.from('glTF-fixture'), role: 'primary-model' } };
    const valid = providerResult('pine tree', files);
    expect(parseProviderResult(JSON.stringify(valid), RELEASE_IDENTITY.gameVersion, canonicalizeOrigins(['https://example.test:443']).digest).receipt?.adapterVersion).toBe(RELEASE_IDENTITY.gameVersion);
    const mismatched = { ...valid, receipt: { ...valid.receipt, adapterVersion: '0'.repeat(40) } };
    expect(() => parseProviderResult(JSON.stringify(mismatched), RELEASE_IDENTITY.gameVersion, canonicalizeOrigins(['https://example.test:443']).digest)).toThrow(/receipt identity/);
    const { receipt: _receipt, ...missing } = valid;
    expect(() => parseProviderResult(JSON.stringify(missing), RELEASE_IDENTITY.gameVersion, canonicalizeOrigins(['https://example.test:443']).digest)).toThrow(/success receipt required/);
  });

  test('commits one whole directory, reads Engine catalog, reuses, refreshes, and rolls back failure', () => {
    const game = gameFixture();
    const v1 = { 'tree.glb': { bytes: Buffer.from('glTF-fixture-v1'), role: 'primary-model' }, 'tree-lod.glb': { bytes: Buffer.from('glTF-lod-v1'), role: 'auxiliary-model' }, 'tree.png': { bytes: Buffer.from('png-v1'), role: 'texture' } };
    const begun = begin(game, ['pine tree']);
    populate(game, begun, v1);
    recordAsset3dProviderResult(game, begun.execution, JSON.stringify(providerResult('pine tree', v1)));
    const first = commit({ projectRoot: game, execution: begun.execution });
    expect(first.succeeded).toBe(1); expect(first.failed).toBe(0);
    expect(existsSync(join(game, '.forgeax/extensions/asset3d/data', 'asset3d-results', `${begun.execution}.json`))).toBeFalse();
    const destination = join(game, 'assets', '3d', 'ea-3d', 'tree-1');
    expect(readFileSync(join(destination, 'tree.glb'))).toEqual(v1['tree.glb'].bytes);
    const provenance = JSON.parse(readFileSync(join(destination, '.forgeax-asset.json'), 'utf8'));
    expect(provenance.adapterVersion).toBe(RELEASE_IDENTITY.gameVersion);
    expect(provenance.files.find((file: { relativePath: string }) => file.relativePath === 'tree.glb').engineRows[0].sourceKey).toBe('mesh:tree');
    expect(provenance.files.find((file: { relativePath: string }) => file.relativePath === 'tree-lod.glb').engineRows[0].sourceKey).toBe('mesh:tree-lod');

    const reuse = begin(game, ['pine tree']);
    populate(game, reuse, v1);
    const reused = commit({ projectRoot: game, execution: reuse.execution, providerResult: JSON.stringify(providerResult('pine tree', v1)) });
    expect((reused.results[0] as { reused: boolean }).reused).toBeTrue();

    const v2 = { 'tree.glb': { bytes: Buffer.from('glTF-fixture-v2'), role: 'primary-model' }, 'tree.png': { bytes: Buffer.from('png-v2'), role: 'texture' } };
    const changed = begin(game, ['pine tree']); populate(game, changed, v2);
    expect(commit({ projectRoot: game, execution: changed.execution, providerResult: JSON.stringify(providerResult('pine tree', v2)) }).failed).toBe(1);
    expect(readFileSync(join(destination, 'tree.glb'))).toEqual(v1['tree.glb'].bytes);

    const refreshed = begin(game, ['pine tree']); populate(game, refreshed, v2);
    const refreshResult = commit({ projectRoot: game, execution: refreshed.execution, providerResult: JSON.stringify(providerResult('pine tree', v2)), refresh: true });
    expect((refreshResult.results[0] as { refreshed: boolean }).refreshed).toBeTrue();
    expect(readFileSync(join(destination, 'tree.glb'))).toEqual(v2['tree.glb'].bytes);
    expect(existsSync(join(destination, 'tree-lod.glb.meta.json'))).toBeFalse();

    const broken = { 'fail-engine': { bytes: Buffer.from('x'), role: 'metadata' }, 'tree.glb': { bytes: Buffer.from('glTF-broken'), role: 'primary-model' } };
    const failing = begin(game, ['pine tree']); populate(game, failing, broken);
    const failure = commit({ projectRoot: game, execution: failing.execution, providerResult: JSON.stringify(providerResult('pine tree', broken)), refresh: true });
    expect(failure.failed).toBe(1);
    expect(readFileSync(join(destination, 'tree.glb'))).toEqual(v2['tree.glb'].bytes);
    expect(doctor(game).recovered).toEqual([]);
  });

  test('rejects undeclared and symlink quarantine entries, aborts, and restores stale committing snapshots', () => {
    const game = gameFixture();
    const files = { 'tree.glb': { bytes: Buffer.from('glTF-safe'), role: 'primary-model' } };
    const undeclared = begin(game, ['tree']); populate(game, undeclared, files);
    writeFileSync(join(game, '.forgeax/extensions/asset3d/data', 'asset3d-quarantine', undeclared.output_dir, 'extra.bin'), 'undeclared');
    expect(() => commit({ projectRoot: game, execution: undeclared.execution, providerResult: JSON.stringify(providerResult('tree', files)) })).toThrow(/undeclared/);
    expect(existsSync(join(game, '.forgeax/extensions/asset3d/data', 'asset3d-quarantine', undeclared.output_dir))).toBeFalse();
    expect(JSON.parse(readFileSync(join(game, '.forgeax/extensions/asset3d/data', 'asset3d-transactions', `${undeclared.execution}.json`), 'utf8')).state).toBe('failed');

    const linked = begin(game, ['tree']);
    const linkedRoot = join(game, '.forgeax/extensions/asset3d/data', 'asset3d-quarantine', linked.output_dir);
    symlinkSync(join(game, 'package.json'), join(linkedRoot, 'tree.glb'));
    expect(() => commit({ projectRoot: game, execution: linked.execution, providerResult: JSON.stringify(providerResult('tree', files)) })).toThrow(/symlink/);

    const wrongQuery = begin(game, ['tree']); populate(game, wrongQuery, files);
    expect(() => commit({ projectRoot: game, execution: wrongQuery.execution, providerResult: JSON.stringify(providerResult('rock', files)) })).toThrow(/query identity/);
    expect(existsSync(join(game, '.forgeax/extensions/asset3d/data', 'asset3d-quarantine', wrongQuery.output_dir))).toBeFalse();

    const aborted = begin(game, ['tree']);
    expect(abortAsset3d(game, aborted.execution)).toEqual({ execution: aborted.execution, aborted: true });

    const stale = begin(game, ['tree']);
    const canonicalGame = realpathSync(game);
    const destination = join(canonicalGame, 'assets', '3d', 'ea-3d', 'tree-1');
    const backup = join(canonicalGame, '.forgeax/extensions/asset3d/data', 'asset3d-backups', stale.execution, 'tree-1');
    mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'partial'), 'partial');
    mkdirSync(backup, { recursive: true }); writeFileSync(join(backup, 'prior'), 'prior');
    const path = join(game, '.forgeax/extensions/asset3d/data', 'asset3d-transactions', `${stale.execution}.json`);
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...journal, state: 'committing', destination, backupPath: backup }));
    expect(doctor(game).recovered).toEqual([stale.execution]);
    expect(readFileSync(join(destination, 'prior'), 'utf8')).toBe('prior');
  });
});
