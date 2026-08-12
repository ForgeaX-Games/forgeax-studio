import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTING_TEXT } from '../routing';

/** The plugin's own skill: routes the model to the MCP surface and owns the rule file. */
const PLUGIN_SKILL_ID = 'forgeax-game';
/** Engine authoring skills are recognised by prefix, never by an enumerated list. */
const ENGINE_SKILL_PREFIX = 'forgeax-engine-';
export const DEVKIT_VERSION = 2;

interface InstallManifest {
  readonly harnessRoot?: string;
  readonly specPath?: string;
  readonly pythonInterpreter?: string;
  readonly targetRoot?: string;
}

export interface BundledSkill {
  readonly id: string;
  readonly path: string;
}

export interface DevKitInstallResult {
  readonly skillsRoot: string;
  readonly skillIds: readonly string[];
  readonly rulePath: string;
  readonly changed: boolean;
  readonly mounted: boolean;
  readonly hostPaths: readonly string[];
  readonly note: string;
}

export interface HostDevKitInstallResult {
  readonly changed: boolean;
  /** One skills directory per selected host, not one entry per host/skill pair. */
  readonly skillPaths: readonly string[];
  readonly rulePaths: readonly string[];
  readonly skillIds: readonly string[];
  readonly note: string;
}

/** Native skill/rule directories used by the supported hosts. */
const HOST_SKILL_MOUNTS: Readonly<Record<string, string>> = {
  codex: '.agents/skills',
  claude: '.claude/skills',
  cursor: '.cursor/skills',
  trae: '.trae/skills',
  codebuddy: '.codebuddy/skills',
  workbuddy: '.codebuddy/skills',
  windsurf: '.codeium/windsurf/skills',
  vscode: '.vscode/skills',
  opencode: '.config/opencode/skills',
};

const HOST_RULE_MOUNTS: Readonly<Record<string, string>> = {
  codex: '.agents/rules',
  claude: '.claude/rules',
  cursor: '.cursor/rules',
  trae: '.trae/rules',
  codebuddy: '.codebuddy/rules',
  workbuddy: '.codebuddy/rules',
  windsurf: '.codeium/windsurf/rules',
  vscode: '.vscode/rules',
  opencode: '.config/opencode/rules',
};

interface SkillRoot {
  readonly path: string;
  /**
   * Which directory names this root may contribute. Checkout roots hold skills that
   * belong to Studio rather than to this plugin, so they are scoped rather than swept.
   */
  readonly accepts: (id: string) => boolean;
}

/**
 * Where bundled skills can live, highest precedence first.
 *
 * Packaged locations win over checkout locations so an installed plugin never silently
 * prefers a developer's working tree. Engine skills sit beside the SDK snapshot
 * because both are generated from one Engine commit.
 */
function skillRoots(): SkillRoot[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const isPluginSkill = (id: string): boolean => id === PLUGIN_SKILL_ID;
  const anySkill = (): boolean => true;
  return [
    { path: resolve(here, '..', 'assets', 'skills'), accepts: anySkill },
    { path: resolve(here, '..', 'assets', 'engine-sdk', 'skills'), accepts: isEngineSkill },
    { path: resolve(here, '..', '..', 'assets', 'skills'), accepts: anySkill },
    { path: resolve(here, '..', '..', 'assets', 'engine-sdk', 'skills'), accepts: isEngineSkill },
    // This repository's own skill source, used when running from a checkout before
    // `build` has populated assets/.
    { path: resolve(here, '..', '..', 'skills'), accepts: isPluginSkill },
    // Engine skills from a Studio checkout, available when this package sits at
    // packages/game-plugin inside one. A standalone clone has only the built snapshot.
    { path: resolve(here, '..', '..', '..', 'editor', 'packages', 'engine', 'skills'), accepts: isEngineSkill },
  ];
}

/**
 * Discover every bundled skill by shape — a directory holding a SKILL.md.
 *
 * Deliberately not an enumerated list: the Engine ships its own authoring skills and
 * adding one upstream must not require editing this installer.
 */
export function bundledSkills(): readonly BundledSkill[] {
  const found = new Map<string, string>();
  for (const root of skillRoots()) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || found.has(entry.name) || !root.accepts(entry.name)) continue;
      const path = join(root.path, entry.name);
      if (existsSync(join(path, 'SKILL.md'))) found.set(entry.name, path);
    }
  }
  if (!found.has(PLUGIN_SKILL_ID)) {
    throw new Error('the packaged ForgeaX game skill is missing; rebuild or reinstall @forgeax/game');
  }
  return [...found]
    .map(([id, path]) => ({ id, path }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function isEngineSkill(id: string): boolean {
  return id.startsWith(ENGINE_SKILL_PREFIX);
}

function describeSkills(ids: readonly string[]): string {
  const engine = ids.filter(isEngineSkill).length;
  return `${ids.length} skills (${engine} Engine authoring)`;
}

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [relative(root, path)];
  });
}

function sameFile(left: string, right: string): boolean {
  return existsSync(right) && readFileSync(left).equals(readFileSync(right));
}

function copySkill(source: string, destination: string): boolean {
  const destinationIsSymlink = existsSync(destination) && lstatSync(destination).isSymbolicLink();
  if (!destinationIsSymlink && existsSync(destination) && realpathSync(source) === realpathSync(destination)) return false;
  const files = filesUnder(source);
  const changed = destinationIsSymlink || files.some((path) => !sameFile(join(source, path), join(destination, path)));
  if (!changed) return false;

  if (existsSync(destination)) {
    const backup = `${destination}.bak.latest`;
    rmSync(backup, { recursive: true, force: true });
    cpSync(destination, backup, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
  }
  for (const path of files) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target);
  }
  return true;
}

function writeTextIfChanged(path: string, content: string): boolean {
  const destinationIsSymlink = existsSync(path) && lstatSync(path).isSymbolicLink();
  if (!destinationIsSymlink && existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  if (existsSync(path)) {
    const backup = `${path}.bak.latest`;
    rmSync(backup, { force: true });
    copyFileSync(path, backup);
    if (destinationIsSymlink) rmSync(path, { force: true });
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return true;
}

/**
 * Normalize the requested host ids.
 *
 * There is deliberately no "all hosts" default. Mounting every known host copied the
 * same 17 skills into nine directories inside the user's repository, of which eight
 * served a host they do not use. Callers must say which hosts they mean.
 */
function selectedHostIds(clients: readonly string[]): string[] {
  return [...new Set(clients.map((id) => (id === 'workbuddy' ? 'codebuddy' : id)))].filter(
    (id) => HOST_SKILL_MOUNTS[id],
  );
}

/** Every distinct skills directory a host mount could occupy, for discovery and removal. */
function hostSkillDirs(projectRoot: string): string[] {
  return [...new Set(Object.values(HOST_SKILL_MOUNTS))].map((mount) => join(projectRoot, mount));
}

/**
 * Install package-owned copies into host-native skill/rule paths.
 *
 * This intentionally does not consult `.forgeax-harness/install-manifest.json`:
 * an npm consumer has no harness checkout, and a host should still discover the
 * game skill. The harness replay remains an optional compatibility enhancement.
 */
/**
 * Install the bundled skills into the named hosts' mount directories.
 *
 * `projectRoot` is always a project — never the home directory. Installing at user
 * level as well produced two copies of every skill, and hosts load both: a real
 * session listed all 16 Engine skills twice, doubling the skill inventory in context
 * and leaving two copies free to drift to different plugin versions.
 */
export function installHostDevKit(
  projectRoot: string,
  clients: readonly string[],
  skills: readonly BundledSkill[] = bundledSkills(),
): HostDevKitInstallResult {
  const skillPaths: string[] = [];
  const rulePaths: string[] = [];
  let changed = false;
  for (const id of selectedHostIds(clients)) {
    const skillsDir = join(projectRoot, HOST_SKILL_MOUNTS[id]!);
    for (const skill of skills) {
      changed = copySkill(skill.path, join(skillsDir, skill.id)) || changed;
    }
    const rulePath = join(projectRoot, HOST_RULE_MOUNTS[id]!, `${PLUGIN_SKILL_ID}.md`);
    changed = writeTextIfChanged(rulePath, ROUTING_TEXT) || changed;
    skillPaths.push(skillsDir);
    rulePaths.push(rulePath);
  }
  const skillIds = skills.map((skill) => skill.id);
  const noun = skillPaths.length === 1 ? 'host' : 'hosts';
  return {
    changed,
    skillPaths,
    rulePaths,
    skillIds: skillPaths.length ? skillIds : [],
    note: skillPaths.length
      ? `${describeSkills(skillIds)} installed for ${skillPaths.length} ${noun}.`
      : 'No host was selected, so no skills were installed. Run `forgeax-game install --ide <hosts>`.',
  };
}

function replayForgeaxInstall(projectRoot: string): { mounted: boolean; note: string } {
  const manifestPath = join(projectRoot, '.forgeax-harness', 'install-manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      mounted: false,
      note: 'Package-owned host mounts are active; forgeax-install is optional compatibility for additional harness capabilities.',
    };
  }

  let manifest: InstallManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as InstallManifest;
  } catch (error) {
    throw new Error(`cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest.harnessRoot || !manifest.specPath) {
    throw new Error(`${manifestPath} does not record harnessRoot and specPath`);
  }
  if (manifest.targetRoot && resolve(manifest.targetRoot) !== resolve(projectRoot)) {
    throw new Error(`${manifestPath} belongs to ${manifest.targetRoot}, not ${projectRoot}`);
  }

  const installer = join(
    manifest.harnessRoot,
    'skills',
    'forgeax-install',
    'scripts',
    'install_harness.py',
  );
  if (!existsSync(installer) || !existsSync(manifest.specPath)) {
    return {
      mounted: false,
      note: 'Package-owned host mounts are active; the recorded forgeax-install checkout is unavailable (optional).',
    };
  }

  const python = manifest.pythonInterpreter && existsSync(manifest.pythonInterpreter)
    ? manifest.pythonInterpreter
    : 'python3';
  const result = spawnSync(
    python,
    [installer, '--spec', manifest.specPath, '--target-root', projectRoot],
    { cwd: manifest.harnessRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`forgeax-install could not mount ${PLUGIN_SKILL_ID}: ${detail}`);
  }
  return { mounted: true, note: 'Mounted by forgeax-install into all configured agent hosts.' };
}

/**
 * Install the development kit for the given hosts.
 *
 * Skills live only in host mount directories. A plain `<project>/skills/` copy used to
 * be written too, but no host reads it — it existed only as an install marker, so it
 * was pure duplication inside the user's repository.
 */
export function installDevKit(
  projectRoot: string,
  clients: readonly string[],
): DevKitInstallResult {
  const skills = bundledSkills();
  const hosts = installHostDevKit(projectRoot, clients, skills);
  const mounted = replayForgeaxInstall(projectRoot);
  return {
    skillsRoot: hosts.skillPaths[0] ?? projectRoot,
    skillIds: hosts.skillIds,
    rulePath: hosts.rulePaths[0] ?? '',
    changed: hosts.changed,
    hostPaths: hosts.skillPaths,
    ...mounted,
    note: `${hosts.note} ${mounted.note}`,
  };
}

/** Is the plugin skill mounted for at least one host in this project? */
export function hasDevKit(projectRoot: string): boolean {
  return hostSkillDirs(projectRoot).some((dir) => {
    const skillPath = join(dir, PLUGIN_SKILL_ID, 'SKILL.md');
    return existsSync(skillPath) && statSync(skillPath).isFile();
  });
}

/**
 * Engine authoring skills present in this project, deduplicated across host mounts.
 *
 * Counting per mount would multiply by the number of installed hosts and make a
 * complete install look like drift.
 */
export function installedEngineSkills(projectRoot: string): readonly string[] {
  const found = new Set<string>();
  for (const dir of hostSkillDirs(projectRoot)) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isEngineSkill(entry.name)) continue;
      if (existsSync(join(dir, entry.name, 'SKILL.md'))) found.add(entry.name);
    }
  }
  return [...found].sort();
}

export interface DevKitRemoval {
  readonly removed: readonly string[];
  readonly skillCount: number;
}

/**
 * Remove everything this plugin mounted into a project's host directories.
 *
 * Only paths this plugin owns are touched: its own skill ids and its own rule file.
 * A host directory holding unrelated skills is left in place.
 */
export function removeDevKit(projectRoot: string): DevKitRemoval {
  const owned = new Set(bundledSkills().map((skill) => skill.id));
  const removed: string[] = [];
  let skillCount = 0;
  for (const mount of new Set(Object.values(HOST_SKILL_MOUNTS))) {
    const dir = join(projectRoot, mount);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const bare = entry.name.replace(/\.bak\.latest$/, '');
      if (!owned.has(bare) && !isEngineSkill(bare)) continue;
      rmSync(join(dir, entry.name), { recursive: true, force: true });
      if (!entry.name.endsWith('.bak.latest')) skillCount += 1;
    }
    removed.push(dir);
  }
  for (const mount of new Set(Object.values(HOST_RULE_MOUNTS))) {
    for (const suffix of ['.md', '.md.bak.latest']) {
      rmSync(join(projectRoot, mount, `${PLUGIN_SKILL_ID}${suffix}`), { force: true });
    }
  }
  // Retired locations from earlier versions, which nothing reads any more.
  for (const legacy of ['skills', 'rules']) {
    const dir = join(projectRoot, legacy);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const bare = entry.name.replace(/\.bak\.latest$/, '').replace(/\.md$/, '');
      if (!owned.has(bare) && !isEngineSkill(bare)) continue;
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch { /* leave a directory we cannot read */ }
  }
  return { removed, skillCount };
}

/** How many Engine authoring skills this build carries, regardless of any project. */
export function bundledEngineSkillCount(): number {
  try {
    return bundledSkills().filter((skill) => isEngineSkill(skill.id)).length;
  } catch {
    return 0;
  }
}
