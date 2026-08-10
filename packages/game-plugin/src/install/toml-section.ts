/**
 * Surgical TOML editing for Codex's `config.toml`.
 *
 * This package has no runtime dependencies, so there is no TOML parser here — and a
 * hand-written one would be the wrong risk to take with a file that holds a user's
 * entire Codex configuration. Instead this only ever recognises and replaces the one
 * table it owns, treating every other byte of the file as opaque. Anything it does not
 * understand, it does not touch.
 */

export interface TomlTable {
  /** Dotted table header without brackets, e.g. `mcp_servers.forgeax`. */
  readonly header: string;
  /** Key/value lines, already TOML-encoded. */
  readonly body: readonly string[];
}

/** Match a table header line, including a legal trailing comment. */
const HEADER_RE = /^[ \t]*\[([^[\]\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gm;

function parseSimpleDottedKey(header: string): string[] | undefined {
  const parts = header.split(/\s*\.\s*/);
  const decoded: string[] = [];
  for (const part of parts) {
    if (/^[A-Za-z0-9_-]+$/.test(part)) {
      decoded.push(part);
      continue;
    }
    if (part.startsWith('"') && part.endsWith('"')) {
      try {
        const jsonCompatible = part.replace(/\\U([0-9a-fA-F]{8})/g, (_match, hex: string) =>
          String.fromCodePoint(Number.parseInt(hex, 16)),
        );
        const value = JSON.parse(jsonCompatible) as unknown;
        if (typeof value !== 'string') return undefined;
        decoded.push(value);
        continue;
      } catch {
        return undefined;
      }
    }
    if (part.startsWith("'") && part.endsWith("'") && !part.slice(1, -1).includes("'")) {
      decoded.push(part.slice(1, -1));
      continue;
    }
    return undefined;
  }
  return decoded;
}

function sameHeader(actual: string, expected: string): boolean {
  const left = parseSimpleDottedKey(actual.trim());
  const right = parseSimpleDottedKey(expected.trim());
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function assignmentPath(line: string): string[] | undefined {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return undefined;
    if (char === '=') return parseSimpleDottedKey(line.slice(0, i).trim());
  }
  return undefined;
}

function hasAssignment(content: string, expectedPath: readonly string[]): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => JSON.stringify(assignmentPath(line)) === JSON.stringify(expectedPath));
}

function hasCompetingInlineOwner(
  content: string,
  tableHeader: string,
  headerLines: readonly RegExpMatchArray[],
): boolean {
  const path = parseSimpleDottedKey(tableHeader);
  if (!path || path.length < 2) return false;
  if (hasAssignment(content, path)) return true;
  if (hasAssignment(content, [path[0]!])) return true;

  const parent = path.slice(0, -1).join('.');
  const leaf = path.at(-1)!;
  const parentIndex = headerLines.findIndex((match) => sameHeader(match[1]!, parent));
  if (parentIndex < 0) return false;
  const start = headerLines[parentIndex]!.index! + headerLines[parentIndex]![0].length;
  const end = headerLines[parentIndex + 1]?.index ?? content.length;
  return hasAssignment(content.slice(start, end), [leaf]);
}

export function encodeTomlString(value: string): string {
  return JSON.stringify(value);
}

export function encodeTomlStringArray(values: readonly string[]): string {
  return `[${values.map(encodeTomlString).join(', ')}]`;
}

export function renderTable(table: TomlTable): string {
  return [`[${table.header}]`, ...table.body].join('\n');
}

/**
 * Insert or replace a single table, returning the new file content.
 *
 * A table's extent runs from its header to the next header or end of file, which is
 * exactly TOML's own scoping rule, so replacing that span cannot swallow a neighbour's
 * keys.
 */
export function upsertTomlTable(content: string, table: TomlTable): string {
  const rendered = renderTable(table);
  if (content.trim() === '') return `${rendered}\n`;

  const headerLines = [...content.matchAll(HEADER_RE)];
  if (hasCompetingInlineOwner(content, table.header, headerLines)) {
    throw new Error(
      `TOML already defines [${table.header}] through an inline or parent-table key; refusing to append a duplicate table.`,
    );
  }
  const ownedIndexes = headerLines.flatMap((match, index) =>
    sameHeader(match[1]!, table.header) ? [index] : [],
  );
  if (ownedIndexes.length > 1) {
    throw new Error(`TOML contains duplicate tables equivalent to [${table.header}]; fix the file before installing.`);
  }
  const ownedIndex = ownedIndexes[0] ?? -1;
  if (ownedIndex === -1) {
    return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${rendered}\n`;
  }

  const owned = headerLines[ownedIndex]!;
  const next = headerLines[ownedIndex + 1];
  const start = owned.index!;
  const end = next?.index ?? content.length;
  const prefix = content.slice(0, start);
  const suffix = content.slice(end);
  const renderedOwned = [owned[0].replace(/\r$/, ''), ...table.body].join('\n');
  return `${prefix}${renderedOwned}\n${suffix ? '\n' : ''}${suffix}`;
}

/** Whether the file already declares this table. */
export function hasTomlTable(content: string, header: string): boolean {
  return [...content.matchAll(HEADER_RE)].some((match) => sameHeader(match[1]!, header));
}

export function hasCompetingTomlDefinition(content: string, header: string): boolean {
  const headerLines = [...content.matchAll(HEADER_RE)];
  return hasCompetingInlineOwner(content, header, headerLines);
}

/**
 * Drop a table and its body from a TOML document.
 *
 * Symmetric with `upsertTomlTable`: the same header match, so uninstall removes exactly
 * what install wrote and leaves neighbouring tables untouched.
 */
export function removeTomlTable(content: string, header: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = /^\[[^\]]+\]$/.test(trimmed);
    if (isHeader) {
      const name = trimmed.slice(1, -1).replace(/"/g, '');
      // Also drop nested tables such as `[mcp_servers.forgeax.env]`.
      skipping = name === header || name.startsWith(`${header}.`);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
