/**
 * CLI mode for one-time operations.
 *
 * The MCP surface stays deliberately small; installation, game creation, project
 * selection, diagnostics, and upgrades belong here because they should not compete
 * for the model's attention on every turn.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { removeBlock, upsertBlock } from '../agents-md/managed-block';
import {
  bundledEngineSkillCount,
  hasDevKit,
  installDevKit,
  installedEngineSkills,
  removeDevKit,
  installHostDevKit,
} from '../devkit/install';
import {
  CLIENTS,
  CLIENT_CHOICES,
  CLIENT_IDS,
  findClient,
  launchSpec,
  type ClientSpec,
  type LaunchSpec,
} from '../install/clients';
import { applyConfig, configuredGameVersion, inspectConfig, removeConfig, retireAsset3dConfig } from '../install/write-config';
import { RELEASE_IDENTITY } from '../install/release-manifest';
import { INSTALL_VERIFY_TIMEOUT_MS, verifyLaunch } from '../install/verify';
import {
  activeGame,
  gameDir,
  listGames,
  resolveProject,
  SLUG_RE,
} from '../project/locate';
import { ROUTING_TEXT } from '../routing';
import { ensureAuthoringBaseline } from '../project/completion';
import { createEmptyGameWithCarrier } from '../engine/carrier';
import { resolveEngineRelease } from '../engine/release';
import { inspectEnginePreview, stopEnginePreview } from '../run/engine-preview';
import { pruneUnselectedEngineMounts } from '../devkit/engine-mounts';
import { discoverExtensions, enableExtension, disableExtension, disableAllExtensions, registeredProjects, runExtension } from '../extensions/manager';

const HELP = `ForgeaX game development plugin

Usage:
  forgeax-game install [--ide ${CLIENT_CHOICES.join(',')}] [--local]
  forgeax-game uninstall [--ide ...] [--purge]
  forgeax-game uninstall --all-projects [--ide ...]
  forgeax-game <extension> enable [--ide ...] [--local] [extension options]
  forgeax-game <extension> disable
  forgeax-game <extension> <operation> [options]
  forgeax-game init
  forgeax-game use <slug>
  forgeax-game doctor
  forgeax-game preview stop [--game <slug>] [--target-dir <path>] [--json]
  forgeax-game devkit install
  forgeax-game agents update
  forgeax-game update [--ide ...]
  forgeax-game version
  forgeax-game help

With no arguments, forgeax-game runs the stdio MCP server.
`;

interface ParsedInstall {
  readonly clients: readonly ClientSpec[];
  readonly mode: 'npx' | 'local';
}

function parseInstallArgs(args: readonly string[]): ParsedInstall {
  let mode: 'npx' | 'local' = 'npx';
  let ids: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--local') {
      mode = 'local';
      continue;
    }
    if (arg === '--ide') {
      const value = args[++i];
      if (!value) throw new Error('--ide requires a comma-separated client list');
      ids = value.split(',').map((id) => id.trim()).filter(Boolean);
      continue;
    }
    if (arg.startsWith('--ide=')) {
      ids = arg.slice('--ide='.length).split(',').map((id) => id.trim()).filter(Boolean);
      continue;
    }
    throw new Error(`unknown install option: ${arg}`);
  }
  const selected = ids ?? [...CLIENT_IDS];
  if (selected.length === 0) throw new Error('--ide did not name any clients');
  const uniqueNames = [...new Set(selected)];
  const unknown = uniqueNames.filter((id) => !findClient(id));
  if (unknown.length) {
    throw new Error(`unknown client${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Choose from ${CLIENT_CHOICES.join(', ')}.`);
  }
  const clients = uniqueNames.map((id) => findClient(id)!);
  return { clients: [...new Map(clients.map((client) => [client.id, client])).values()], mode };
}

function requireProject(): string {
  const project = resolveProject();
  if (!project.root) {
    throw new Error(
      `no released Engine game found searching upward from ${project.searchedFrom}; run this command inside a game created by the released Engine SDK`,
    );
  }
  return project.root;
}

function updateAgentsFile(root: string): { path: string; changed: boolean } {
  const path = join(root, 'AGENTS.md');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const content = upsertBlock(existing, ROUTING_TEXT);
  if (content === existing) return { path, changed: false };
  writeFileSync(path, content);
  return { path, changed: true };
}

/** Mirror of updateAgentsFile: drop our managed block, keep the user's own content. */
function removeAgentsBlock(root: string): { path: string; changed: boolean } {
  const path = join(root, 'AGENTS.md');
  if (!existsSync(path)) return { path, changed: false };
  const existing = readFileSync(path, 'utf8');
  const content = removeBlock(existing);
  if (content === existing) return { path, changed: false };
  writeFileSync(path, content);
  return { path, changed: true };
}

async function installCommand(args: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(args);
  const launch = launchSpec(parsed.mode);

  process.stdout.write(`Verifying ${launch.command} ${launch.args.join(' ')} ...\n`);
  const verified = await verifyLaunch(launch, INSTALL_VERIFY_TIMEOUT_MS);
  process.stdout.write(
    `Handshake OK: ${verified.serverName} ${verified.serverVersion}, ${verified.tools.length} tools, ${verified.resources.length} resource.\n`,
  );

  const project = resolveProject();
  let failures = 0;
  for (const client of parsed.clients) {
    if (client.scope === 'project' && !project.root) {
      failures++;
      process.stderr.write(
        `FAIL ${client.label}: workspace config requires running install inside a ForgeaX project.\n`,
      );
      continue;
    }
    try {
      const result = applyConfig(client, project.root ?? process.cwd(), launch);
      retireAsset3dHost(client, project.root ?? process.cwd());

      process.stdout.write(
        `${result.changed ? 'UPDATED' : 'CURRENT'} ${client.label}: ${result.path}${result.backup ? ` (backup: ${result.backup})` : ''}\n`,
      );
      if (client.postInstallNote) process.stdout.write(`  ${client.postInstallNote}\n`);
    } catch (error) {
      failures++;
      process.stderr.write(
        `FAIL ${client.label}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  if (project.root) {
    const devkit = installDevKit(project.root, parsed.clients.map((client) => client.id));
    const agents = updateAgentsFile(project.root);
    process.stdout.write(
      `${devkit.changed ? 'UPDATED' : 'CURRENT'} game development skills: ${devkit.skillIds.length} in ${devkit.skillsRoot}\n  ${devkit.note}\n`,
    );
    process.stdout.write(`${agents.changed ? 'UPDATED' : 'CURRENT'} routing rules: ${agents.path}\n`);
  } else {
    // Skills are deliberately NOT installed at user level here. Doing so left a second
    // copy that hosts load alongside the project's, so a session saw every skill twice.
    // `init` installs them once the project exists.
    process.stdout.write(
      'INFO no ForgeaX project is bound; project Skill/rules and AGENTS.md will be prepared after `forgeax-game init`.\n',
    );
  }
  return failures === 0 ? 0 : 1;
}

async function initCommand(args: readonly string[]): Promise<number> {
  if (args.length) throw new Error('usage: forgeax-game init');
  let binding = resolveProject();
  if (!binding.root) {
    // `createEmptyGameWithCarrier` checks emptiness before resolving the carrier. This
    // keeps an unknown non-empty directory byte-for-byte untouched and avoids even
    // probing a dependency graph for a command that must fail locally.
    await createEmptyGameWithCarrier(process.cwd());
    binding = resolveProject();
    if (!binding.root) {
      throw new Error('engine_sdk_new_succeeded_but_project_unbound: the created directory is not a released Engine game');
    }
  }
  const root = binding.root;
  const slug = activeGame(root);
  const selectedGame = slug ? gameDir(root, slug) : undefined;
  if (!slug || !selectedGame) throw new Error('no active Engine game is available');
  const release = resolveEngineRelease(selectedGame);
  const baseline = ensureAuthoringBaseline(selectedGame);
  const agents = updateAgentsFile(root);
  // Which hosts to mount is derived from the configs `install` already wrote, so the
  // two commands agree regardless of the order the user ran them in.
  const selection = selectClients(root, undefined);
  reportMissingClients(selection.missing);
  const hosts = selection.selected;
  const devkit = installDevKit(root, hosts);
  const removedMounts = pruneUnselectedEngineMounts(root, hosts);
  if (removedMounts.length) process.stdout.write(`Removed unused Engine-generated skill mounts: ${removedMounts.join(', ')}.\n`);
  process.stdout.write(`Bound Engine game ${slug} at ${selectedGame}.\n`);
  process.stdout.write(`Engine ${release.version} (${release.commit}).\n`);
  process.stdout.write(`Authoring baseline: ${baseline}.\n`);
  process.stdout.write(`${agents.changed ? 'Updated' : 'Kept current'} routing rules in ${agents.path}.\n`);
  if (hosts.length === 0) {
    process.stdout.write(
      selection.missing.length
        ? 'None of the named clients is installed, so no skills were installed.\n'
        : 'No agent client is configured yet, so no skills were installed. Run `forgeax-game install --ide <hosts>`.\n',
    );
  } else {
    process.stdout.write(`${devkit.changed ? 'Updated' : 'Kept current'} ${devkit.skillIds.length} game development skills for: ${hosts.join(', ')}.\n`);
    process.stdout.write(`${devkit.note}\n`);
  }
  return 0;
}

async function useCommand(args: readonly string[]): Promise<number> {
  if (args.length !== 1) throw new Error('usage: forgeax-game use <slug>');
  const slug = args[0]!;
  if (!SLUG_RE.test(slug)) throw new Error(`invalid game slug: ${slug}`);
  const root = requireProject();
  if (!gameDir(root, slug)) {
    throw new Error(`game ${JSON.stringify(slug)} not found. Available: ${listGames(root).join(', ') || '(none)'}`);
  }
  if (listGames(root).length > 1) {
    writeFileSync(
      join(root, '.forgeax', 'active-game.json'),
      `${JSON.stringify({ version: 1, slug }, null, 2)}\n`,
      'utf8',
    );
  }
  process.stdout.write(`Active game: ${slug}\n`);
  return 0;
}

async function previewCommand(args: readonly string[]): Promise<number> {
  if (args[0] !== 'stop') {
    throw new Error('usage: forgeax-game preview stop [--game <slug>] [--target-dir <path>] [--json]');
  }
  let requested: string | undefined;
  let targetDir: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--game' || arg === '--target-dir') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--game') requested = value;
      else targetDir = value;
      continue;
    }
    throw new Error('usage: forgeax-game preview stop [--game <slug>] [--target-dir <path>] [--json]');
  }
  const project = resolveProject(targetDir);
  if (!project.root) throw new Error('no ForgeaX project or Engine game found');
  const slug = requested ?? activeGame(project.root) ?? listGames(project.root)[0];
  const selectedGame = slug ? gameDir(project.root, slug) : undefined;
  if (!slug || !selectedGame) throw new Error('no matching Engine game found');
  const result = await stopEnginePreview(project.root, selectedGame);
  const envelope = { schemaVersion: '1.0.0', command: 'preview.stop', ok: true, value: { game: slug, stopped: result.stopped, stateFile: result.paths.state } };
  process.stdout.write(json ? `${JSON.stringify(envelope)}\n` : `${result.stopped ? 'Stopped' : 'No live'} Engine Preview for ${slug}.\n`);
  return 0;
}

async function agentsCommand(args: readonly string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== 'update') {
    throw new Error('usage: forgeax-game agents update');
  }
  const result = updateAgentsFile(requireProject());
  process.stdout.write(`${result.changed ? 'Updated' : 'Already current'}: ${result.path}\n`);
  return 0;
}

async function devkitCommand(args: readonly string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== 'install') {
    throw new Error('usage: forgeax-game devkit install');
  }
  const root = requireProject();
  const result = installDevKit(root, configuredClientIds(root));
  const agents = updateAgentsFile(root);
  process.stdout.write(`${result.changed ? 'UPDATED' : 'CURRENT'} game development skills: ${result.skillIds.length} in ${result.skillsRoot}\n`);
  process.stdout.write(`${result.note}\n`);
  process.stdout.write(`${agents.changed ? 'UPDATED' : 'CURRENT'} routing rules: ${agents.path}\n`);
  return 0;
}

/**
 * Which supported clients already carry a forgeax MCP entry.
 *
 * `init` mounts skills for exactly these, so `install` and `init` agree no matter which
 * order the user ran them in. Deriving the list beats asking twice or defaulting to
 * every known host, which is what copied the skills into nine directories.
 */
function configuredClientIds(projectRoot: string): string[] {
  const npx = launchSpec('npx');
  const local = launchSpec('local');
  return CLIENTS.filter((client) =>
    [npx, local].some((launch) => inspectConfig(client, projectRoot, launch).state === 'current'),
  ).map((client) => client.id);
}

async function uninstallCommand(args: readonly string[]): Promise<number> {
  const purge = args.includes('--purge');
  const allProjects = args.includes('--all-projects');
  const rest = args.filter((arg) => arg !== '--purge' && arg !== '--all-projects');
  const requested = parseIdeSelector(rest, 'usage: forgeax-game uninstall [--ide codex,claude,...] [--purge]');
  const binding = resolveProject();
  const root = binding.root;
  /**
   * Without `--ide`, remove from the hosts that actually carry a forgeax entry rather
   * than from every host this plugin knows about: rewriting a config that never had one
   * would take a backup of a file we did not change.
   */
  const targets = requested
    ? requested.map((id) => (id === 'workbuddy' ? 'codebuddy' : id))
    : root
      ? configuredClientIds(root)
      : [...CLIENT_IDS];
  const clients = CLIENTS.filter((client) => targets.includes(client.id));

  let failures = 0;
  const projects = allProjects ? registeredProjects() : root ? [root] : [];
  for (const project of projects) {
    try {
      const removed = disableAllExtensions(project);
      process.stdout.write(`DISABLED ${removed.length} extensions: ${project}\n`);
      for (const item of removed) for (const backup of item.backups) process.stdout.write(`BACKUP ${backup}\n`);
      if (allProjects && project !== root) {
        removeDevKit(project);
        removeAgentsBlock(project);
      }
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL extension cleanup: ${project}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  for (const client of clients) {
    try {
      const result = removeConfig(client, root ?? process.cwd());
      process.stdout.write(
        `${result.changed ? 'REMOVED' : 'ABSENT '} ${client.label}: ${result.path}\n`,
      );
    } catch (error) {
      failures++;
      process.stderr.write(`FAIL ${client.label}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (root) {
    const removal = removeDevKit(root);
    process.stdout.write(`REMOVED ${removal.skillCount} skill/rule entries from ${removal.removed.length} host mounts\n`);
    const agents = removeAgentsBlock(root);
    process.stdout.write(`${agents.changed ? 'REMOVED' : 'ABSENT '} routing block: ${agents.path}\n`);
    process.stdout.write(`KEPT    your games and project metadata: ${join(root, '.forgeax')}\n`);
  } else {
    process.stdout.write('INFO  no ForgeaX project bound; only client configuration was touched.\n');
  }

  if (purge && root) {
    const slug = activeGame(root);
    const selectedGame = slug ? gameDir(root, slug) : undefined;
    if (selectedGame) {
      const stopped = await stopEnginePreview(root, selectedGame);
      process.stdout.write(`${stopped.stopped ? 'STOPPED' : 'ABSENT '} Engine Preview: ${stopped.paths.state}\n`);
    }
  }
  process.stdout.write('Restart your agent client so it drops the forgeax MCP server.\n');
  return failures === 0 ? 0 : 1;
}

/** Parse a bare `--ide a,b` / `--ide=a,b` selector, rejecting unknown client ids. */
function parseIdeSelector(args: readonly string[], usage: string): readonly string[] | undefined {
  let ids: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--ide') {
      const value = args[++i];
      if (!value) throw new Error('--ide requires a comma-separated client list');
      ids = value.split(',').map((id) => id.trim()).filter(Boolean);
      continue;
    }
    if (arg.startsWith('--ide=')) {
      ids = arg.slice('--ide='.length).split(',').map((id) => id.trim()).filter(Boolean);
      continue;
    }
    throw new Error(usage);
  }
  if (!ids) return undefined;
  const unique = [...new Set(ids)];
  const unknown = unique.filter((id) => !findClient(id));
  if (unknown.length) {
    throw new Error(`unknown client${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Choose from ${CLIENT_CHOICES.join(', ')}.`);
  }
  return unique;
}

interface ClientSelection {
  /** Hosts to act on: configured, and requested if the caller named any. */
  readonly selected: readonly string[];
  /** Requested but not configured — the caller must install them first. */
  readonly missing: readonly string[];
}

/**
 * Decide which hosts a project-side command should act on.
 *
 * Omitting `--ide` means "every host that is actually installed" rather than every host
 * this plugin knows about. Mounting skills for a host with no MCP entry would give the
 * model instructions that name tools it cannot call — the same unreachable-instruction
 * failure this plugin exists to avoid. A host named explicitly but not installed is
 * reported so the user can fix the order rather than silently getting nothing.
 */
function selectClients(projectRoot: string, requested: readonly string[] | undefined): ClientSelection {
  const configured = new Set(configuredClientIds(projectRoot));
  if (!requested) return { selected: [...configured], missing: [] };
  const canonical = requested.map((id) => (id === 'workbuddy' ? 'codebuddy' : id));
  return {
    selected: canonical.filter((id) => configured.has(id)),
    missing: canonical.filter((id) => !configured.has(id)),
  };
}

/** Tell the user which named hosts need `install` before they can be initialised. */
function reportMissingClients(missing: readonly string[]): void {
  for (const id of missing) {
    const label = findClient(id)?.label ?? id;
    process.stdout.write(
      `SKIPPED ${label}: not installed yet. Run \`forgeax-game install --ide ${id}\` first, then re-run this command.\n`,
    );
  }
}

interface DoctorConfigResult {
  readonly line: string;
  readonly configured: boolean;
  readonly warning: boolean;
}

function doctorConfigState(
  client: ClientSpec,
  root: string,
  npxLaunch: LaunchSpec,
  localLaunch: LaunchSpec,
): DoctorConfigResult {
  const npx = inspectConfig(client, root, npxLaunch);
  if (npx.state === 'current') {
    return { line: `OK ${client.label}: ${npx.path} (npx)`, configured: true, warning: false };
  }
  const local = inspectConfig(client, root, localLaunch);
  if (local.state === 'current') {
    return { line: `OK ${client.label}: ${local.path} (local binary)`, configured: true, warning: false };
  }
  if (
    (npx.state === 'missing' || npx.state === 'not_configured') &&
    (local.state === 'missing' || local.state === 'not_configured')
  ) {
    return {
      line: `INFO ${client.label}: not configured (${npx.path})`,
      configured: false,
      warning: false,
    };
  }
  const detail = npx.detail ? `: ${npx.detail}` : '';
  return {
    line: `WARN ${client.label}: ${npx.path} (${npx.state}${detail})`,
    configured: true,
    warning: true,
  };
}

async function doctorCommand(args: readonly string[]): Promise<number> {
  if (args.length) throw new Error('usage: forgeax-game doctor');
  let warnings = 0;
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
  if (major > 22 || (major === 22 && minor >= 13)) process.stdout.write(`OK Node ${process.versions.node}\n`);
  else {
    warnings++;
    process.stdout.write(`FAIL Node ${process.versions.node}; Node 22.13 or newer is required\n`);
  }

  const project = resolveProject();
  if (project.root) {
    process.stdout.write(
      `OK project ${project.root}; active=${activeGame(project.root) ?? '(none)'}; games=${listGames(project.root).join(', ') || '(none)'}\n`,
    );
    if (hasDevKit(project.root)) {
      const engine = installedEngineSkills(project.root);
      const bundled = bundledEngineSkillCount(project.root);
      process.stdout.write(`OK game development skill installed; Engine authoring skills: ${engine.length}\n`);
      if (engine.length < bundled) {
        warnings++;
        process.stdout.write(
          `WARN this build bundles ${bundled} Engine authoring skills but only ${engine.length} are installed; run \`forgeax-game devkit install\`\n`,
        );
      }
    } else {
      warnings++;
      process.stdout.write('WARN game development skill missing; run `forgeax-game devkit install`\n');
    }
  } else {
    warnings++;
    process.stdout.write(`WARN no released Engine game found from ${project.searchedFrom}\n`);
  }

  if (project.root) {
    const slug = activeGame(project.root);
    const selectedGame = slug ? gameDir(project.root, slug) : undefined;
    try {
      if (!selectedGame) throw new Error('no active Engine game');
      const release = resolveEngineRelease(selectedGame);
      process.stdout.write(`OK Engine ${release.version} (${release.commit})\n`);
      const preview = inspectEnginePreview(project.root, selectedGame);
      process.stdout.write(`${preview.processLive && preview.processIdentityMatches ? 'OK' : 'INFO'} Engine Preview ${preview.processLive ? 'live' : 'not running'} (${preview.paths.state})\n`);
    } catch (error) {
      warnings++;
      process.stdout.write(`WARN ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  const root = project.root ?? process.cwd();
  const npxLaunch = launchSpec('npx');
  const localLaunch = launchSpec('local');
  let configuredClients = 0;
  for (const client of CLIENTS) {
    if (client.scope === 'project' && !project.root) {
      process.stdout.write(`INFO ${client.label}: workspace config not checked without a project\n`);
      continue;
    }
    const result = doctorConfigState(client, root, npxLaunch, localLaunch);
    if (result.configured) configuredClients++;
    if (result.warning) warnings++;
    process.stdout.write(`${result.line}\n`);
  }
  if (configuredClients === 0) {
    warnings++;
    process.stdout.write('WARN no MCP client is configured; run `forgeax-game install --ide <client>`\n');
  }
  return warnings === 0 ? 0 : 1;
}

const UPDATE_USAGE = 'usage: forgeax-game update [--ide codex,claude,cursor,...]';

function retireAsset3dHost(client: ClientSpec, root: string): void {
  const state = retireAsset3dConfig(client, root);
  if (state === 'removed') process.stdout.write(`REMOVED ${client.label}: retired asset3d-search MCP; assets now use the project Skill + CLI. Restart the client.\n`);
  if (state === 'preserved') process.stderr.write(`WARN ${client.label}: asset3d-search is not an exact recognized package launcher; preserved for manual review.\n`);
}

function versionCommand(args: readonly string[]): number {
  if (args.length > 0) throw new Error('usage: forgeax-game version');
  process.stdout.write(`${RELEASE_IDENTITY.gamePackage} ${RELEASE_IDENTITY.gameVersion}\n`);
  return 0;
}

export function formatVersionTransition(
  previousVersion: string | undefined,
  currentVersion = RELEASE_IDENTITY.gameVersion,
): string {
  return previousVersion === currentVersion
    ? currentVersion
    : `${previousVersion ?? 'unknown'} -> ${currentVersion}`;
}

/**
 * Re-apply this build's configuration and project skills to installed hosts.
 *
 * This refreshes what the *current* package version puts on disk; it does not fetch a
 * newer package. The MCP launcher is `npx -y -p @forgeax/game …`, so which version runs
 * is decided by npm's own resolution, and silently swapping it here would move a
 * project's Engine pin underneath games already written against it.
 */
async function updateCommand(args: readonly string[]): Promise<number> {
  const requested = parseIdeSelector(args, UPDATE_USAGE);
  const project = resolveProject();
  const root = project.root ?? process.cwd();
  const launch = launchSpec('npx');
  const wanted = requested ? new Set(requested.map((id) => (id === 'workbuddy' ? 'codebuddy' : id))) : undefined;
  const configured = CLIENTS.filter((client) => {
    if (client.scope === 'project' && !project.root) return false;
    if (wanted && !wanted.has(client.id)) return false;
    const state = inspectConfig(client, root, launch).state;
    return state === 'current' || state === 'different';
  });
  if (wanted) {
    reportMissingClients([...wanted].filter((id) => !configured.some((client) => client.id === id)));
  }
  if (configured.length === 0) {
    throw new Error(
      wanted
        ? 'none of the named clients is installed; run `forgeax-game install --ide <client>` first'
        : 'no ForgeaX client configuration found; run `forgeax-game install --ide <client>` first',
    );
  }

  process.stdout.write('Verifying current published launch command before changing configuration ...\n');
  await verifyLaunch(launch);
  for (const client of configured) {
    const previousVersion = configuredGameVersion(client, root);
    const result = applyConfig(client, root, launch);
    retireAsset3dHost(client, root);

    process.stdout.write(
      `${result.changed ? 'UPDATED' : 'CURRENT'} ${client.label}: ${result.path} (plugin ${formatVersionTransition(previousVersion)})\n`,
    );
  }
  if (project.root) {
    // Act on exactly the hosts this run selected, so `update --ide claude` does not
    // quietly refresh the other seven.
    const devkit = installDevKit(project.root, configured.map((client) => client.id));
    const agents = updateAgentsFile(project.root);
    process.stdout.write(`${devkit.changed ? 'UPDATED' : 'CURRENT'} game development skills: ${devkit.skillIds.length} in ${devkit.skillsRoot}\n`);
    process.stdout.write(`${devkit.note}\n`);
    process.stdout.write(`${agents.changed ? 'UPDATED' : 'CURRENT'} routing rules: ${agents.path}\n`);
  } else {
    process.stdout.write('Skipped AGENTS.md routing update: no ForgeaX project is bound.\n');
  }
  return 0;
}

async function extensionCommand(id: string, args: string[]): Promise<number> {
  const pretty = args.includes('--pretty');
  args = args.filter(arg => arg !== '--pretty');
  const [operation, ...rest] = args;
  const emit = (ok: boolean, value: unknown) => process.stdout.write(JSON.stringify({
    schemaVersion: '1.0.0', command: `${id}.${operation}`, ok, ...(ok ? { value } : { error: value }),
  }, null, pretty ? 2 : undefined) + '\n');
  try {
    const extension = discoverExtensions().find(item => item.id === id)!;
    if (operation === 'help' || operation === '--help') {
      process.stdout.write(`${id}: enable [--ide ...] [--local], disable, or a business operation documented in its Skill. Add --pretty for readable JSON; values and exit status are unchanged.\n`);
      return 0;
    }
    const root = requireProject();
    if (operation === 'enable') {
      const options: string[] = [];
      let hosts: string[] | undefined;
      let local = false;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg === '--local') local = true;
        else if (arg === '--ide' || arg.startsWith('--ide=')) {
          const value = arg === '--ide' ? rest[++i] : arg.slice(6);
          if (!value) throw new Error('extension_host_required');
          hosts = value.split(',').map(name => {
            const client = findClient(name);
            if (!client) throw new Error('extension_host_invalid: ' + name);
            return client.id;
          });
        } else options.push(arg);
      }
      const selected = [...new Set(hosts ?? selectClients(root, undefined).selected)];
      local ||= selected.some(host => inspectConfig(findClient(host)!, root, launchSpec('local')).state === 'current');
      emit(true, await enableExtension(root, extension, selected, options, local ? launchSpec('local').args[0] : undefined));
    } else if (operation === 'disable') {
      if (rest.some(arg => arg !== '--json')) throw new Error('extension_arguments_invalid');
      emit(true, disableExtension(root, id));
    } else {
      const value = await runExtension(root, extension, args);
      const failed = value && typeof value === 'object' && 'failed' in value && Number(value.failed) > 0;
      emit(!failed, value);
      if (failed) return 1;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(false, { code: message.split(':')[0], message: message.slice(0, 256) });
    return 1;
  }
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'install':
      return installCommand(args);
    case 'init':
      return initCommand(args);
    case 'use':
      return useCommand(args);
    case 'uninstall':
      return uninstallCommand(args);
    case 'doctor':
      return doctorCommand(args);
    case 'preview':
      return previewCommand(args);
    case 'devkit':
      return devkitCommand(args);
    case 'agents':
      return agentsCommand(args);
    case 'update':
      return updateCommand(args);
    case 'version':
    case '--version':
    case '-v':
      return versionCommand(args);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      if (command && discoverExtensions().some(extension => extension.id === command)) return extensionCommand(command, args);
      process.stderr.write(`Unknown command: ${command ?? '(none)'}\n\n${HELP}`);
      return 2;
  }
}
