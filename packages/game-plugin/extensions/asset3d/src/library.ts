import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { boundedResponse, downloadOrigin, publicCandidate, searchLibrary, type AssetCandidate } from './aw-access';
import { searchBody, type SearchOptions } from './search-contract';
import { ENGINE_VERSION } from '../../../src/engine/constants';
import { readAsset3dConfig, type Asset3dInstallManifest } from './install';
import { PROVIDER_RECEIPT_SCHEMA, PROVIDER_RESULT_SCHEMA, sha256 } from './constants';
import { safeRelativePath, type ManifestEntry, type ProviderResult } from './schema';
import { abortAsset3d, asset3dSearchOutputDir, beginAsset3d, commitAsset3d, recordAsset3dProviderResult } from './transaction';

const MAX_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;

/** Never extract to disk before validating every member and the decompressed size budget. */
export function unpackAsset(bytes: Uint8Array, format: string): Record<string, Uint8Array> {
  const seen = new Set<string>();
  let total = 0;
  const check = (path: string, size: number) => {
    safeRelativePath(path);
    if (/[\x00-\x1f:]/.test(path) || path.split('/').some(p =>
      /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) {
      throw new Error('asset3d_archive_path_invalid');
    }
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key) || seen.size >= 1024 || size < 1 || size > MAX_FILE || (total += size) > MAX_TOTAL) {
      throw new Error('asset3d_archive_limits');
    }
    seen.add(key);
  };
  if (format === 'zip') {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter(entry) {
        if (entry.name.endsWith('/')) { safeRelativePath(entry.name.slice(0, -1)); return false; }
        check(entry.name, entry.originalSize);
        return true;
      } });
    } catch { throw new Error('asset3d_archive_rejected'); }
    // fflate returns bytes, never OS links. Check file/directory collisions before writing.
    for (const path of Object.keys(files)) {
      let parent = path;
      while (parent.includes('/')) {
        parent = parent.slice(0, parent.lastIndexOf('/'));
        if (seen.has(parent.normalize('NFC').toLowerCase())) throw new Error('asset3d_archive_path_conflict');
      }
      if (!files[path]!.length || files[path]!.length > MAX_FILE) throw new Error('asset3d_archive_limits');
    }
    return files;
  }
  if (!['glb', 'pack.ts', 'pack.json'].includes(format)) throw new Error('asset3d_format_unsupported');
  const path = 'asset.' + format;
  check(path, bytes.length);
  return { [path]: bytes };
}

export function manifestFor(files: Record<string, Uint8Array>, prefix: string) {
  const paths = Object.keys(files).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const packs = paths.filter(p => /\.pack\.(ts|json)$/i.test(p));
  const models = paths.filter(p => /\.glb$/i.test(p));
  const primary = packs[0] ?? models.find(p => /(^|\/)SM_/i.test(p)) ?? models[0];
  if (!primary) throw new Error('asset3d_supported_source_missing');
  for (const path of models) {
    const bytes = Buffer.from(files[path]!);
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'glTF' ||
        bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
      throw new Error('asset3d_glb_invalid');
    }
  }
  const manifest: ManifestEntry[] = paths.map(path => ({
    path: prefix + '/' + path,
    role: packs.includes(path) ? (path === primary ? 'primary-pack' : 'auxiliary-pack')
      : models.includes(path) ? (path === primary ? 'primary-model' : 'auxiliary-model')
      : /\.(png|jpg|jpeg|webp|ktx2)$/i.test(path) ? 'texture' : 'metadata',
    bytes: files[path]!.length, sha256: sha256(files[path]!),
  }));
  return { manifest, primary: prefix + '/' + primary, deliveredFormat: packs.length ? 'pack' as const : 'glb' as const,
    bytes: manifest.reduce((n, e) => n + e.bytes, 0),
    sha256: sha256(manifest.map(e => `${e.path}\0${e.bytes}\0${e.sha256}\n`).join('')) };
}

async function download(config: Asset3dInstallManifest, candidate: AssetCandidate) {
  if (!config.downloadOrigins.includes(downloadOrigin(candidate.downloadUrl))) {
    throw new Error('asset3d_download_origin_rejected: enable again to refresh allowed origins');
  }
  let response: Response;
  try {
    // Signed download URLs are service data. Never forward the API credential or follow redirects.
    response = await fetch(candidate.downloadUrl, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  } catch { throw new Error('asset3d_download_unreachable'); }
  if (!response.ok) throw new Error(`asset3d_download_http_${response.status}`);
  const bytes = await boundedResponse(response, MAX_TOTAL);
  const path = new URL(candidate.downloadUrl).pathname;
  const format = /\.pack\.(ts|json)$/i.exec(path)?.[0].slice(1) ?? candidate.format.replace(/^\./, '');
  return unpackAsset(bytes, format);
}

export async function candidatesAsset3d(root: string, query: string, options: SearchOptions = {}) {
  const candidates = await searchLibrary(readAsset3dConfig(root), query, options);
  return { projectEngineVersion: ENGINE_VERSION, candidates: candidates.map(publicCandidate) };
}

export function selectAssetVersion(candidate: AssetCandidate, versionName?: string, engineVersion?: string): AssetCandidate {
  const selected = versionName ? candidate.versions?.find(v => v.versionName === versionName)
    : candidate.versions?.find(v => v.versionName === candidate.currentVersion);
  if (versionName && !selected) throw new Error('asset3d_version_not_found');
  if (versionName && !selected?.downloadUrl) throw new Error('asset3d_version_download_missing');
  // A filter may match a non-current version. Do not silently download the top-level/current URL.
  if (engineVersion && candidate.versions?.length &&
      (!selected || !selected.engineVersions?.includes(engineVersion))) {
    throw new Error('asset3d_version_selection_required: choose --version from a matching versions entry');
  }
  return selected?.downloadUrl ? { ...candidate, currentVersion: selected.versionName, downloadUrl: selected.downloadUrl,
    thumbnailUrl: selected.thumbnailUrl ?? candidate.thumbnailUrl } : candidate;
}

/** Missing metadata is not proof of incompatibility; an explicit different version is. */
export function assertAssetEngineCompatible(candidate: AssetCandidate, projectVersion: string): void {
  const declared = candidate.versions?.find(v => v.versionName === candidate.currentVersion)?.engineVersions;
  if (declared?.length && !declared.includes(projectVersion)) {
    throw new Error(`asset3d_engine_version_mismatch: project Engine ${projectVersion}; selected asset version ${candidate.currentVersion} declares ${declared.join(', ')}. Select a matching asset version; do not upgrade the project silently.`);
  }
}

export async function importAsset3d(root: string, query: string, assetId: string, options: SearchOptions = {}, versionName?: string) {
  const config = readAsset3dConfig(root);
  const found = (await searchLibrary(config, query, options)).find(c => c.assetId === assetId);
  if (!found) throw new Error('asset3d_candidate_not_found: select an ID returned for this query and filters');
  const candidate = selectAssetVersion(found, versionName, options.engineVersion);
  assertAssetEngineCompatible(candidate, ENGINE_VERSION);
  const files = await download(config, candidate);
  const built = manifestFor(files, candidate.assetId);
  const transactionQuery = query.trim() || `asset ${assetId}`;
  const started = beginAsset3d(root, [transactionQuery]);
  try {
    const output = asset3dSearchOutputDir(root, started.execution, [transactionQuery]);
    for (const [path, bytes] of Object.entries(files)) {
      const target = resolve(root, '.forgeax/extensions/asset3d/data/asset3d-quarantine', output, candidate.assetId, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const result: ProviderResult = {
      schemaVersion: PROVIDER_RESULT_SCHEMA, total: 1, succeeded: 1, failed: 0,
      receipt: { schemaVersion: PROVIDER_RECEIPT_SCHEMA, provider: 'ea-3d',
        adapterVersion: config.adapterVersion, originSetDigest: config.originSetDigest },
      results: [{
        status: 'ok', queryIndex: 0, query: transactionQuery, provider: 'ea-3d', providerAssetId: assetId,
        assetName: candidate.name, sha256: built.sha256, bytes: built.bytes, manifest: built.manifest,
        originSetDigest: config.originSetDigest,
        ...(built.deliveredFormat === 'pack' ? { deliveredFormat: 'pack', primaryPack: built.primary }
          : { deliveredFormat: 'glb', primaryModel: built.primary }),
      }],
    };
    recordAsset3dProviderResult(root, started.execution, JSON.stringify(result));
    const committed = commitAsset3d({ projectRoot: root, execution: started.execution });
    return { ...committed, deliveredFormat: built.deliveredFormat, selectedAsset: publicCandidate(candidate) };
  } catch (error) {
    try { abortAsset3d(root, started.execution); } catch { /* commit already recorded its terminal state */ }
    throw error;
  }
}

export function parseAsset3dArgs(args: readonly string[], importing: boolean) {
  const allowed = ['--query', '--asset-type', '--category', '--art-style', '--theme-style', '--engine-version',
    ...(importing ? ['--asset-id', '--version', '--candidate-file', '--candidate-name'] : [])];
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    const name = args[i]!, value = args[++i];
    if (!allowed.includes(name) || values[name] || !value || value.startsWith('--')) throw new Error('asset3d_arguments_invalid');
    values[name] = value;
  }
  const file = values['--candidate-file'], name = values['--candidate-name'];
  if (importing && (Boolean(file) !== Boolean(name) || Boolean(values['--asset-id']) === Boolean(file))) {
    throw new Error('asset3d_arguments_invalid: supply --asset-id or --candidate-file with --candidate-name');
  }
  const query = values['--query'] ?? '';
  const options: SearchOptions = {
    ...(values['--asset-type'] !== undefined ? { assetType: Number(values['--asset-type']) } : {}),
    ...(values['--category'] ? { category: values['--category'] } : {}),
    ...(values['--art-style'] ? { artStyle: values['--art-style'] } : {}),
    ...(values['--theme-style'] ? { themeStyle: values['--theme-style'] } : {}),
    ...(values['--engine-version'] ? { engineVersion: values['--engine-version'] } : {}),
  };
  searchBody('ea', query, options);
  let selected: { assetId: string; versionName?: string } | undefined;
  if (file && name) {
    let response: unknown;
    try {
      if (statSync(file).size > 1024 * 1024) throw new Error('too large');
      response = JSON.parse(readFileSync(file, 'utf8'));
    } catch { throw new Error('asset3d_candidate_file_invalid'); }
    const data = response as { ok?: unknown; value?: { candidates?: unknown } };
    if (data?.ok !== true || !Array.isArray(data.value?.candidates)) throw new Error('asset3d_candidate_file_invalid');
    const matches = data.value.candidates.filter((entry): entry is { assetId: string; name: string; currentVersion?: string; versions?: { versionName: string }[] } =>
      typeof entry?.assetId === 'string' && typeof entry.name === 'string' &&
      (entry.name === name || basename(entry.name) === name));
    if (matches.length !== 1) throw new Error('asset3d_candidate_name_not_unique');
    const candidate = matches[0]!;
    if (values['--version'] && !candidate.versions?.some(v => v.versionName === values['--version'])) {
      throw new Error('asset3d_version_not_found_in_candidates');
    }
    selected = { assetId: candidate.assetId, versionName: values['--version'] ?? candidate.currentVersion };
  }
  return { query, assetId: selected?.assetId ?? values['--asset-id']!, options,
    versionName: selected?.versionName ?? values['--version'] };
}
