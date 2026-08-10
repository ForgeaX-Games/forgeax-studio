/**
 * Turning a client spec plus a launch command into an edited config file.
 *
 * The merge is pure and the IO is a thin shell around it, so the interesting part —
 * "does this preserve everything the user already had?" — is testable against real
 * strings without touching a home directory.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClientSpec, LaunchSpec } from './clients';
import { SERVER_KEY } from './clients';
import {
  encodeTomlString,
  encodeTomlStringArray,
  hasCompetingTomlDefinition,
  hasTomlTable,
  removeTomlTable,
  upsertTomlTable,
} from './toml-section';

/** The server entry as a client-shaped plain object. */
export function buildEntry(spec: ClientSpec, launch: LaunchSpec): Record<string, unknown> {
  const command =
    spec.commandShape === 'argv'
      ? { command: [launch.command, ...launch.args] }
      : { command: launch.command, args: [...launch.args] };
  return { ...command, ...(spec.extraEntryFields ?? {}) };
}

export interface MergeResult {
  readonly content: string;
  /** False when the file already said exactly this, so the write can be skipped. */
  readonly changed: boolean;
}

/**
 * Merge into a JSON config.
 *
 * A config that fails to parse is a hard error rather than something to overwrite: it
 * is far more likely to be a file the user is midway through editing than one worth
 * discarding, and clobbering it would lose every other server they configured.
 */
export function mergeJsonConfig(
  existing: string | undefined,
  spec: ClientSpec,
  entry: Record<string, unknown>,
): MergeResult {
  let root: Record<string, unknown> = {};
  if (existing && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (e) {
      throw new Error(
        `${spec.path('')} is not valid JSON (${(e as Error).message}). Fix or move the file, then re-run install.`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${spec.path('')} does not contain a JSON object at the top level.`);
    }
    root = parsed as Record<string, unknown>;
  }

  const mapKey = spec.serverMapKey ?? ['mcpServers'];
  let cursor = root;
  for (const key of mapKey) {
    const next = cursor[key];
    if (next === undefined) {
      cursor[key] = {};
    } else if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new Error(
        `${spec.path('')} has ${mapKey.join('.')} with an incompatible value; refusing to overwrite existing user data.`,
      );
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const before = JSON.stringify(cursor[SERVER_KEY]);
  cursor[SERVER_KEY] = entry;
  const content = `${JSON.stringify(root, null, 2)}\n`;
  return { content, changed: before !== JSON.stringify(entry) };
}

/** Merge into Codex's TOML, touching only the `mcp_servers.forgeax` table. */
export function mergeTomlConfig(
  existing: string | undefined,
  entry: Record<string, unknown>,
): MergeResult {
  const body: string[] = [];
  const command = entry.command;
  if (typeof command === 'string') body.push(`command = ${encodeTomlString(command)}`);
  const args = entry.args;
  if (Array.isArray(args)) body.push(`args = ${encodeTomlStringArray(args as string[])}`);

  const content = upsertTomlTable(existing ?? '', { header: `mcp_servers.${SERVER_KEY}`, body });
  return { content, changed: content !== (existing ?? '') };
}

export interface ApplyResult {
  readonly path: string;
  readonly changed: boolean;
  /** Path of the backup taken before overwriting, when one was needed. */
  readonly backup?: string;
}

export type ConfigState = 'missing' | 'not_configured' | 'current' | 'different' | 'invalid';

/**
 * Inspect whether a client already points at the requested launch command.
 *
 * Used by doctor and upgrade. Parsing failures are reported as state rather than
 * thrown because a diagnostic command should finish checking the other clients.
 */
export function inspectConfig(
  spec: ClientSpec,
  projectRoot: string,
  launch: LaunchSpec,
): { readonly path: string; readonly state: ConfigState; readonly detail?: string } {
  const path = spec.path(projectRoot);
  if (!existsSync(path)) return { path, state: 'missing' };

  let existing: string;
  try {
    existing = readFileSync(path, 'utf8');
    if (spec.format === 'toml') {
      const header = `mcp_servers.${SERVER_KEY}`;
      if (!hasTomlTable(existing, header)) {
        if (hasCompetingTomlDefinition(existing, header)) {
          return {
            path,
            state: 'invalid',
            detail: `${header} is defined through an unsupported inline or parent-table key`,
          };
        }
        return { path, state: 'not_configured' };
      }
      return {
        path,
        state: mergeTomlConfig(existing, buildEntry(spec, launch)).changed ? 'different' : 'current',
      };
    }

    const parsed = JSON.parse(existing) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { path, state: 'invalid', detail: 'top level is not a JSON object' };
    }
    let cursor: unknown = parsed;
    for (const key of spec.serverMapKey ?? ['mcpServers']) {
      if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
        return { path, state: 'not_configured' };
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return { path, state: 'not_configured' };
    }
    const entry = (cursor as Record<string, unknown>)[SERVER_KEY];
    if (entry === undefined) return { path, state: 'not_configured' };
    return {
      path,
      state: JSON.stringify(entry) === JSON.stringify(buildEntry(spec, launch)) ? 'current' : 'different',
    };
  } catch (error) {
    return { path, state: 'invalid', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Write the merged config, keeping one backup of what was there before.
 *
 * A single `.bak.latest` rather than a timestamped series: the value is being able
 * to undo the install that just ran, and an unbounded pile of backups in someone's
 * home directory is litter, not safety.
 */
export function applyConfig(spec: ClientSpec, projectRoot: string, launch: LaunchSpec): ApplyResult {
  const path = spec.path(projectRoot);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const entry = buildEntry(spec, launch);
  const merged =
    spec.format === 'toml' ? mergeTomlConfig(existing, entry) : mergeJsonConfig(existing, spec, entry);

  if (!merged.changed) return { path, changed: false };

  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existing !== undefined) {
    backup = `${path}.bak.latest`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, merged.content);
  return { path, changed: true, ...(backup ? { backup } : {}) };
}

/**
 * Remove this plugin's MCP entry from a client config, leaving other servers alone.
 *
 * Uninstall must be as surgical as install: the file usually holds the user's other
 * MCP servers, so the entry is deleted rather than the file.
 */
export function removeConfig(spec: ClientSpec, projectRoot: string): ApplyResult {
  const path = spec.path(projectRoot);
  if (!existsSync(path)) return { path, changed: false };
  const existing = readFileSync(path, 'utf8');

  let content: string;
  if (spec.format === 'toml') {
    content = removeTomlTable(existing, `mcp_servers.${SERVER_KEY}`);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { path, changed: false };
    }
    let cursor = parsed as Record<string, unknown>;
    for (const key of spec.serverMapKey ?? ['mcpServers']) {
      const next = cursor?.[key];
      if (!next || typeof next !== 'object') return { path, changed: false };
      cursor = next as Record<string, unknown>;
    }
    if (!(SERVER_KEY in cursor)) return { path, changed: false };
    delete cursor[SERVER_KEY];
    content = `${JSON.stringify(parsed, null, 2)}\n`;
  }

  if (content === existing) return { path, changed: false };
  const backup = `${path}.bak.latest`;
  copyFileSync(path, backup);
  writeFileSync(path, content);
  return { path, changed: true, backup };
}
