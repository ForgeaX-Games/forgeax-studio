/**
 * COS object-storage client — just enough to host a local image so image-to-3D can consume it.
 *
 * The 3D endpoint only accepts an image by URL it can fetch itself (it rejects local
 * paths and inline base64), so turning a locally-generated asset into a mesh requires
 * putting that image somewhere publicly reachable first. COS is that host: we PUT the
 * bytes into a private bucket and hand the 3D model a short-lived presigned GET URL,
 * so nothing is left world-readable beyond the generation window.
 *
 * Signing is the COS v5 request-signature algorithm implemented with `node:crypto`
 * only — the plugin ships no runtime dependencies, so we do not pull in the COS SDK.
 * Credentials come from the environment and are never written to source or logs.
 */

import { createHash, createHmac } from 'node:crypto';

export interface CosConfig {
  readonly bucket: string;
  readonly region: string;
  readonly secretId: string;
  readonly secretKey: string;
}

/** Presigned URLs live only as long as a generation needs them. */
const DEFAULT_EXPIRES_SEC = 3600;
/** Backdate the start slightly so minor clock skew doesn't reject a fresh signature. */
const SKEW_SEC = 60;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolve COS config, or `undefined` when it isn't configured. COS is optional — only
 * image-to-3D from a local file needs it — so absence is a valid state the caller
 * turns into a targeted error, not a hard startup failure.
 */
export function resolveCosConfig(): CosConfig | undefined {
  const bucket = env('FORGEAX_COS_BUCKET');
  const region = env('FORGEAX_COS_REGION');
  const secretId = env('FORGEAX_COS_SECRET_ID');
  const secretKey = env('FORGEAX_COS_SECRET_KEY');
  if (!bucket || !region || !secretId || !secretKey) return undefined;
  return { bucket, region, secretId, secretKey };
}

export function cosHost(cfg: CosConfig): string {
  return `${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;
}

/** RFC3986 encoding as COS expects it (encodeURIComponent leaves !'()* alone). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Format a header/param map into COS's `k=v&...` string plus its sorted key list. */
function formatKv(map: Record<string, string>): { serialized: string; keyList: string } {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lowered[k.toLowerCase()] = v;
  const keys = Object.keys(lowered).sort();
  return {
    serialized: keys.map((k) => `${rfc3986(k)}=${rfc3986(lowered[k])}`).join('&'),
    keyList: keys.map((k) => rfc3986(k)).join(';'),
  };
}

/**
 * Build a COS v5 authorization string. Pure and time-injectable so the signature is
 * unit-testable without a clock or a network call.
 */
export function buildAuthorization(
  cfg: CosConfig,
  opts: {
    method: string;
    pathname: string;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    nowSec: number;
    expiresSec?: number;
  },
): string {
  const start = opts.nowSec - SKEW_SEC;
  const end = opts.nowSec + (opts.expiresSec ?? DEFAULT_EXPIRES_SEC);
  const signTime = `${start};${end}`;
  const signKey = createHmac('sha1', cfg.secretKey).update(signTime).digest('hex');

  const { serialized: paramStr, keyList: paramList } = formatKv(opts.params ?? {});
  const { serialized: headerStr, keyList: headerList } = formatKv(opts.headers ?? {});
  const httpString = `${opts.method.toLowerCase()}\n${opts.pathname}\n${paramStr}\n${headerStr}\n`;
  const httpStringSha1 = createHash('sha1').update(httpString).digest('hex');
  const stringToSign = `sha1\n${signTime}\n${httpStringSha1}\n`;
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');

  return [
    'q-sign-algorithm=sha1',
    `q-ak=${cfg.secretId}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${paramList}`,
    `q-signature=${signature}`,
  ].join('&');
}

/** A presigned GET URL anyone (e.g. the 3D backend) can fetch until it expires. */
export function presignGetUrl(cfg: CosConfig, key: string, expiresSec = DEFAULT_EXPIRES_SEC, nowSec = Math.floor(Date.now() / 1000)): string {
  const pathname = key.startsWith('/') ? key : `/${key}`;
  const auth = buildAuthorization(cfg, { method: 'get', pathname, nowSec, expiresSec });
  return `https://${cosHost(cfg)}${pathname}?${auth}`;
}

/** PUT bytes into the bucket at `key`, signing the host header per COS v5. */
export async function uploadObject(cfg: CosConfig, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const host = cosHost(cfg);
  const pathname = key.startsWith('/') ? key : `/${key}`;
  const auth = buildAuthorization(cfg, {
    method: 'put',
    pathname,
    headers: { host },
    nowSec: Math.floor(Date.now() / 1000),
    expiresSec: 600,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`https://${host}${pathname}`, {
      method: 'PUT',
      headers: { authorization: auth, 'content-type': contentType },
      body: bytes,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`COS upload of ${key} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 400)}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Upload then return a presigned GET URL — the one call the 3D tool needs. */
export async function uploadAndPresign(cfg: CosConfig, key: string, bytes: Uint8Array, contentType: string, expiresSec = DEFAULT_EXPIRES_SEC): Promise<string> {
  await uploadObject(cfg, key, bytes, contentType);
  return presignGetUrl(cfg, key, expiresSec);
}
