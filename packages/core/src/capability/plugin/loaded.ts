/**
 * LoadedPlugin — what the loader produces after scanning one plugin directory
 * (Wave2 PLUGIN).
 *
 * The manifest plus
 * the absolute path to each discovered component directory, and the parsed
 * hooks config (the only component whose *content* the core ABI cares about —
 * hooks become EventBus side-effects via `pluginToCapabilityPack`). Commands /
 * agents / skills / output-styles are surfaced as paths only; their content is
 * consumed by higher layers (host), not by the core ABI.
 *
 * Boundary: only core-local types. No node:, no IO.
 */
import type { PluginComponent, PluginManifest } from './manifest';

/**
 * A single hook action, reduced to
 * what the core EventBus needs: a `command` (host executes it) plus an optional
 * `if` permission-rule matcher string.
 */
export interface PluginHookAction {
  type: 'command';
  command: string;
  /** Permission-rule syntax filter (e.g. "Bash(git *)"); host evaluates it. */
  if?: string;
  /** Per-action timeout in seconds. */
  timeout?: number;
}

/** A matcher group: an optional tool/event matcher + the actions to run. */
export interface PluginHookMatcher {
  /** Tool-name / glob matcher (`matcher`); undefined = match all. */
  matcher?: string;
  hooks: PluginHookAction[];
}

/**
 * Parsed `hooks.json` config: event-name → matcher groups. Event names are
 * core EventBus `CoreEvent.type` strings (e.g. "PreToolUse", "PostToolUse",
 * "Stop"). Kept as an open record because the core bus is payload-/type-
 * agnostic by design (§3.2).
 */
export type PluginHooksConfig = Record<string, PluginHookMatcher[]>;

/**
 * A resolved MCP server config attached to a LoadedPlugin. The core ABI does
 * not validate transport specifics (no zod); the config is kept structurally
 * opaque so the host / MCP layer can interpret it. Keyed by server name.
 */
export type PluginMcpServerConfig = Record<string, unknown>;

/** A resolved LSP server config attached to a LoadedPlugin. Keyed by server name. */
export type PluginLspServerConfig = Record<string, unknown>;

/**
 * A fully-loaded plugin: manifest + provenance + per-component paths.
 *
 * `source` records WHICH source group the plugin came from (session /
 * marketplace / builtin) so precedence/override is auditable. `enabled`
 * defaults true; the host may flip it via settings.
 *
 * Each `*Path` is the absolute path to the component directory when present
 * (auto-discovered or manifest-declared); absent when the plugin ships no such
 * component. `componentKinds` is the resolved set actually found on disk.
 */
export interface LoadedPlugin {
  readonly name: string;
  readonly manifest: PluginManifest;
  /** Absolute path to the plugin root directory. */
  readonly path: string;
  /** Provenance group (drives precedence). */
  readonly source: PluginSourceKind;
  enabled: boolean;

  // per-component absolute directory paths from the always-scanned DEFAULT dir
  // (commands/ agents/ skills/ output-styles/ hooks/); present ⇒ default dir exists.
  commandsPath?: string;
  agentsPath?: string;
  skillsPath?: string;
  hooksPath?: string;
  outputStylesPath?: string;

  // Additional absolute paths declared via top-level manifest keys
  // (path | path[] | map), beyond the default directory.
  // `finishLoadingPluginFromPath` semantics: discovered = default ∪ declared.
  commandsPaths?: string[];
  agentsPaths?: string[];
  skillsPaths?: string[];
  outputStylesPaths?: string[];

  /** Component kinds actually present (default dir or declared paths; subset of the 5). */
  componentKinds: PluginComponent[];

  /** Parsed hooks config (from hooks/hooks.json + manifest-declared hooks files). */
  hooksConfig?: PluginHooksConfig;

  /**
   * Resolved MCP servers (inline manifest objects ∪ servers loaded from the
   * declared/`.mcp.json` files), keyed by server name. Present only when ≥1.
   */
  mcpServers?: Record<string, PluginMcpServerConfig>;

  /** Resolved LSP servers (inline ∪ from declared json files), keyed by name. */
  lspServers?: Record<string, PluginLspServerConfig>;
}

/** The three source groups, in INCREASING precedence (builtin < marketplace < session). */
export type PluginSourceKind = 'builtin' | 'marketplace' | 'session';
