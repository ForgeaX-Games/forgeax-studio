import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { assertIntegrityDomainGenerated } from './integrity-domain.ts';

/** Immutable product-combo pin consumed by the scanner's --no-git audit path.
 * The wider pin/approval machinery that once lived here is retired; what
 * remains is the pin location plus the scanner configuration fingerprint. */
export const RUNTIME_PIN_PATH = 'packages/harness/docs/ai-native/pins/m2-2026-07-23.json';

export interface ScannerConfigurationFingerprint {
  schema_version: 1;
  algorithm: 'sha256-derived-domain-path-content-v2';
  domains: Array<{ domain: string; path: string; sha256: string }>;
  bound_sha256: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalSha256(value: unknown): string {
  return sha256(stableStringify(value));
}

function repositoryPath(repoRoot: string, input: string): string {
  if (isAbsolute(input) || input.includes('\\') || posix.normalize(input) !== input) {
    throw new Error(`runtime artifact path is not canonical: ${input}`);
  }
  const root = resolve(repoRoot);
  const target = resolve(root, input);
  const rel = relative(root, target).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`runtime artifact path escapes repository: ${input}`);
  }
  return target;
}

export function computeScannerConfigurationFingerprint(repoRoot: string): ScannerConfigurationFingerprint {
  const root = resolve(repoRoot);
  const derived = assertIntegrityDomainGenerated(root);
  const domains = derived.scanner_configuration_files.map((path) => {
    const target = repositoryPath(root, path);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`scanner configuration input must be a regular file: ${path}`);
    }
    const domain = path === 'scripts/ai-native/alias-map.json'
      ? 'identity-aliases'
      : path === 'packages/harness/docs/ai-native/other-team-gap-ownership.md'
        ? 'ownership-adjudication'
        : 'scanner-configuration';
    return { domain, path, sha256: sha256(readFileSync(target)) };
  });
  const binding = {
    schema_version: 1 as const,
    algorithm: 'sha256-derived-domain-path-content-v2' as const,
    domains,
  };
  return { ...binding, bound_sha256: canonicalSha256(binding) };
}
