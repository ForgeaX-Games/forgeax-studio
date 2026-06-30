/**
 * Plugin manifest model + self-written validation (Wave2 PLUGIN).
 *
 * `plugin.json` is the disk contract a plugin author writes. This module models
 * it and validates it WITHOUT zod — core's boundary forbids third-party deps in
 * the capability ABI layer (干净律 §0″). Validation is hand-written against
 * `PluginManifestSchema`.
 *
 * 真实格式(权威): `plugin.json` 顶层直接放组件键(**不是** `components` 数组!),
 * 每个键值是 `path(string) | path[] | {name:path 映射}`,相对 plugin root:
 *
 * `jsonc
 * { "name":"my-plugin","version":"1.2.3","description":"...","author":{...},
 *   "commands":"./cmds", "agents":["./a1","./a2"], "skills":"./skills",
 *   "outputStyles":"./styles",                          // camelCase 键名
 *   "mcpServers": {"srv":{...}} | "./mcp.json",
 *   "hooks":"./hooks/hooks.json", "lspServers":"./lsp" }
 * `
 *
 * Loading rules:
 *  - **未知顶层键容忍**(silently strip,前向兼容 vendor 扩展)。
 *  - 默认目录(无 manifest 声明时仍扫):`commands/ agents/ skills/ output-styles/
 *    hooks/`。⚠️ 磁盘目录是 kebab `output-styles/`,但 manifest 键是 camel
 *    `outputStyles`。
 *  - `name` 仍是唯一必填(kebab-case,无空格/路径分隔符)。
 *  - 向后容错:历史的 `components: PluginComponent[]` 仍被接受(若有人在用),但
 *    主路径走顶层组件键形态。
 *
 * Boundary: only core-local types + node builtins (none needed here). No zod.
 */

/** The 5 plugin component kinds, matching the plugin directory
 *  structure (commands/ agents/ skills/ hooks/ output-styles/). */
export type PluginComponent =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'output-styles';

export const PLUGIN_COMPONENTS: readonly PluginComponent[] = [
  'commands',
  'agents',
  'skills',
  'hooks',
  'output-styles',
];

/**
 * The manifest key (camelCase, as written in plugin.json) for each component
 * kind, plus the default directory (kebab, as found on disk). The quirk:
 * `outputStyles` (manifest key) ↔ `output-styles/` (default dir).
 */
export const COMPONENT_MANIFEST_KEY: Record<PluginComponent, string> = {
  commands: 'commands',
  agents: 'agents',
  skills: 'skills',
  hooks: 'hooks',
  'output-styles': 'outputStyles',
};

export const COMPONENT_DEFAULT_DIR: Record<PluginComponent, string> = {
  commands: 'commands',
  agents: 'agents',
  skills: 'skills',
  hooks: 'hooks',
  'output-styles': 'output-styles',
};

/**
 * A component path declaration as it appears at the manifest top level.
 * Three shapes are accepted per component key:
 *   - `string`            single relative path (file or directory)
 *   - `string[]`          list of relative paths
 *   - `Record<string,…>`  object mapping (e.g. command name → metadata/path)
 *
 * The mapping arm is preserved structurally (object of unknown) — its
 * interpretation (e.g. CommandMetadata) is a higher-layer concern.
 */
export type ComponentDecl =
  | string
  | string[]
  | Record<string, unknown>;

/**
 * Inline or file-referenced MCP server config block. Accepts:
 *   - inline object       `{ "srv": { command, args, ... } }`
 *   - path to a json file `"./mcp.json"` (or array mixing both)
 * The inner server config is kept structurally opaque (no zod) — the host /
 * MCP layer validates transport specifics.
 */
export type ManifestMcpServers =
  | string
  | Array<string | Record<string, unknown>>
  | Record<string, unknown>;

/** LSP servers: path to a json file, inline map, or array mixing both. */
export type ManifestLspServers =
  | string
  | Array<string | Record<string, unknown>>
  | Record<string, unknown>;

/**
 * The `plugin.json` manifest model.
 *
 * - `name` — REQUIRED. kebab-case identifier used for namespacing.
 * - `version` — optional semver string (e.g. `1.2.3`).
 * - `description` — optional user-facing blurb.
 * - `author` — optional free-form author metadata.
 * - `commands` / `agents` / `skills` / `outputStyles` / `hooks` — optional
 *   top-level component declarations (path | path[] | map). These supplement
 *   the always-scanned default directories.
 * - `mcpServers` — optional inline object or json-file path(s).
 * - `lspServers` — optional inline object or json-file path(s).
 * - `components` — DEPRECATED legacy field (explicit component-kind list). Still
 *   accepted for back-compat; constrains default-dir discovery to the named set.
 * - `extra` — captures any tolerated unknown top-level keys (vendor extensions),
 *   so they survive a round-trip without being inspected.
 */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };

  commands?: ComponentDecl;
  agents?: ComponentDecl;
  skills?: ComponentDecl;
  outputStyles?: ComponentDecl;
  hooks?: ComponentDecl;

  mcpServers?: ManifestMcpServers;
  lspServers?: ManifestLspServers;

  /** @deprecated legacy explicit component-kind list; prefer top-level keys. */
  components?: PluginComponent[];

  /** Tolerated unknown top-level keys (forward-compat; not interpreted). */
  extra?: Record<string, unknown>;
}

/** Result of validating a raw `plugin.json` object. */
export type ManifestValidation =
  | { ok: true; manifest: PluginManifest; errors: [] }
  | { ok: false; manifest: null; errors: string[] };

/**
 * kebab-case: lowercase alphanumeric segments joined by single hyphens,
 * starting and ending with an alphanumeric. e.g. `my-plugin`, `db2-helper`.
 * Disallows spaces, path separators, leading/trailing/double hyphens.
 */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Loose semver: MAJOR.MINOR.PATCH with optional `-prerelease` / `+build`.
 * Follows the spirit of the `version` field (it documents semver.org) while
 * staying permissive — we only reject obviously-malformed strings.
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Known top-level manifest keys. Anything else lands in `extra` (tolerated). */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'description',
  'author',
  'commands',
  'agents',
  'skills',
  'outputStyles',
  'hooks',
  'mcpServers',
  'lspServers',
  'components',
]);

function isPluginComponent(x: unknown): x is PluginComponent {
  return (
    typeof x === 'string' &&
    (PLUGIN_COMPONENTS as readonly string[]).includes(x)
  );
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Validate a component declaration (`path | path[] | map`). Pushes
 * human-readable errors keyed by the manifest key. Returns the normalized
 * declaration on success, undefined when absent, null when invalid.
 */
function validateComponentDecl(
  key: string,
  value: unknown,
  errors: string[],
): ComponentDecl | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.length === 0) {
      errors.push(`${key}: path string cannot be empty`);
      return null;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const bad = value.filter((p) => typeof p !== 'string' || p.length === 0);
    if (bad.length > 0) {
      errors.push(`${key}: array entries must be non-empty path strings`);
      return null;
    }
    return value as string[];
  }
  if (isPlainObject(value)) {
    return value;
  }
  errors.push(`${key}: must be a path string, array of paths, or object mapping`);
  return null;
}

/**
 * Validate an mcpServers / lspServers declaration (`json-path | inline-map |
 * array-of-both`). Server-config internals are NOT validated here (no zod;
 * the MCP/LSP layer owns transport validation).
 */
function validateServersDecl(
  key: string,
  value: unknown,
  errors: string[],
):
  | string
  | Array<string | Record<string, unknown>>
  | Record<string, unknown>
  | null
  | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.length === 0) {
      errors.push(`${key}: path string cannot be empty`);
      return null;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out: Array<string | Record<string, unknown>> = [];
    for (const item of value) {
      if (typeof item === 'string') {
        if (item.length === 0) {
          errors.push(`${key}: array entries must be non-empty path strings or inline objects`);
          return null;
        }
        out.push(item);
      } else if (isPlainObject(item)) {
        out.push(item);
      } else {
        errors.push(`${key}: array entries must be path strings or inline objects`);
        return null;
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    return value;
  }
  errors.push(`${key}: must be a json-file path, inline object, or array of either`);
  return null;
}

/**
 * Validate a raw (parsed-JSON) `plugin.json` object.
 *
 * Self-written, fail-closed: returns the full list of human-readable errors so
 * the loader / plugin-validate tooling can surface them all at
 * once rather than dying on the first.
 *
 * Top-level component keys (commands/agents/skills/outputStyles/
 * hooks) + mcpServers/lspServers are recognized; unknown top-level keys are
 * tolerated (captured in `extra`); `name` remains the only required field.
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      manifest: null,
      errors: ['plugin.json must be a JSON object'],
    };
  }
  const obj = raw as Record<string, unknown>;

  // name — required, kebab-case
  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0) {
    errors.push('name: required, must be a non-empty string');
  } else if (name.includes(' ')) {
    errors.push('name: cannot contain spaces (use kebab-case, e.g. "my-plugin")');
  } else if (
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name === '.'
  ) {
    errors.push('name: cannot contain path separators (/ or \\), ".." sequences, or be "."');
  } else if (!KEBAB_RE.test(name)) {
    errors.push('name: must be kebab-case (lowercase alphanumeric segments joined by single hyphens, e.g. "my-plugin")');
  }

  // version — optional, semver-ish
  if (obj.version !== undefined) {
    if (typeof obj.version !== 'string') {
      errors.push('version: must be a string when present');
    } else if (!SEMVER_RE.test(obj.version)) {
      errors.push(`version: "${obj.version}" is not a valid semver (expected MAJOR.MINOR.PATCH)`);
    }
  }

  // description — optional string
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    errors.push('description: must be a string when present');
  }

  // author — optional object with optional string fields
  let author: PluginManifest['author'];
  if (obj.author !== undefined) {
    if (!isPlainObject(obj.author)) {
      errors.push('author: must be an object when present');
    } else {
      const a = obj.author;
      for (const k of ['name', 'email', 'url'] as const) {
        if (a[k] !== undefined && typeof a[k] !== 'string') {
          errors.push(`author.${k}: must be a string when present`);
        }
      }
      author = {
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
        ...(typeof a.email === 'string' ? { email: a.email } : {}),
        ...(typeof a.url === 'string' ? { url: a.url } : {}),
      };
    }
  }

  // top-level component keys (camelCase as written): path | path[] | map
  const commands = validateComponentDecl('commands', obj.commands, errors);
  const agents = validateComponentDecl('agents', obj.agents, errors);
  const skills = validateComponentDecl('skills', obj.skills, errors);
  const outputStyles = validateComponentDecl('outputStyles', obj.outputStyles, errors);
  const hooks = validateComponentDecl('hooks', obj.hooks, errors);

  // mcpServers / lspServers: json-path | inline-map | array-of-both
  const mcpServers = validateServersDecl('mcpServers', obj.mcpServers, errors);
  const lspServers = validateServersDecl('lspServers', obj.lspServers, errors);

  // components — DEPRECATED legacy explicit-kind list (back-compat tolerance)
  let components: PluginComponent[] | undefined;
  if (obj.components !== undefined) {
    if (!Array.isArray(obj.components)) {
      errors.push('components: must be an array when present');
    } else {
      const bad = obj.components.filter((c) => !isPluginComponent(c));
      if (bad.length > 0) {
        errors.push(
          `components: unknown component(s) ${JSON.stringify(bad)}; allowed: ${PLUGIN_COMPONENTS.join(', ')}`,
        );
      } else {
        // de-dup while preserving order
        components = [...new Set(obj.components as PluginComponent[])];
      }
    }
  }

  // Unknown top-level keys: tolerated (silently stripped; we stash in `extra`).
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) extra[k] = obj[k];
  }

  if (errors.length > 0) {
    return { ok: false, manifest: null, errors };
  }

  const manifest: PluginManifest = {
    name: name as string,
    ...(typeof obj.version === 'string' ? { version: obj.version } : {}),
    ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
    ...(author && Object.keys(author).length > 0 ? { author } : {}),
    ...(commands !== undefined && commands !== null ? { commands } : {}),
    ...(agents !== undefined && agents !== null ? { agents } : {}),
    ...(skills !== undefined && skills !== null ? { skills } : {}),
    ...(outputStyles !== undefined && outputStyles !== null ? { outputStyles } : {}),
    ...(hooks !== undefined && hooks !== null ? { hooks } : {}),
    ...(mcpServers !== undefined && mcpServers !== null ? { mcpServers } : {}),
    ...(lspServers !== undefined && lspServers !== null ? { lspServers } : {}),
    ...(components ? { components } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  return { ok: true, manifest, errors: [] };
}
