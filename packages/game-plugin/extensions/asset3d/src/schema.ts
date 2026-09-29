import { MAX_JSON_BYTES, PROVIDER_RECEIPT_SCHEMA, PROVIDER_RESULT_SCHEMA, sha256 } from './constants';

export type AssetRole = 'primary-pack' | 'auxiliary-pack' | 'primary-model' | 'animation' | 'auxiliary-model' | 'texture' | 'metadata';

export interface ManifestEntry {
  readonly path: string;
  readonly role: AssetRole;
  readonly bytes: number;
  readonly sha256: string;
}

interface ProviderSuccessBase {
  readonly status: 'ok';
  readonly queryIndex: number;
  readonly query: string;
  readonly provider: 'ea-3d';
  readonly providerAssetId: string;
  readonly assetName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly manifest: readonly ManifestEntry[];
  readonly originSetDigest: string;
  readonly downloaded_to?: unknown;
}

export type ProviderSuccess = ProviderSuccessBase & (
  | { readonly deliveredFormat: 'glb'; readonly primaryModel: string }
  | { readonly deliveredFormat: 'pack'; readonly primaryPack: string }
);

export interface ProviderError {
  readonly status: 'error';
  readonly queryIndex: number;
  readonly query: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly message: string;
}

export interface ProviderResult {
  readonly schemaVersion: typeof PROVIDER_RESULT_SCHEMA;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly (ProviderSuccess | ProviderError)[];
  readonly receipt?: ProviderReceipt;
}

export interface ProviderReceipt {
  readonly schemaVersion: typeof PROVIDER_RECEIPT_SCHEMA;
  readonly provider: 'ea-3d';
  readonly adapterVersion: string;
  readonly originSetDigest: string;
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ERROR_CODES = new Set([
  'asset_not_found', 'asset_identity_missing', 'search_timeout', 'search_upstream_error',
  'download_timeout', 'download_origin_rejected', 'download_too_large', 'archive_rejected',
  'conversion_failed', 'digest_failed', 'batch_timeout', 'internal_error',
]);
const ROLES = new Set<AssetRole>(['primary-pack', 'auxiliary-pack', 'primary-model', 'animation', 'auxiliary-model', 'texture', 'metadata']);

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`provider_result_invalid: unknown ${field} fields`);
}

export function safeRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.startsWith('/') || value.includes('\\')) {
    throw new Error('provider_result_invalid: manifest path must be relative POSIX');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('provider_result_invalid: unsafe manifest path');
  return value;
}

function number(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`provider_result_invalid: ${field}`);
  return value as number;
}

function text(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== 'string' || [...value].length < min || [...value].length > max) throw new Error(`provider_result_invalid: ${field}`);
  return value;
}

function aggregate(entries: readonly ManifestEntry[]): string {
  const bytes = entries.map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join('');
  return sha256(bytes);
}

export function parseProviderResult(input: Uint8Array | string, expectedVersion: string, expectedOriginSetDigest: string): ProviderResult {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;
  if (bytes > MAX_JSON_BYTES) throw new Error('provider_result_too_large: stdin exceeds 1 MiB');
  let raw: unknown;
  try { raw = JSON.parse(typeof input === 'string' ? input : Buffer.from(input).toString('utf8')); }
  catch { throw new Error('provider_result_invalid: stdin is not JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('provider_result_invalid: top-level object required');
  const root = raw as Record<string, unknown>;
  exactKeys(root, ['schemaVersion', 'total', 'succeeded', 'failed', 'results', 'receipt'], 'top-level');
  if (root.schemaVersion !== PROVIDER_RESULT_SCHEMA) throw new Error('provider_result_invalid: schemaVersion');
  const total = number(root.total, 1, 16, 'total');
  const succeeded = number(root.succeeded, 0, total, 'succeeded');
  const failed = number(root.failed, 0, total, 'failed');
  if (succeeded + failed !== total || !Array.isArray(root.results) || root.results.length !== total) throw new Error('provider_result_invalid: counts');
  let receipt: ProviderReceipt | undefined;
  if (root.receipt !== undefined) {
    if (!root.receipt || typeof root.receipt !== 'object' || Array.isArray(root.receipt)) {
      throw new Error('provider_result_invalid: receipt object required');
    }
    const value = root.receipt as Record<string, unknown>;
    exactKeys(value, ['schemaVersion', 'provider', 'adapterVersion', 'originSetDigest'], 'receipt');
    if (value.schemaVersion !== PROVIDER_RECEIPT_SCHEMA || value.provider !== 'ea-3d' ||
      value.adapterVersion !== expectedVersion || value.originSetDigest !== expectedOriginSetDigest) {
      throw new Error('provider_result_invalid: receipt identity');
    }
    receipt = {
      schemaVersion: PROVIDER_RECEIPT_SCHEMA,
      provider: 'ea-3d',
      adapterVersion: expectedVersion,
      originSetDigest: expectedOriginSetDigest,
    };
  }
  if (succeeded > 0 && receipt === undefined) throw new Error('provider_result_invalid: success receipt required');
  const indices = new Set<number>();
  let okCount = 0;
  const results = root.results.map((candidate): ProviderSuccess | ProviderError => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('provider_result_invalid: result row');
    const row = candidate as Record<string, unknown>;
    const queryIndex = number(row.queryIndex, 0, total - 1, 'queryIndex');
    if (indices.has(queryIndex)) throw new Error('provider_result_invalid: duplicate queryIndex');
    indices.add(queryIndex);
    const query = text(row.query, 1, 200, 'query');
    if (row.status === 'error') {
      exactKeys(row, ['status', 'queryIndex', 'query', 'code', 'retryable', 'message'], 'error');
      if (typeof row.code !== 'string' || !ERROR_CODES.has(row.code) || typeof row.retryable !== 'boolean') throw new Error('provider_result_invalid: error row');
      const message = text(row.message, 0, 256, 'message');
      return { status: 'error', queryIndex, query, code: row.code, retryable: row.retryable, message };
    }
    if (row.status !== 'ok') throw new Error('provider_result_invalid: status');
    const isPack = row.deliveredFormat === 'pack';
    const primaryKey = isPack ? 'primaryPack' : 'primaryModel';
    const primaryRole = isPack ? 'primary-pack' : 'primary-model';
    exactKeys(row, ['status', 'queryIndex', 'query', 'provider', 'providerAssetId', 'assetName', 'deliveredFormat', 'sha256', 'bytes', primaryKey, 'manifest', 'originSetDigest', 'downloaded_to'], 'success');
    okCount++;
    if (row.provider !== 'ea-3d' || (row.deliveredFormat !== 'glb' && !isPack) || typeof row.providerAssetId !== 'string' || !ID.test(row.providerAssetId) || row.providerAssetId === '.' || row.providerAssetId === '..') {
      throw new Error('provider_result_invalid: success identity');
    }
    const assetName = text(row.assetName, 1, 128, 'assetName');
    const itemBytes = number(row.bytes, 1, 268435456, 'bytes');
    if (typeof row.sha256 !== 'string' || !DIGEST.test(row.sha256)) throw new Error('provider_result_invalid: aggregate digest');
    if (!Array.isArray(row.manifest) || row.manifest.length < 1 || row.manifest.length > 1024) throw new Error('provider_result_invalid: manifest count');
    const seen = new Set<string>();
    const manifest = row.manifest.map((entry): ManifestEntry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('provider_result_invalid: manifest entry');
      const item = entry as Record<string, unknown>;
      exactKeys(item, ['path', 'role', 'bytes', 'sha256'], 'manifest');
      const path = safeRelativePath(item.path);
      if (seen.has(path)) throw new Error('provider_result_invalid: duplicate manifest path');
      seen.add(path);
      if (typeof item.role !== 'string' || !ROLES.has(item.role as AssetRole)) throw new Error('provider_result_invalid: manifest role');
      const role = item.role as AssetRole;
      const entryBytes = number(item.bytes, 1, 134217728, 'manifest bytes');
      if (typeof item.sha256 !== 'string' || !DIGEST.test(item.sha256)) throw new Error('provider_result_invalid: manifest digest');
      if ((role === 'primary-model' || role === 'animation' || role === 'auxiliary-model') && !path.toLowerCase().endsWith('.glb')) {
        throw new Error('provider_result_invalid: model entry must be GLB');
      }
      if ((role === 'primary-pack' || role === 'auxiliary-pack') && (!isPack || !/\.pack\.(json|ts)$/i.test(path))) {
        throw new Error('provider_result_invalid: pack entry must be authored Pack');
      }
      if (isPack && role === 'primary-model') throw new Error('provider_result_invalid: multiple primary formats');
      return { path, role, bytes: entryBytes, sha256: item.sha256 };
    });
    const sorted = [...manifest].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    if (manifest.some((entry, index) => entry.path !== sorted[index]!.path)) throw new Error('provider_result_invalid: manifest must be UTF-8 path sorted');
    const primary = manifest.filter((entry) => entry.role === primaryRole);
    if (primary.length !== 1 || row[primaryKey] !== primary[0]!.path) throw new Error('provider_result_invalid: primary model');
    if (manifest.reduce((sum, entry) => sum + entry.bytes, 0) !== itemBytes || aggregate(manifest) !== row.sha256) {
      throw new Error('provider_result_invalid: byte or aggregate digest mismatch');
    }
    if (row.originSetDigest !== expectedOriginSetDigest) throw new Error('provider_result_invalid: originSetDigest identity');
    return {
      status: 'ok', queryIndex, query, provider: 'ea-3d', providerAssetId: row.providerAssetId,
      assetName, sha256: row.sha256, bytes: itemBytes,
      ...(isPack ? { deliveredFormat: 'pack' as const, primaryPack: row.primaryPack as string } : { deliveredFormat: 'glb' as const, primaryModel: row.primaryModel as string }), manifest, originSetDigest: expectedOriginSetDigest,
      ...(row.downloaded_to === undefined ? {} : { downloaded_to: row.downloaded_to }),
    };
  });
  if (okCount !== succeeded || total - okCount !== failed) throw new Error('provider_result_invalid: status counts');
  return { schemaVersion: PROVIDER_RESULT_SCHEMA, total, succeeded, failed, results, ...(receipt ? { receipt } : {}) };
}
