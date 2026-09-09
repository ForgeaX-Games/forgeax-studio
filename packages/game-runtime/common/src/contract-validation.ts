import { isAbsolute } from 'node:path';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function isEngineCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{7,64}$/i.test(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isStableRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.includes('\\') || isAbsolute(value)) return false;
  const parts = value.split('/');
  return !value.includes('\0')
    && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function isPortableAbsolutePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.includes('\0')) return false;
  return isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}
