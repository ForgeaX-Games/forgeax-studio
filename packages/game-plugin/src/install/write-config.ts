/**
 * Turning a client spec plus a launch command into an edited config file.
 *
 * The merge is pure and the IO is a thin shell around it, so the interesting part —
 * "does this preserve everything the user already had?" — is testable against real
 * strings without touching a home directory.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { ClientSpec, LaunchSpec } from './clients';
import { SERVER_KEY } from './clients';
import {
  encodeTomlString,
  encodeTomlStringArray,
  hasCompetingTomlDefinition,
  hasTomlTable,
  readTomlTable,
  removeTomlTable,
  upsertTomlTable,
} from './toml-section';

const JSON_WHITESPACE = /^[ \t\r\n]*$/;

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

interface JsonMember {
  readonly key: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly value: JsonNode;
}

interface JsonNode {
  readonly type: 'object' | 'array' | 'primitive';
  readonly start: number;
  readonly end: number;
  readonly members?: readonly JsonMember[];
}

/**
 * A small JSON parser that retains UTF-16 offsets for every object value.  JSON.parse
 * is still used for semantic comparison, but serialising the whole document would
 * destroy comments-like spacing, key ordering, and newline style around foreign
 * MCP entries.  This parser lets install replace only the owned member value.
 */
class JsonRangeParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): JsonNode {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) throw new Error('trailing data after JSON value');
    return value;
  }

  private parseValue(): JsonNode {
    this.skipWhitespace();
    const start = this.index;
    const char = this.source[this.index];
    if (char === '{') return this.parseObject(start);
    if (char === '[') return this.parseArray(start);
    if (char === '"') {
      this.parseString();
      return { type: 'primitive', start, end: this.index };
    }
    if (char === '-' || (char !== undefined && /[0-9]/.test(char))) {
      this.parseNumber();
      return { type: 'primitive', start, end: this.index };
    }
    for (const literal of ['true', 'false', 'null']) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return { type: 'primitive', start, end: this.index };
      }
    }
    throw new Error(`unexpected JSON token at offset ${this.index}`);
  }

  private parseObject(start: number): JsonNode {
    this.index++;
    const members: JsonMember[] = [];
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index++;
      return { type: 'object', start, end: this.index, members };
    }
    while (this.index < this.source.length) {
      this.skipWhitespace();
      const keyStart = this.index;
      const encodedKey = this.parseString();
      let key: unknown;
      try {
        key = JSON.parse(encodedKey);
      } catch {
        throw new Error(`invalid JSON object key at offset ${keyStart}`);
      }
      if (typeof key !== 'string') throw new Error(`JSON object key is not a string at offset ${keyStart}`);
      if (seen.has(key)) throw new Error(`duplicate JSON object key ${JSON.stringify(key)}`);
      seen.add(key);
      const keyEnd = this.index;
      this.skipWhitespace();
      if (this.source[this.index] !== ':') throw new Error(`missing ':' after JSON key at offset ${this.index}`);
      this.index++;
      const value = this.parseValue();
      members.push({ key, keyStart, keyEnd, value });
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === '}') {
        this.index++;
        return { type: 'object', start, end: this.index, members };
      }
      if (delimiter !== ',') throw new Error(`missing ',' in JSON object at offset ${this.index}`);
      this.index++;
      this.skipWhitespace();
      if (this.source[this.index] === '}') throw new Error(`trailing comma in JSON object at offset ${this.index}`);
    }
    throw new Error('unterminated JSON object');
  }

  private parseArray(start: number): JsonNode {
    this.index++;
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index++;
      return { type: 'array', start, end: this.index };
    }
    while (this.index < this.source.length) {
      this.parseValue();
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === ']') {
        this.index++;
        return { type: 'array', start, end: this.index };
      }
      if (delimiter !== ',') throw new Error(`missing ',' in JSON array at offset ${this.index}`);
      this.index++;
      this.skipWhitespace();
      if (this.source[this.index] === ']') throw new Error(`trailing comma in JSON array at offset ${this.index}`);
    }
    throw new Error('unterminated JSON array');
  }

  private parseString(): string {
    const start = this.index;
    if (this.source[this.index] !== '"') throw new Error(`expected JSON string at offset ${this.index}`);
    this.index++;
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      if (char === '"') {
        this.index++;
        const encoded = this.source.slice(start, this.index);
        try {
          JSON.parse(encoded);
          return encoded;
        } catch {
          throw new Error(`invalid JSON string at offset ${start}`);
        }
      }
      if (char === '\\') {
        this.index += 1;
        if (this.index >= this.source.length) throw new Error(`unterminated JSON escape at offset ${start}`);
        if (this.source[this.index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) {
            throw new Error(`invalid JSON unicode escape at offset ${this.index}`);
          }
          this.index += 5;
        } else {
          this.index += 1;
        }
        continue;
      }
      if (char.charCodeAt(0) < 0x20) throw new Error(`control character in JSON string at offset ${this.index}`);
      this.index++;
    }
    throw new Error(`unterminated JSON string at offset ${start}`);
  }

  private parseNumber(): void {
    const remaining = this.source.slice(this.index);
    const match = remaining.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) throw new Error(`invalid JSON number at offset ${this.index}`);
    this.index += match[0].length;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && /[ \t\r\n]/.test(this.source[this.index]!)) this.index++;
  }
}

function jsonObjectMembers(node: JsonNode, label: string): readonly JsonMember[] {
  if (node.type !== 'object' || !node.members) {
    throw new Error(`${label} must be a JSON object; refusing to overwrite existing user data`);
  }
  return node.members;
}

function jsonMember(members: readonly JsonMember[], key: string, label: string): JsonMember | undefined {
  const found = members.filter((member) => member.key === key);
  if (found.length > 1) throw new Error(`${label} contains duplicate ${JSON.stringify(key)} keys`);
  return found[0];
}

function replaceJsonValue(source: string, value: JsonNode, replacement: string): string {
  return `${source.slice(0, value.start)}${replacement}${source.slice(value.end)}`;
}

function appendJsonMember(
  source: string,
  object: JsonNode,
  members: readonly JsonMember[],
  key: string,
  value: string,
): string {
  const encoded = `${JSON.stringify(key)}:${value}`;
  if (members.length === 0) {
    // Keep all original interior whitespace after the inserted member.  Inserting at
    // the opening brace is valid for both compact and pretty-printed objects and
    // leaves every pre-existing byte outside this new owned range untouched.
    return `${source.slice(0, object.start + 1)}${encoded}${source.slice(object.start + 1)}`;
  }
  const last = members[members.length - 1]!;
  return `${source.slice(0, last.value.end)},${encoded}${source.slice(last.value.end)}`;
}

function parseJsonForMerge(existing: string, path: string): { readonly source: string; readonly root: JsonNode } {
  try {
    const root = new JsonRangeParser(existing).parse();
    return { source: existing, root };
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Validate the framing that the surgical TOML editor relies on.  Foreign values are
 * intentionally opaque, but an unclosed string/bracket would make the file invalid
 * after we append or replace the owned table.  This scanner understands TOML's
 * single/basic and triple-quoted strings, comments, arrays, and inline tables without
 * pretending to be a general TOML parser.
 */
function validateTomlSyntax(source: string): void {
  let quote: 'basic' | 'literal' | 'basic-multiline' | 'literal-multiline' | undefined;
  const brackets: string[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote === 'basic') {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === '"') quote = undefined;
      continue;
    }
    if (quote === 'literal') {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === 'basic-multiline') {
      if (char === '\\') {
        index++;
        continue;
      }
      if (source.startsWith('"""', index)) {
        quote = undefined;
        index += 2;
      }
      continue;
    }
    if (quote === 'literal-multiline') {
      if (source.startsWith("'''", index)) {
        quote = undefined;
        index += 2;
      }
      continue;
    }
    if (char === '#') {
      const newline = source.indexOf('\n', index);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        quote = 'basic-multiline';
        index += 2;
      } else {
        quote = 'basic';
      }
      continue;
    }
    if (char === "'") {
      if (source.startsWith("'''", index)) {
        quote = 'literal-multiline';
        index += 2;
      } else {
        quote = 'literal';
      }
      continue;
    }
    if (char === '[' || char === '{') {
      brackets.push(char);
      continue;
    }
    if (char === ']' || char === '}') {
      const opener = char === ']' ? '[' : '{';
      if (brackets.pop() !== opener) throw new Error(`unmatched TOML delimiter ${char} at offset ${index}`);
    }
  }
  if (quote) throw new Error('unterminated TOML string');
  if (brackets.length) throw new Error('unterminated TOML array or inline table');
}

function validTomlTableHeader(line: string): boolean {
  const arrayTable = line.startsWith('[[');
  const openingWidth = arrayTable ? 2 : 1;
  let quote: 'basic' | 'literal' | undefined;
  for (let index = openingWidth; index < line.length; index++) {
    const char = line[index]!;
    if (quote === 'basic') {
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === '"') quote = undefined;
      continue;
    }
    if (quote === 'literal') {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '"') {
      quote = 'basic';
      continue;
    }
    if (char === "'") {
      quote = 'literal';
      continue;
    }
    const closes = arrayTable ? line.startsWith(']]', index) : char === ']';
    if (!closes) continue;
    const body = line.slice(openingWidth, index).trim();
    const suffix = line.slice(index + openingWidth);
    return body.length > 0 && /^[ \t]*(?:#.*)?$/.test(suffix);
  }
  return false;
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
  serverKey = SERVER_KEY,
): MergeResult {
  const path = spec.path('');
  const mapKey = spec.serverMapKey ?? ['mcpServers'];
  const wanted = JSON.stringify(entry);
  if (!existing || existing.trim() === '') {
    if (existing && JSON_WHITESPACE.test(existing)) {
      let nested: Record<string, unknown> = { [serverKey]: entry };
      for (let index = mapKey.length - 1; index >= 0; index--) {
        nested = { [mapKey[index]!] : nested };
      }
      return { content: `${existing}${JSON.stringify(nested)}\n`, changed: true };
    }
    let nested: Record<string, unknown> = { [serverKey]: entry };
    for (let index = mapKey.length - 1; index >= 0; index--) {
      nested = { [mapKey[index]!] : nested };
    }
    return { content: `${JSON.stringify(nested, null, 2)}\n`, changed: true };
  }

  const { source, root } = parseJsonForMerge(existing, path);
  const rootMembers = jsonObjectMembers(root, `${path} top level`);
  // Walk the configured native map path.  If an intermediate object is absent,
  // append the complete remaining object in one insertion so all original bytes are
  // still preserved.  This keeps the old helper useful to diagnostics while the
  // frozen install path uses the three one-level `mcpServers` maps.
  let container = root;
  let members = rootMembers;
  for (let index = 0; index < mapKey.length; index++) {
    const key = mapKey[index]!;
    const found = jsonMember(members, key, path);
    if (!found) {
      let nested: Record<string, unknown> = { [serverKey]: entry };
      for (let nestedIndex = mapKey.length - 1; nestedIndex >= index; nestedIndex--) {
        nested = { [mapKey[nestedIndex]!] : nested };
      }
      return {
        content: appendJsonMember(source, container, members, key, JSON.stringify(nested[key])),
        changed: true,
      };
    }
    const nestedMembers = jsonObjectMembers(found.value, `${path}.${mapKey.slice(0, index + 1).join('.')}`);
    container = found.value;
    members = nestedMembers;
  }
  const mapMembers = members;
  const owned = jsonMember(mapMembers, serverKey, `${path}.${mapKey.join('.')}`);
  if (owned) {
    let before: unknown;
    try {
      before = JSON.parse(source.slice(owned.value.start, owned.value.end));
    } catch {
      throw new Error(`${path}.mcpServers.${serverKey} is not valid JSON`);
    }
    if (JSON.stringify(before) === wanted) return { content: existing, changed: false };
    return { content: replaceJsonValue(source, owned.value, wanted), changed: true };
  }
  return {
    content: appendJsonMember(source, container, mapMembers, serverKey, wanted),
    changed: true,
  };
}

/** Merge into Codex's TOML, touching only the `mcp_servers.forgeax` table. */
export function mergeTomlConfig(
  existing: string | undefined,
  entry: Record<string, unknown>,
  serverKey = SERVER_KEY,
): MergeResult {
  if (existing !== undefined && existing.trim() !== '') {
    validateTomlSyntax(existing);
    // This editor intentionally treats foreign TOML values as opaque, but it must
    // not append a managed table to a document whose table framing is already
    // malformed.  Header lines are the boundaries used by the surgical replacer;
    // an unmatched bracket would make the owned range unknowable.
    for (const [index, line] of existing.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && !validTomlTableHeader(trimmed)) {
        throw new Error(`line ${index + 1} has an invalid TOML table header`);
      }
    }
  }
  const body: string[] = [];
  const command = entry.command;
  if (typeof command === 'string') body.push(`command = ${encodeTomlString(command)}`);
  const args = entry.args;
  if (Array.isArray(args)) body.push(`args = ${encodeTomlStringArray(args as string[])}`);

  const content = upsertTomlTable(existing ?? '', { header: `mcp_servers.${serverKey}`, body });
  return { content, changed: content !== (existing ?? '') };
}

export interface ApplyResult {
  readonly path: string;
  readonly changed: boolean;
  /** Path of the backup taken before overwriting, when one was needed. */
  readonly backup?: string;
}

export type ConfigState = 'missing' | 'not_configured' | 'current' | 'different' | 'invalid';

function jsonServerEntry(parsed: unknown, spec: ClientSpec, serverKey: string): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  let cursor: unknown = parsed;
  for (const key of spec.serverMapKey ?? ['mcpServers']) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
  return (cursor as Record<string, unknown>)[serverKey];
}

function gameVersionFromEntryText(entry: string): string {
  const pinned = entry.match(/@forgeax\/game@([0-9A-Za-z][0-9A-Za-z.+_-]*)/);
  if (pinned) return pinned[1]!;
  if (entry.includes('@forgeax/game')) return 'unversioned';
  return 'local/custom';
}

/** Read the package identity currently configured for one client's owned MCP entry. */
export function configuredGameVersion(
  spec: ClientSpec,
  projectRoot: string,
  serverKey = SERVER_KEY,
): string | undefined {
  const path = spec.path(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const existing = readFileSync(path, 'utf8');
    if (spec.format === 'toml') {
      const table = readTomlTable(existing, `mcp_servers.${serverKey}`);
      return table === undefined ? undefined : gameVersionFromEntryText(table);
    }
    const entry = jsonServerEntry(JSON.parse(existing) as unknown, spec, serverKey);
    return entry === undefined ? undefined : gameVersionFromEntryText(JSON.stringify(entry));
  } catch {
    return undefined;
  }
}

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
  serverKey = SERVER_KEY,
): { readonly path: string; readonly state: ConfigState; readonly detail?: string } {
  const path = spec.path(projectRoot);
  if (!existsSync(path)) return { path, state: 'missing' };

  let existing: string;
  try {
    existing = readFileSync(path, 'utf8');
    if (spec.format === 'toml') {
      const header = `mcp_servers.${serverKey}`;
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
        state: mergeTomlConfig(existing, buildEntry(spec, launch), serverKey).changed ? 'different' : 'current',
      };
    }

    const parsed = JSON.parse(existing) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { path, state: 'invalid', detail: 'top level is not a JSON object' };
    }
    const entry = jsonServerEntry(parsed, spec, serverKey);
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
export function applyConfig(
  spec: ClientSpec,
  projectRoot: string,
  launch: LaunchSpec,
  serverKey = SERVER_KEY,
): ApplyResult {
  const path = spec.path(projectRoot);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const entry = buildEntry(spec, launch);
  const merged =
    spec.format === 'toml'
      ? mergeTomlConfig(existing, entry, serverKey)
      : mergeJsonConfig(existing, spec, entry, serverKey);

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
export function removeConfig(spec: ClientSpec, projectRoot: string, serverKey = SERVER_KEY, backupSuffix = '.bak.latest'): ApplyResult {
  const path = spec.path(projectRoot);
  if (!existsSync(path)) return { path, changed: false };
  const existing = readFileSync(path, 'utf8');

  let content: string;
  if (spec.format === 'toml') {
    content = removeTomlTable(existing, `mcp_servers.${serverKey}`);
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
    if (!(serverKey in cursor)) return { path, changed: false };
    delete cursor[serverKey];
    content = `${JSON.stringify(parsed, null, 2)}\n`;
  }

  if (content === existing) return { path, changed: false };
  const backup = `${path}${backupSuffix}`;
  copyFileSync(path, backup);
  writeFileSync(path, content);
  return { path, changed: true, backup };
}

/** Retire only an exact package-generated Asset3D launcher; never a custom server. */
export function retireAsset3dConfig(spec: ClientSpec, projectRoot: string): 'absent' | 'removed' | 'preserved' {
  const key = 'asset3d-search';
  const path = spec.path(projectRoot);
  if (!existsSync(path)) return 'absent';
  try {
    const text = readFileSync(path, 'utf8');
    let entry: Record<string, unknown> | undefined;
    if (spec.format === 'toml') {
      const table = readTomlTable(text, `mcp_servers.${key}`);
      if (table === undefined) {
        return hasCompetingTomlDefinition(text, `mcp_servers.${key}`) ? 'preserved' : 'absent';
      }
      // Old installers emitted JSON-compatible strings/arrays. Other TOML forms
      // remain user-owned rather than introducing another config parser.
      const command = table.match(/^command\s*=\s*(".*")\s*$/m)?.[1];
      const args = table.match(/^args\s*=\s*(\[.*\])\s*$/m)?.[1];
      if (!command || !args) return 'preserved';
      entry = { command: JSON.parse(command), args: JSON.parse(args) };
      const expected = readTomlTable(mergeTomlConfig(undefined, entry, key).content, `mcp_servers.${key}`);
      if (table.trim() !== expected?.trim() || /^\s*\[.*asset3d-search.*\.\s*[\w"']/m.test(text)) return 'preserved';
    } else {
      entry = jsonServerEntry(JSON.parse(text), spec, key) as Record<string, unknown> | undefined;
      if (entry === undefined) return 'absent';
    }
    if (!entry || typeof entry !== 'object') return 'preserved';
    const command = spec.commandShape === 'argv' && Array.isArray(entry.command) ? entry.command[0] : entry.command;
    const args = spec.commandShape === 'argv' && Array.isArray(entry.command) ? entry.command.slice(1) : entry.args;
    if (typeof command !== 'string' || !Array.isArray(args) || !args.every(x => typeof x === 'string')) return 'preserved';
    const published = command === 'npx' && args.length === 6 && args[0] === '-y' && args[1] === '-p' &&
      /^@forgeax\/game@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(args[2]) &&
      args[3] === 'forgeax-game' && args[4] === 'asset3d' && args[5] === 'mcp';
    let local = false;
    if (isAbsolute(command) && /^(node|node.exe)$/.test(basename(command)) && args.length === 3 &&
        isAbsolute(args[0]) && args[1] === 'asset3d' && args[2] === 'mcp' &&
        basename(args[0]) === 'main.js' && basename(dirname(args[0])) === 'dist') {
      const pkg = JSON.parse(readFileSync(resolve(dirname(args[0]), '..', 'package.json'), 'utf8'));
      local = pkg.name === '@forgeax/game';
    }
    if (!(published || local) || inspectConfig(spec, projectRoot, { command, args }, key).state !== 'current') return 'preserved';
    return removeConfig(spec, projectRoot, key, '.asset3d-retired.bak').changed ? 'removed' : 'absent';
  } catch {
    return 'preserved';
  }
}
