import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sha256 } from './constants';
import { safeRelativePath } from './schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('engine_pack_readback_invalid');
  return value as Record<string, unknown>;
}

/** Read Engine's fresh build projection, never derive identities from Pack source. */
export function readPackBuildCatalog(projectRoot: string, sourcePaths: readonly string[], buildValue: unknown) {
  const build = object(buildValue);
  const runtime = object(build.runtime);
  if (build.schemaVersion !== '1.0.0' || !Array.isArray(build.artifacts) || build.artifacts.length > 10000) {
    throw new Error('engine_pack_build_manifest_invalid');
  }
  const dist = resolve(projectRoot, 'dist');
  const canonicalDist = realpathSync(dist);
  if (canonicalDist !== resolve(realpathSync(projectRoot), 'dist') || lstatSync(dist).isSymbolicLink()) {
    throw new Error('engine_pack_build_path_escape');
  }
  const artifacts = new Map<string, Buffer>();
  let total = 0;
  for (const raw of build.artifacts) {
    const entry = object(raw);
    const path = safeRelativePath(entry.path);
    if (artifacts.has(path) || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 ||
      (entry.bytes as number) > 256 * 1024 * 1024 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('engine_pack_build_manifest_invalid');
    }
    total += entry.bytes as number;
    if (total > 1024 * 1024 * 1024) throw new Error('engine_pack_build_too_large');
    const file = resolve(dist, path);
    const rel = relative(canonicalDist, realpathSync(file));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('engine_pack_build_path_escape');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) throw new Error('engine_pack_build_file_invalid');
    const bytes = readFileSync(file);
    if (sha256(bytes) !== entry.sha256) throw new Error('engine_pack_build_digest_mismatch');
    // Only JSON needed for readback is retained; large binary artifacts are checked then released.
    artifacts.set(path, path.endsWith('.json') ? bytes : Buffer.alloc(0));
  }
  const indexPath = safeRelativePath(runtime.packIndexUrl);
  const indexBytes = artifacts.get(indexPath);
  if (!indexBytes || indexBytes.length > 16 * 1024 * 1024) throw new Error('engine_pack_catalog_missing');
  const index: unknown = JSON.parse(indexBytes.toString('utf8'));
  if (!Array.isArray(index)) throw new Error('engine_pack_catalog_invalid');
  const sources = new Set(sourcePaths);
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const inspect: Record<string, unknown>[] = [];
  for (const raw of index) {
    const row = object(raw);
    if (typeof row.sourcePath !== 'string' || !sources.has(row.sourcePath)) continue;
    if (typeof row.guid !== 'string' || !UUID.test(row.guid) || seen.has(row.guid) || typeof row.kind !== 'string' ||
      typeof row.packageUrl !== 'string' || !row.packageUrl.startsWith('/') || row.packageUrl.startsWith('//')) {
      throw new Error('engine_pack_catalog_invalid');
    }
    seen.add(row.guid);
    const packagePath = safeRelativePath(row.packageUrl.slice(1));
    const bytes = artifacts.get(packagePath);
    if (!bytes || bytes.length > 16 * 1024 * 1024) throw new Error('engine_pack_product_missing');
    const pack = object(JSON.parse(bytes.toString('utf8')));
    if (!Array.isArray(pack.assets)) throw new Error('engine_pack_product_invalid');
    const matches = pack.assets.map(object).filter(asset => asset.guid === row.guid && asset.kind === row.kind);
    if (matches.length !== 1) throw new Error('engine_pack_product_guid_missing');
    rows.push({ guid: row.guid, kind: row.kind, source: row.sourcePath, sourcePath: row.sourcePath,
      ...(typeof row.name === 'string' ? { name: row.name } : {}), packageUrl: row.packageUrl });
    inspect.push({ guid: row.guid, kind: row.kind, packagePath, packageSha256: sha256(bytes), verified: true });
  }
  if (!rows.some(row => row.kind === 'scene' || row.kind === 'mesh')) throw new Error('engine_pack_readback_missing_renderable');
  return { authority: 'engine-build-catalog' as const,
    verify: { artifacts: artifacts.size, bytes: total, catalogSha256: sha256(indexBytes) },
    list: rows, rows, inspect };
}
