import { createHash } from 'node:crypto';
import type { InputClass, RecursivePin, SourceIdentity } from './schema.ts';

export type InputDigestSource = {
  sourceIdentity: SourceIdentity;
  recursivePins: readonly RecursivePin[];
  requestedInputClasses: readonly InputClass[];
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonical JSON does not support non-finite numbers');
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeInputDigest(input: InputDigestSource): string {
  const identity = {
    sourceIdentity: input.sourceIdentity,
    recursivePins: [...input.recursivePins].sort((left, right) => left.path.localeCompare(right.path)),
    requestedInputClasses: [...input.requestedInputClasses].sort((left, right) => left.localeCompare(right)),
  };
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}
