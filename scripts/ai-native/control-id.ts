import { createHash } from 'node:crypto';
import type { AliasMap, ControlIdentityInput } from './types';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizedAttributes(attrs: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(attrs ?? {})
    .filter(([, value]) => value !== '')
    .map(([key, value]) => [key, normalizedText(value)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Handler-independent structure fingerprint. The ordinal is only a last-resort
 * discriminator for identical siblings in the same component/event bucket.
 */
export function structureFingerprint(input: ControlIdentityInput): string {
  const structure = JSON.stringify({
    element: input.elementType,
    attributes: normalizedAttributes(input.stableAttributes),
    text: normalizedText(input.staticText),
    ordinal: input.ordinal ?? 0,
  });
  return sha256(structure).slice(0, 20);
}

/** Stable identity intentionally excludes line number and handler source. */
export function controlId(input: ControlIdentityInput): string {
  const identity = JSON.stringify({
    repo: input.repo,
    path: input.relativePath.replaceAll('\\', '/'),
    component: input.component,
    event: input.event,
    fingerprint: structureFingerprint(input),
  });
  return `ctl_${sha256(identity).slice(0, 24)}`;
}

export function validateAliasMap(map: AliasMap): string[] {
  const issues: string[] = [];
  const oldIds = new Set<string>();
  const newIds = new Set<string>();
  for (const entry of map.aliases) {
    if (!/^ctl_[0-9a-f]{24}$/.test(entry.old_control_id)) {
      issues.push(`invalid old_control_id: ${entry.old_control_id}`);
    }
    if (!/^ctl_[0-9a-f]{24}$/.test(entry.new_control_id)) {
      issues.push(`invalid new_control_id: ${entry.new_control_id}`);
    }
    if (entry.old_control_id === entry.new_control_id) {
      issues.push(`alias is a no-op: ${entry.old_control_id}`);
    }
    if (oldIds.has(entry.old_control_id)) issues.push(`duplicate old_control_id: ${entry.old_control_id}`);
    if (newIds.has(entry.new_control_id)) issues.push(`duplicate new_control_id: ${entry.new_control_id}`);
    if (!entry.reason.trim()) issues.push(`alias missing reason: ${entry.old_control_id}`);
    oldIds.add(entry.old_control_id);
    newIds.add(entry.new_control_id);
  }
  const byOld = new Map(map.aliases.map((entry) => [entry.old_control_id, entry.new_control_id]));
  for (const start of byOld.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current && byOld.has(current)) {
      if (seen.has(current)) {
        issues.push(`alias cycle at ${current}`);
        break;
      }
      seen.add(current);
      current = byOld.get(current);
    }
  }
  return issues;
}

/** Follow a migration chain while keeping every historical id in alias-map.json. */
export function resolveAlias(id: string, map: AliasMap): string {
  const byOld = new Map(map.aliases.map((entry) => [entry.old_control_id, entry.new_control_id]));
  const seen = new Set<string>();
  let current = id;
  while (byOld.has(current)) {
    if (seen.has(current)) throw new Error(`control alias cycle at ${current}`);
    seen.add(current);
    current = byOld.get(current)!;
  }
  return current;
}

/** Return historical ids that migrate to the current raw id. */
export function historicalAliasesFor(currentId: string, map: AliasMap): string[] {
  return map.aliases
    .filter((entry) => resolveAlias(entry.old_control_id, map) === currentId)
    .map((entry) => entry.old_control_id)
    .sort();
}
