/**
 * CLI mode for one-time operations.
 *
 * The MCP surface stays deliberately small; installation, game creation, project
 * selection, diagnostics, and upgrades belong here because they should not compete
 * for the model's attention on every turn.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
import { applyConfig, inspectConfig, removeConfig } from '../install/write-config';
import { verifyLaunch } from '../install/verify';
import {
  activeGame,
  ensureLocalProject,
  gameDir,
  initLocalGame,
  listGames,
  resolveProject,
  SLUG_RE,
} from '../project/locate';
import { installEngineSdk } from '../project/engine-sdk';
import { runtimeCacheRoot } from '../runtime/cache';
import { ROUTING_TEXT } from '../routing';
import {
  assertEngineProjectRoot,
  assertServerProjectRoot,
  probeServices,
  serverBaseUrl,
  type Capabilities,
} from '../services/probe';
import { loadRuntimeManifest } from '../runtime/manifest';
import { resolveInstalledRuntime } from '../runtime/manager';

const HELP = `ForgeaX game development plugin

Usage:
  forgeax-game install [--ide codex,claude,cursor,trae,opencode,workbuddy] [--local]
  forgeax-game uninstall [--ide ...] [--purge]
  forgeax-game init [--game <slug>] [--ide ...]
  forgeax-game use <slug>
  forgeax-game doctor
  forgeax-game devkit install
  forgeax-game agents update
  forgeax-game update [--ide ...]
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
      `no ForgeaX project found searching upward from ${project.searchedFrom}; run this command inside a directory containing .forgeax/`,
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

async function apiPost(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${serverBaseUrl()}${path}`, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = { error: text };
      }
    }
    if (!response.ok) {
      throw new Error(
        `${path} returned HTTP ${response.status}: ${String(payload.error ?? response.statusText)}`,
      );
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${serverBaseUrl()} did not answer ${path} within 10s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function installCommand(args: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(args);
  const launch = launchSpec(parsed.mode);

  process.stdout.write(`Verifying ${launch.command} ${launch.args.join(' ')} ...\n`);
  const verified = await verifyLaunch(launch);
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

function defaultSlug(root: string): string {
  const raw = basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return SLUG_RE.test(raw) ? raw : 'my-game';
}

const INIT_USAGE = 'usage: forgeax-game init [--game <slug>] [--ide codex,claude,cursor,...]';

function parseInitArgs(args: readonly string[], root: string): { slug: string; ide?: readonly string[] } {
  const rest: string[] = [];
  let slug: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--game') {
      const value = args[++i];
      if (!value) throw new Error(INIT_USAGE);
      slug = value;
      continue;
    }
    if (arg.startsWith('--game=')) {
      slug = arg.slice('--game='.length);
      continue;
    }
    rest.push(arg);
  }
  const ide = parseIdeSelector(rest, INIT_USAGE);
  return { slug: slug ?? defaultSlug(root), ...(ide ? { ide } : {}) };
}

async function initCommand(args: readonly string[]): Promise<number> {
  const binding = resolveProject();
  // Empty-directory onboarding intentionally binds to cwd. Once `.forgeax/` is
  // present, retain the normal walk-up binding and server instance-root safety.
  const root = binding.root ?? process.cwd();
  const parsedInit = parseInitArgs(args, root);
  const slug = parsedInit.slug;
  if (!SLUG_RE.test(slug)) {
    throw new Error('game slug must be 1-41 lowercase ASCII letters, digits, or hyphens, starting with a letter or digit');
  }
  if (gameDir(root, slug)) throw new Error(`game ${JSON.stringify(slug)} already exists`);

  const capabilities = await probeServices();
  let useServer = capabilities.tier !== 'local';
  if (useServer && !binding.root) {
    // A machine may have another Studio checkout running on the shared port. An
    // unbound empty cwd must remain self-contained; only use that server when its
    // identity matches this cwd. Bound projects keep the strict refusal below.
    try {
      await assertServerProjectRoot(root);
    } catch {
      useServer = false;
    }
  }
  if (useServer) {
    // Preserve the canonical server scaffold whenever an existing project has a
    // reachable backend. It owns template copying, GUID regeneration, and session
    // relocation, so the local fallback must never shadow this path.
    if (binding.root) await assertServerProjectRoot(root);
    // A healthy server can own a brand-new cwd too; create the instance marker
    // only after its identity has been checked, then let the server scaffold the
    // canonical template and active-game binding.
    if (!binding.root) ensureLocalProject(root);
    const response = await apiPost('/api/workbench/games', { slug, name: slug, brief: '' });
    if (!gameDir(root, slug)) {
      throw new Error(
        `server created ${JSON.stringify(response.gameDir ?? slug)}, but it is not under ${root}/.forgeax/games; run the CLI against the same instance root as the server`,
      );
    }
  } else {
    const local = initLocalGame(root, slug);
    process.stdout.write(
      `Created a local ForgeaX project and game ${slug} at ${local.gameRoot} (no matching server; online scaffold will be used for later games).\n`,
    );
  }
  const sdk = installEngineSdk(root);
  process.stdout.write(
    `${sdk.changed ? 'UPDATED' : 'CURRENT'} bundled Engine SDK: ${sdk.sdkRoot}${sdk.engineCommit ? ` (${sdk.engineCommit})` : ''}\n`,
  );
  if (sdk.sourceRoot) process.stdout.write(`Engine source available for escalation: ${sdk.sourceRoot}\n`);
  const agents = updateAgentsFile(root);
  // Which hosts to mount is derived from the configs `install` already wrote, so the
  // two commands agree regardless of the order the user ran them in.
  const selection = selectClients(root, parsedInit.ide);
  reportMissingClients(selection.missing);
  const hosts = selection.selected;
  const devkit = installDevKit(root, hosts);
  process.stdout.write(`Created and activated game ${slug} at ${gameDir(root, slug)}.\n`);
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
  await assertServerProjectRoot(root);
  await apiPost(`/api/workbench/games/${encodeURIComponent(slug)}/activate`);
  process.stdout.write(`Active game: ${slug}\n`);
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
  const rest = args.filter((arg) => arg !== '--purge');
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

  if (purge) {
    const cache = runtimeCacheRoot();
    rmSync(cache, { recursive: true, force: true });
    process.stdout.write(`PURGED managed Runtime cache: ${cache}\n`);
  } else {
    process.stdout.write(`KEPT    managed Runtime cache (use --purge to remove): ${runtimeCacheRoot()}\n`);
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
  const major = Number.parseInt(process.versions.node.split('.')[0]!, 10);
  if (major >= 18) process.stdout.write(`OK Node ${process.versions.node}\n`);
  else {
    warnings++;
    process.stdout.write(`FAIL Node ${process.versions.node}; Node 18 or newer is required\n`);
  }

  const project = resolveProject();
  if (project.root) {
    process.stdout.write(
      `OK project ${project.root}; active=${activeGame(project.root) ?? '(none)'}; games=${listGames(project.root).join(', ') || '(none)'}\n`,
    );
    if (hasDevKit(project.root)) {
      const engine = installedEngineSkills(project.root);
      const bundled = bundledEngineSkillCount();
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
    process.stdout.write(`WARN no ForgeaX project found from ${project.searchedFrom}\n`);
  }

  const runtime = resolveInstalledRuntime();
  if (runtime) {
    process.stdout.write(`OK managed ForgeaX Runtime ${runtime.version} (${runtime.platform}/${runtime.arch})\n`);
  } else if (loadRuntimeManifest()) {
    warnings++;
    process.stdout.write('WARN managed Runtime is not installed; first run will download and verify the selected artifact\n');
  } else {
    warnings++;
    process.stdout.write('WARN no Runtime manifest found; publish/install assets/runtime-manifest.json or set FORGEAX_RUNTIME_MANIFEST\n');
  }

  let capabilities = await probeServices();
  if (project.root && capabilities.services.some((service) => service.name === 'server' && service.reachable)) {
    try {
      await assertServerProjectRoot(project.root);
      if (capabilities.tier === 'runtime') await assertEngineProjectRoot(project.root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      capabilities = {
        tier: 'local',
        services: capabilities.services.map((service) => ({ ...service, reachable: false, reason })),
      } satisfies Capabilities;
    }
  }
  process.stdout.write(`Capability tier: ${capabilities.tier}\n`);
  for (const service of capabilities.services) {
    if (!service.reachable) warnings++;
    process.stdout.write(
      `${service.reachable ? 'OK' : 'WARN'} ${service.name} ${service.url}${service.reason ? `: ${service.reason}` : ''}\n`,
    );
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

/**
 * Re-apply this build's configuration, Engine SDK and skills to installed hosts.
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
    const result = applyConfig(client, root, launch);
    process.stdout.write(`${result.changed ? 'UPDATED' : 'CURRENT'} ${client.label}: ${result.path}\n`);
  }
  if (project.root) {
    const sdk = installEngineSdk(project.root);
    // Act on exactly the hosts this run selected, so `update --ide claude` does not
    // quietly refresh the other seven.
    const devkit = installDevKit(project.root, configured.map((client) => client.id));
    const agents = updateAgentsFile(project.root);
    process.stdout.write(`${sdk.changed ? 'UPDATED' : 'CURRENT'} bundled Engine SDK: ${sdk.sdkRoot}\n`);
    process.stdout.write(`${devkit.changed ? 'UPDATED' : 'CURRENT'} game development skills: ${devkit.skillIds.length} in ${devkit.skillsRoot}\n`);
    process.stdout.write(`${devkit.note}\n`);
    process.stdout.write(`${agents.changed ? 'UPDATED' : 'CURRENT'} routing rules: ${agents.path}\n`);
  } else {
    process.stdout.write('Skipped AGENTS.md routing update: no ForgeaX project is bound.\n');
  }
  return 0;
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
    case 'devkit':
      return devkitCommand(args);
    case 'agents':
      return agentsCommand(args);
    case 'update':
      return updateCommand(args);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command ?? '(none)'}\n\n${HELP}`);
      return 2;
  }
}
