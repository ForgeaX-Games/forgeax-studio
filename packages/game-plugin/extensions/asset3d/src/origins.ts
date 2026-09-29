import { domainToASCII } from 'node:url';
import { canonicalJson, sha256 } from './constants';

export interface CanonicalOrigins {
  readonly values: readonly string[];
  readonly compactJson: string;
  readonly digest: string;
}

function canonicalIpv4(host: string): string | undefined {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const values = parts.map(Number);
  if (values.some((value) => value > 255)) throw new Error('download_origin_invalid: invalid IPv4 address');
  return values.join('.');
}

/** Freeze provider authority to 1..8 exact, pathless, explicitly-ported HTTP origins. */
export function canonicalizeOrigins(inputs: readonly string[]): CanonicalOrigins {
  if (inputs.length < 1 || inputs.length > 8) {
    throw new Error('download_origin_count_invalid: expected 1..8 --download-origin values');
  }
  const values = inputs.map((input) => {
    const lexical = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[^:/?#@]+):(\d{1,5})$/.exec(input);
    if (!lexical) {
      throw new Error('download_origin_invalid: expected exact scheme://host:port without path, query, fragment, or userinfo');
    }
    let parsed: URL;
    try { parsed = new URL(input); } catch { throw new Error('download_origin_invalid: malformed URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('download_origin_invalid: http or https required');
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('download_origin_invalid: userinfo/path/query/fragment is forbidden');
    }
    const port = Number(lexical[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('download_origin_invalid: explicit port must be 1..65535');
    let host = lexical[2]!;
    if (host === '*' || host.includes('*')) throw new Error('download_origin_invalid: wildcard host is forbidden');
    if (host.startsWith('[') && host.endsWith(']')) {
      const normalized = new URL(`${parsed.protocol}//${host}:${port}`).hostname;
      host = normalized.startsWith('[') ? normalized.toLowerCase() : `[${normalized.toLowerCase()}]`;
    } else {
      host = canonicalIpv4(host) ?? domainToASCII(host.replace(/\.$/, '')).toLowerCase();
      if (!host) throw new Error('download_origin_invalid: host cannot be canonicalized');
    }
    return `${lexical[1]}://${host}:${port}`;
  }).sort();
  if (new Set(values).size !== values.length) throw new Error('download_origin_duplicate: canonical duplicates are forbidden');
  const compactJson = canonicalJson(values);
  return { values, compactJson, digest: sha256(compactJson) };
}
