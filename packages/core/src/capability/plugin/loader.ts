/**
 * Plugin loader (Wave2 PLUGIN).
 *
 * `loadPlugins(sources)` scans each source directory, reads `plugin.json`,
 * validates it (self-written, no zod), and discovers the 5 component
 * directories (commands/ agents/ skills/ hooks/ output-styles/). The hooks
 * component's `hooks/hooks.json` is additionally parsed into a `hooksConfig`
 * so `pluginToCapabilityPack` can wire it onto the EventBus.
 *
 * `mergePluginSources({session, marketplace, builtin})` applies precedence
 * **session > marketplace > builtin**: a plugin name found in a
 * higher-precedence source fully overrides the same name in a lower one
 * (whole-plugin override, last-wins, no per-file merge — same discipline as the
 * CapabilityLoader's whole-pack override).
 *
 * Boundary: only core-local relatives + node:fs / node:path.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPONENT_DEFAULT_DIR,
  PLUGIN_COMPONENTS,
  validateManifest,
  type ComponentDecl,
  type ManifestMcpServers,
  type PluginComponent,
  type PluginManifest,
} from './manifest';
import type {
  LoadedPlugin,
  PluginHooksConfig,
  PluginLspServerConfig,
  PluginMcpServerConfig,
  PluginSourceKind,
} from './loaded';

// ─── 注入面 ──────────────────────────────────────────────────────────────────

/** A plugin source = a provenance group + the directory whose subdirs are plugins. */
export interface PluginSource {
  readonly source: PluginSourceKind;
  readonly dir: string;
}

/** Errors collected during a scan (non-fatal; the rest still loads). */
export interface PluginLoadError {
  source: PluginSourceKind;
  path: string;
  reason: string;
}

export interface LoadPluginsResult {
  plugins: LoadedPlugin[];
  errors: PluginLoadError[];
}

const MANIFEST_FILE = 'plugin.json';

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map a top-level component declaration (`path | path[] | map`) to the flat
 * list of relative paths it points at. The object-mapping arm (e.g. command
 * name → {source} / path) yields the string-ish leaves; non-string leaves are
 * ignored at the core layer (their metadata is a higher-layer concern).
 */
function declToRelPaths(decl: ComponentDecl | undefined): string[] {
  if (decl === undefined) return [];
  if (typeof decl === 'string') return [decl];
  if (Array.isArray(decl)) return decl;
  // object mapping: collect string values, or `.source` of object values
  const out: string[] = [];
  for (const v of Object.values(decl)) {
    if (typeof v === 'string') out.push(v);
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const src = (v as Record<string, unknown>).source;
      if (typeof src === 'string') out.push(src);
    }
  }
  return out;
}

/** Resolve declared relative paths against the plugin root, keeping only existers. */
function resolveDeclaredPaths(
  pluginDir: string,
  decl: ComponentDecl | undefined,
  source: PluginSourceKind,
  errors: PluginLoadError[],
): string[] {
  const out: string[] = [];
  for (const rel of declToRelPaths(decl)) {
    const full = join(pluginDir, rel);
    if (safeExists(full)) out.push(full);
    else
      errors.push({
        source,
        path: full,
        reason: `declared component path not found: ${rel}`,
      });
  }
  return out;
}

/**
 * Read + parse a JSON file holding MCP/LSP server configs. Accepts either the
 * `.mcp.json` wrapper shape `{ mcpServers: {...} }` (or `{ lspServers: {...} }`)
 * or a bare `{ name: config }` map. Returns the server map, or undefined on
 * ENOENT / malformed payload (errors are recorded, load continues).
 */
function readServersFile(
  filePath: string,
  wrapperKey: 'mcpServers' | 'lspServers',
  source: PluginSourceKind,
  errors: PluginLoadError[],
): Record<string, Record<string, unknown>> | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    errors.push({ source, path: filePath, reason: (e as Error).message });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push({ source, path: filePath, reason: `invalid JSON: ${(e as Error).message}` });
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({ source, path: filePath, reason: `${filePath} must be a JSON object` });
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const inner =
    obj[wrapperKey] !== undefined &&
    obj[wrapperKey] !== null &&
    typeof obj[wrapperKey] === 'object' &&
    !Array.isArray(obj[wrapperKey])
      ? (obj[wrapperKey] as Record<string, unknown>)
      : obj;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(inner)) {
    if (cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)) {
      out[name] = cfg as Record<string, unknown>;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve a plugin's MCP servers:
 *  1. default `.mcp.json` in the plugin root (lowest priority), then
 *  2. manifest `mcpServers`: inline object | json-file path | array of either
 *     (later entries override earlier on name collision — last wins).
 * Inline objects merge directly; string entries are loaded as json files.
 * Returns the merged map, or undefined when empty.
 */
function resolveMcpServers(
  pluginDir: string,
  decl: ManifestMcpServers | undefined,
  source: PluginSourceKind,
  errors: PluginLoadError[],
): Record<string, PluginMcpServerConfig> | undefined {
  let servers: Record<string, PluginMcpServerConfig> = {};

  // 1. default .mcp.json (lowest priority)
  const fromDefault = readServersFile(
    join(pluginDir, '.mcp.json'),
    'mcpServers',
    source,
    errors,
  );
  if (fromDefault) servers = { ...servers, ...fromDefault };

  // 2. manifest mcpServers (higher priority)
  if (decl !== undefined) {
    const specs: Array<string | Record<string, unknown>> = Array.isArray(decl)
      ? decl
      : [decl as string | Record<string, unknown>];
    for (const spec of specs) {
      if (typeof spec === 'string') {
        const fromFile = readServersFile(
          join(pluginDir, spec),
          'mcpServers',
          source,
          errors,
        );
        if (fromFile) servers = { ...servers, ...fromFile };
      } else {
        servers = { ...servers, ...normalizeServerMap(spec) };
      }
    }
  }

  return Object.keys(servers).length > 0 ? servers : undefined;
}

/**
 * Coerce an inline manifest server map (`{ name: config }`, values typed
 * `unknown`) into `Record<string, Record<string, unknown>>`, keeping only
 * object-valued configs. Transport internals stay opaque (no zod).
 */
function normalizeServerMap(
  spec: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(spec)) {
    if (cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)) {
      out[name] = cfg as Record<string, unknown>;
    }
  }
  return out;
}

/** LSP-server counterpart of resolveMcpServers (no default-file probe). */
function resolveLspServers(
  pluginDir: string,
  decl: ManifestMcpServers | undefined,
  source: PluginSourceKind,
  errors: PluginLoadError[],
): Record<string, PluginLspServerConfig> | undefined {
  if (decl === undefined) return undefined;
  let servers: Record<string, PluginLspServerConfig> = {};
  const specs: Array<string | Record<string, unknown>> = Array.isArray(decl)
    ? decl
    : [decl as string | Record<string, unknown>];
  for (const spec of specs) {
    if (typeof spec === 'string') {
      const fromFile = readServersFile(
        join(pluginDir, spec),
        'lspServers',
        source,
        errors,
      );
      if (fromFile) servers = { ...servers, ...fromFile };
    } else {
      servers = { ...servers, ...normalizeServerMap(spec) };
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/** The manifest declaration for a component kind (camelCase key for output-styles). */
function declForComponent(
  manifest: PluginManifest,
  kind: PluginComponent,
): ComponentDecl | undefined {
  switch (kind) {
    case 'commands':
      return manifest.commands;
    case 'agents':
      return manifest.agents;
    case 'skills':
      return manifest.skills;
    case 'output-styles':
      return manifest.outputStyles; // ⚠️ camelCase manifest key
    case 'hooks':
      return manifest.hooks;
  }
}

/**
 * Parse a plugin's `hooks/hooks.json` into a PluginHooksConfig.
 *
 * Accepts either the wrapper shape `{ hooks: { <event>: [...] } }` or a bare
 * `{ <event>: [...] }` map. Returns undefined (and pushes an error) on
 * malformed JSON or a non-object payload. Matcher groups are normalized so each
 * has a `hooks` array.
 */
function parseHooksConfig(
  hooksJsonPath: string,
  source: PluginSourceKind,
  errors: PluginLoadError[],
): PluginHooksConfig | undefined {
  const hooksJson = hooksJsonPath;
  let raw: string;
  try {
    raw = readFileSync(hooksJson, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined; // hooks/ dir without hooks.json
    errors.push({ source, path: hooksJson, reason: (e as Error).message });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    errors.push({ source, path: hooksJson, reason: `invalid JSON: ${(e as Error).message}` });
    return undefined;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({ source, path: hooksJson, reason: 'hooks.json must be a JSON object' });
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  // unwrap `{ hooks: {...} }` wrapper if present
  const body =
    obj.hooks !== undefined &&
    obj.hooks !== null &&
    typeof obj.hooks === 'object' &&
    !Array.isArray(obj.hooks)
      ? (obj.hooks as Record<string, unknown>)
      : obj;

  const config: PluginHooksConfig = {};
  for (const [event, groups] of Object.entries(body)) {
    if (!Array.isArray(groups)) {
      errors.push({ source, path: hooksJson, reason: `hooks.${event}: must be an array of matcher groups` });
      continue;
    }
    const norm = [];
    for (const g of groups) {
      if (g === null || typeof g !== 'object') continue;
      const gr = g as Record<string, unknown>;
      const actionsRaw = Array.isArray(gr.hooks) ? gr.hooks : [];
      const actions = [];
      for (const a of actionsRaw) {
        if (a === null || typeof a !== 'object') continue;
        const act = a as Record<string, unknown>;
        if (typeof act.command !== 'string') continue;
        actions.push({
          type: 'command' as const,
          command: act.command,
          ...(typeof act.if === 'string' ? { if: act.if } : {}),
          ...(typeof act.timeout === 'number' ? { timeout: act.timeout } : {}),
        });
      }
      norm.push({
        ...(typeof gr.matcher === 'string' ? { matcher: gr.matcher } : {}),
        hooks: actions,
      });
    }
    config[event] = norm;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Load one plugin directory: read + validate plugin.json, discover components.
 * Returns null (and records the error) when there's no valid plugin here.
 */
function loadOnePlugin(
  pluginDir: string,
  source: PluginSourceKind,
  errors: PluginLoadError[],
): LoadedPlugin | null {
  const manifestPath = join(pluginDir, MANIFEST_FILE);
  let rawText: string;
  try {
    rawText = readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // not a plugin dir — silently skip
    errors.push({ source, path: manifestPath, reason: (e as Error).message });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    errors.push({ source, path: manifestPath, reason: `invalid JSON: ${(e as Error).message}` });
    return null;
  }

  const v = validateManifest(parsed);
  if (!v.ok) {
    errors.push({ source, path: manifestPath, reason: v.errors.join('; ') });
    return null;
  }

  const manifest = v.manifest;

  // Discovery = DEFAULT directory ∪ manifest-declared extra paths
  // (`finishLoadingPluginFromPath` semantics). The default dirs are ALWAYS
  // scanned regardless of manifest declarations. The legacy `components` field,
  // if present (deprecated), additionally constrains which *default* dirs we
  // probe — manifest-declared top-level keys are never constrained by it.
  const legacyConstrain = manifest.components;
  const probeDefault = (kind: PluginComponent): boolean =>
    legacyConstrain ? legacyConstrain.includes(kind) : true;

  const plugin: LoadedPlugin = {
    name: manifest.name,
    manifest,
    path: pluginDir,
    source,
    enabled: true,
    componentKinds: [],
  };

  const present = new Set<PluginComponent>();
  const hooksFiles: string[] = []; // hooks.json files to parse + merge

  for (const kind of PLUGIN_COMPONENTS) {
    // (a) always-scanned default directory
    const defaultDir = join(pluginDir, COMPONENT_DEFAULT_DIR[kind]);
    const hasDefault = probeDefault(kind) && safeIsDir(defaultDir);

    // (b) manifest-declared extra paths (top-level key; camel for outputStyles)
    const declaredPaths = resolveDeclaredPaths(
      pluginDir,
      declForComponent(manifest, kind),
      source,
      errors,
    );

    if (!hasDefault && declaredPaths.length === 0) continue;
    present.add(kind);

    switch (kind) {
      case 'commands':
        if (hasDefault) plugin.commandsPath = defaultDir;
        if (declaredPaths.length > 0) plugin.commandsPaths = declaredPaths;
        break;
      case 'agents':
        if (hasDefault) plugin.agentsPath = defaultDir;
        if (declaredPaths.length > 0) plugin.agentsPaths = declaredPaths;
        break;
      case 'skills':
        if (hasDefault) plugin.skillsPath = defaultDir;
        if (declaredPaths.length > 0) plugin.skillsPaths = declaredPaths;
        break;
      case 'output-styles':
        if (hasDefault) plugin.outputStylesPath = defaultDir;
        if (declaredPaths.length > 0) plugin.outputStylesPaths = declaredPaths;
        break;
      case 'hooks':
        if (hasDefault) {
          plugin.hooksPath = defaultDir;
          hooksFiles.push(join(defaultDir, 'hooks.json'));
        }
        // Declared hooks paths may point at a hooks.json file directly, or a
        // directory containing one (both are accepted for the standard layout).
        for (const p of declaredPaths) {
          hooksFiles.push(safeIsDir(p) ? join(p, 'hooks.json') : p);
        }
        break;
    }
  }

  plugin.componentKinds = [...present];

  // Merge every hooks.json (default + declared) into one config. Later files
  // override earlier per event name (last-wins), matching the supplement model.
  let mergedHooks: PluginHooksConfig | undefined;
  for (const hf of hooksFiles) {
    const cfg = parseHooksConfig(hf, source, errors);
    if (!cfg) continue;
    mergedHooks = { ...(mergedHooks ?? {}), ...cfg };
  }
  if (mergedHooks) plugin.hooksConfig = mergedHooks;

  // Resolve MCP / LSP servers (inline ∪ files; `.mcp.json` default for MCP).
  const mcp = resolveMcpServers(pluginDir, manifest.mcpServers, source, errors);
  if (mcp) plugin.mcpServers = mcp;
  const lsp = resolveLspServers(pluginDir, manifest.lspServers, source, errors);
  if (lsp) plugin.lspServers = lsp;

  return plugin;
}

/**
 * Scan all sources and load every plugin found. Does NOT dedupe across sources
 * — pass the result through `mergePluginSources` for precedence/override.
 * Within a single source, later directory entries with a duplicate name win
 * (whole-plugin, last-wins) but that's an authoring mistake; cross-source
 * precedence is the real contract.
 */
export function loadPlugins(sources: readonly PluginSource[]): LoadPluginsResult {
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];

  for (const src of sources) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(src.dir, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // missing source dir → skip quietly
      errors.push({ source: src.source, path: src.dir, reason: `readdir failed: ${(e as Error).message}` });
      continue;
    }
    for (const dirent of entries) {
      if (dirent.name.startsWith('.')) continue;
      const pluginDir = join(src.dir, dirent.name);
      if (!dirent.isDirectory() && !(dirent.isSymbolicLink() && safeIsDir(pluginDir))) {
        continue;
      }
      const loaded = loadOnePlugin(pluginDir, src.source, errors);
      if (loaded) plugins.push(loaded);
    }
  }

  return { plugins, errors };
}

// ─── precedence merge (session > marketplace > builtin) ──────────────────────

/** Increasing precedence: a name in a higher group overrides the same name in a lower one. */
const SOURCE_RANK: Record<PluginSourceKind, number> = {
  builtin: 0,
  marketplace: 1,
  session: 2,
};

export interface PluginSourceBuckets {
  session?: readonly LoadedPlugin[];
  marketplace?: readonly LoadedPlugin[];
  builtin?: readonly LoadedPlugin[];
}

/**
 * Merge already-loaded plugins from the three source groups with precedence
 * **session > marketplace > builtin**. Same name across groups ⇒ the
 * highest-precedence copy wins (whole-plugin override). Returns a name-stable
 * (alphabetical) list. Within the *same* group, last entry wins on duplicate.
 */
export function mergePluginSources(buckets: PluginSourceBuckets): LoadedPlugin[] {
  const winner = new Map<string, { plugin: LoadedPlugin; rank: number }>();

  // Apply in increasing-precedence order so higher ranks overwrite.
  const ordered: Array<[PluginSourceKind, readonly LoadedPlugin[]]> = [
    ['builtin', buckets.builtin ?? []],
    ['marketplace', buckets.marketplace ?? []],
    ['session', buckets.session ?? []],
  ];

  for (const [group, list] of ordered) {
    const rank = SOURCE_RANK[group];
    for (const plugin of list) {
      const prev = winner.get(plugin.name);
      // >= so that within the same rank, last-loaded wins (authoring-dup case);
      // across ranks, the strictly-higher rank always wins.
      if (!prev || rank >= prev.rank) {
        winner.set(plugin.name, { plugin, rank });
      }
    }
  }

  return [...winner.values()]
    .map((w) => w.plugin)
    .sort((a, b) => a.name.localeCompare(b.name));
}
