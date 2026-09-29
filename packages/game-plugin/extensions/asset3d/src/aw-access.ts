import { readAwCredential } from './credentials';
import { canonicalizeOrigins } from './origins';
import { searchBody, type SearchOptions } from './search-contract';

const AW_SERVICE_PATH = '/trpc.oasismetric.omcontentserver.http';
export const DEFAULT_AW_PUBLIC_SERVICE_ROOT =
  'https://public-service.example.com/trpc/example';
export type AssetLibraryId = 'aw' | 'ea';
export interface AssetLibraryConfig {
  serviceRoot: string; library: AssetLibraryId; credentialFile: string;
}
export interface AssetVersion {
  versionName: string; engineVersions?: string[]; thumbnailUrl?: string; downloadUrl?: string;
}
export interface AssetCandidate {
  assetId: string; name: string; format: string; downloadUrl: string;
  type?: number; description?: string; detailedDescription?: string; category?: string[];
  artStyle?: string[]; themeStyle?: string[]; customTags?: string[]; score?: number;
  thumbnailUrl?: string; currentVersion?: string; versions?: AssetVersion[];
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function optionalStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined;
}
function optionalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  downloadOrigin(value);
  return value;
}

/** Keep selection metadata and preview links; signed download URLs stay inside the CLI. */
export function publicCandidate(candidate: AssetCandidate) {
  const { downloadUrl, versions, ...metadata } = candidate;
  return { ...metadata, ...(versions ? { versions: versions.map(({ downloadUrl, ...version }) =>
    ({ ...version, downloadable: !!downloadUrl })) } : {}) };
}

export function normalizeAssetLibraryServiceRoot(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error('asset3d_base_url_invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('asset3d_base_url_invalid');
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith(AW_SERVICE_PATH + '/HybridSearch')) path = path.slice(0, -'/HybridSearch'.length);
  else if (!path.endsWith(AW_SERVICE_PATH)) path += AW_SERVICE_PATH;
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, '');
}

export function resolveAssetLibrarySelection(options: { library?: string; baseUrl?: string } = {}) {
  const library = options.library || process.env.FORGEAX_ASSET_LIBRARY || 'aw';
  if (library !== 'aw' && library !== 'ea') throw new Error('asset3d_library_invalid: expected aw or ea');
  const base = options.baseUrl || process.env.FORGEAX_ASSET_LIBRARY_BASE_URL ||
    (library === 'aw' ? DEFAULT_AW_PUBLIC_SERVICE_ROOT : undefined);
  if (!base) throw new Error('FORGEAX_ASSET_LIBRARY_BASE_URL is required when FORGEAX_ASSET_LIBRARY=ea. Set the EA gateway URL explicitly.');
  return { library, serviceRoot: normalizeAssetLibraryServiceRoot(base) } as const;
}

export function downloadOrigin(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('asset3d_download_url_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('asset3d_download_url_invalid');
  }
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

export async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('asset3d_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('asset3d_response_too_large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function searchLibrary(config: AssetLibraryConfig, query: string, options: SearchOptions = {}): Promise<AssetCandidate[]> {
  const body = searchBody(config.library, query, options);
  const key = readAwCredential(config.credentialFile);
  if (!key) throw new Error('asset3d_api_key_required');
  let response: Response;
  try {
    response = await fetch(normalizeAssetLibraryServiceRoot(config.serviceRoot) + '/HybridSearch', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', 'X-Sandbox-Key': key },
      body: JSON.stringify(body),
    });
  } catch { throw new Error('asset3d_service_unreachable'); }
  if (response.status === 401 || response.status === 403) throw new Error('asset3d_access_denied');
  if (!response.ok) throw new Error(`asset3d_service_http_${response.status}`);
  let value: any;
  try { value = JSON.parse((await boundedResponse(response, 1024 * 1024)).toString()); }
  catch { throw new Error('asset3d_search_response_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.ret !== undefined && value.ret !== 0)) {
    throw new Error('asset3d_search_response_invalid');
  }
  if (value.asset_list === undefined) return [];
  if (!Array.isArray(value.asset_list) || value.asset_list.length > 100) throw new Error('asset3d_search_response_invalid');
  const seen = new Set<string>();
  return value.asset_list.slice(0, 10).map((asset: any) => {
    if (!asset || typeof asset.id !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/.test(asset.id) ||
        seen.has(asset.id) || typeof asset.name !== 'string' || !asset.name || asset.name.length > 1024 ||
        typeof asset.res_url !== 'string') throw new Error('asset3d_search_response_invalid');
    seen.add(asset.id);
    downloadOrigin(asset.res_url);
    const path = new URL(asset.res_url).pathname;
    const format = String(asset.file_format || asset.format || path.split('.').pop() || 'unknown').toLowerCase();
    const versions = Array.isArray(asset.versions) ? asset.versions.map((v: any) => {
      if (!v || typeof v.version_name !== 'string' || !v.version_name) throw new Error('asset3d_search_response_invalid');
      return { versionName: v.version_name, engineVersions: optionalStrings(v.engine_versions),
        thumbnailUrl: optionalUrl(v.thumbnail_url), downloadUrl: optionalUrl(v.res_url) };
    }) : undefined;
    return { assetId: asset.id, name: asset.name, format, downloadUrl: asset.res_url,
      ...(typeof asset.type === 'number' ? { type: asset.type } : {}),
      ...(typeof asset.score === 'number' ? { score: asset.score } : {}),
      description: optionalText(asset.description), detailedDescription: optionalText(asset.extra?.detailed_description),
      category: optionalStrings(asset.category), artStyle: optionalStrings(asset.art_style),
      themeStyle: optionalStrings(asset.theme_style), customTags: optionalStrings(asset.custom_tags),
      currentVersion: optionalText(asset.current_version), thumbnailUrl: optionalUrl(asset.thumbnail_url), versions };
  });
}

export async function checkAssetLibraryAccess(config: AssetLibraryConfig) {
  const candidates = await searchLibrary(config, 'tree');
  // Empty successful search is not sufficient to establish permitted download destinations.
  if (!candidates.length) throw new Error('asset3d_access_validation_inconclusive: no download origin returned');
  const origins = canonicalizeOrigins([...new Set(candidates.map(c => downloadOrigin(c.downloadUrl)))]);
  return { serviceRoot: config.serviceRoot, authentication: 'sandbox-key', downloadOrigins: origins.values };
}
