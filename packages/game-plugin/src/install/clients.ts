/**
 * Which AI clients we can configure, and where each keeps its MCP config.
 *
 * Every client invented its own file, its own root key, and in Codex's case its own
 * format. There is no shared standard to lean on, so the differences are enumerated
 * here rather than smeared through the installer.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type ClientId =
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'trae'
  | 'codebuddy'
  | 'windsurf'
  | 'vscode'
  | 'opencode';

/** How a client stores server entries. */
export type ConfigFormat = 'toml' | 'json';

/** Where the config lives: one per machine, or one per project. */
export type ConfigScope = 'user' | 'project';

export interface ClientSpec {
  readonly id: ClientId;
  /** Accepted CLI names that resolve to this same client configuration. */
  readonly aliases?: readonly string[];
  readonly label: string;
  readonly format: ConfigFormat;
  readonly scope: ConfigScope;
  /** Resolve the config file. `projectRoot` is only consulted for project scope. */
  path(projectRoot: string): string;
  /**
   * JSON: the key path to the server map (VS Code says `servers`, everyone else says
   * `mcpServers`). TOML: unused, the table header is derived instead.
   */
  readonly serverMapKey?: readonly string[];
  /** Whether this client wants `command` and `args` split, or one argv array. */
  readonly commandShape: 'split' | 'argv';
  /** Extra fields merged into the server entry. */
  readonly extraEntryFields?: Readonly<Record<string, unknown>>;
  /** Shown after install when the client needs a nudge to pick the config up. */
  readonly postInstallNote?: string;
}

const HOME = homedir();

export const CLIENTS: readonly ClientSpec[] = [
  {
    id: 'codex',
    label: 'Codex CLI',
    format: 'toml',
    scope: 'user',
    path: () => join(HOME, '.codex', 'config.toml'),
    commandShape: 'split',
    postInstallNote: 'Restart Codex, then run /mcp to confirm the server is connected.',
  },
  {
    id: 'claude',
    label: 'the reference agent CLI',
    format: 'json',
    scope: 'user',
    path: () => join(HOME, '.claude.json'),
    serverMapKey: ['mcpServers'],
    commandShape: 'split',
    postInstallNote: 'Restart the reference agent CLI, then run /mcp to confirm the server is connected.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    scope: 'user',
    path: () => join(HOME, '.cursor', 'mcp.json'),
    serverMapKey: ['mcpServers'],
    commandShape: 'split',
    postInstallNote: 'Reload Cursor, then check Settings > MCP.',
  },
  {
    id: 'trae',
    label: 'Trae (project)',
    format: 'json',
    scope: 'project',
    path: (projectRoot) => join(projectRoot, '.trae', 'mcp.json'),
    serverMapKey: ['mcpServers'],
    commandShape: 'split',
    postInstallNote: 'Reload Trae, then check the project MCP server list.',
  },
  {
    id: 'codebuddy',
    aliases: ['workbuddy'],
    label: 'a peer agent CLI / WorkBuddy',
    format: 'json',
    scope: 'user',
    path: () => join(HOME, '.codebuddy', '.mcp.json'),
    serverMapKey: ['mcpServers'],
    commandShape: 'split',
    postInstallNote: 'Restart a peer agent CLI or WorkBuddy, then run /mcp to confirm the server is connected.',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    format: 'json',
    scope: 'user',
    path: () => join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    serverMapKey: ['mcpServers'],
    commandShape: 'split',
    postInstallNote: 'Reload Windsurf to pick up the new server.',
  },
  {
    // User-scope config lives inside the active VS Code profile, whose directory name
    // is not derivable from outside the editor. Workspace scope is deterministic, so
    // that is what we write.
    id: 'vscode',
    label: 'VS Code (workspace)',
    format: 'json',
    scope: 'project',
    path: (projectRoot) => join(projectRoot, '.vscode', 'mcp.json'),
    serverMapKey: ['servers'],
    commandShape: 'split',
    postInstallNote: 'Open .vscode/mcp.json and click Start, or run "MCP: List Servers".',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    format: 'json',
    scope: 'user',
    path: () => join(HOME, '.config', 'opencode', 'opencode.json'),
    serverMapKey: ['mcp'],
    commandShape: 'argv',
    extraEntryFields: { type: 'local', enabled: true },
    postInstallNote: 'Restart OpenCode to pick up the new server.',
  },
];

export const CLIENT_IDS: readonly ClientId[] = CLIENTS.map((c) => c.id);

/** Every spelling accepted by `--ide`, including compatibility names. */
export const CLIENT_CHOICES: readonly string[] = CLIENTS.flatMap((client) => [
  client.id,
  ...(client.aliases ?? []),
]);

export function findClient(id: string): ClientSpec | undefined {
  return CLIENTS.find((client) => client.id === id || client.aliases?.includes(id));
}

/** Server name as it appears in every client's config. */
export const SERVER_KEY = 'forgeax';

export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How clients should start this server.
 *
 * The npx form is the default because it needs nothing installed and always resolves
 * the published version. `--local` pins the currently running binary instead, which is
 * what you want when developing the plugin itself or working offline.
 */
export function launchSpec(mode: 'npx' | 'local'): LaunchSpec {
  if (mode === 'local') {
    return { command: process.execPath, args: [resolve(process.argv[1] ?? ''), 'mcp'] };
  }
  return { command: 'npx', args: ['-y', '-p', '@forgeax/game', 'forgeax-game', 'mcp'] };
}
