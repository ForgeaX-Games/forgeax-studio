import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configuredHome } from '../install/clients';
import { RELEASE_IDENTITY } from '../install/release-manifest';
import type { ExtensionCLI, ExtensionContext } from './contract';

const mounts: Record<string, string> = {
  codex: '.agents/skills', claude: '.claude/skills', cursor: '.cursor/skills',
  trae: '.trae/skills', codebuddy: '.codebuddy/skills', windsurf: '.codeium/windsurf/skills',
  vscode: '.vscode/skills', zcode: '.zcode/skills', opencode: '.config/opencode/skills',
};
const reserved = new Set(['install', 'init', 'uninstall', 'update', 'use', 'doctor', 'preview', 'devkit', 'agents', 'help', 'version']);
const validId = (id: string) => /^[a-z][a-z0-9-]{0,63}$/.test(id) && !reserved.has(id);
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export interface Extension { schemaVersion: 1; id: string; version: string; skills: string[]; cli: string; directory: string }
interface FileRecord { path: string; sha256: string }
interface Installation { schemaVersion: 1; id: string; version: string; packageVersion: string; files: FileRecord[] }

function safe(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('extension_path_escape');
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('extension_symlink_not_allowed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}
function json(path: string) {
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) throw new Error('extension_state_too_large');
  return JSON.parse(bytes.toString());
}
export function extensionRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return [resolve(here, '../assets/extensions'), resolve(here, '../../extensions')].find(existsSync)
    ?? resolve(here, '../assets/extensions');
}
export function discoverExtensions(root = extensionRoot()): Extension[] {
  if (!existsSync(root)) return [];
  const found: Extension[] = [];
  for (const id of readdirSync(root)) {
    if (!validId(id)) continue;
    const directory = safe(root, id);
    if (!lstatSync(directory).isDirectory()) continue;
    const value = json(safe(directory, 'extension.json'));
    if (value.schemaVersion !== 1 || value.id !== id || typeof value.version !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.cli !== 'string' ||
        !value.cli.endsWith('.mjs') || !Array.isArray(value.skills) || !value.skills.length ||
        value.skills.some((s: unknown) => typeof s !== 'string' || !/^skills\/[a-z][a-z0-9-]*$/.test(s))) {
      throw new Error(`extension_manifest_invalid: ${id}`);
    }
    safe(directory, value.cli);
    for (const skill of value.skills) safe(directory, skill + '/SKILL.md');
    found.push({ ...value, directory });
  }
  return found;
}
export function extensionState(root: string, id: string): string {
  if (!validId(id)) throw new Error('extension_id_invalid');
  return safe(root, `.forgeax/extensions/${id}`);
}
function installation(root: string, id: string): Installation | undefined {
  const path = safe(root, `.forgeax/extensions/${id}/install.json`);
  if (!existsSync(path)) return undefined;
  const record = json(path) as Installation;
  if (record.schemaVersion !== 1 || record.id !== id || !Array.isArray(record.files)) throw new Error('extension_install_invalid');
  for (const file of record.files) {
    if (typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Object.values(mounts).some(mount => file.path.startsWith(mount + '/')) ||
        !file.path.endsWith('/SKILL.md')) throw new Error('extension_install_invalid');
    safe(root, file.path);
  }
  return record;
}
async function load(extension: Extension): Promise<ExtensionCLI> {
  let entry = safe(extension.directory, extension.cli);
  // Development only: source entry is compiled to the manifest's .mjs at build time.
  if (!existsSync(entry) && existsSync(entry.replace(/\.mjs$/, '.ts'))) entry = entry.replace(/\.mjs$/, '.ts');
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.check !== 'function' || typeof mod.run !== 'function') throw new Error('extension_cli_invalid');
  return mod;
}
function context(root: string, id: string): ExtensionContext {
  return { projectRoot: root, stateDir: extensionState(root, id), packageVersion: RELEASE_IDENTITY.gameVersion };
}
function lock(root: string): () => void {
  const path = safe(realpathSync(root), '.forgeax/extension-operation.lock');
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); } catch { throw new Error('extension_busy: another operation or an interrupted lock requires attention'); }
  return () => rmdirSync(path);
}
const userState = () => resolve(process.env.FORGEAX_USER_STATE_DIR ?? resolve(configuredHome(), '.forgeax'));
const registryPath = () => resolve(userState(), 'extension-projects.json');
export function registeredProjects(): string[] {
  if (!existsSync(registryPath())) return [];
  const value = json(registryPath());
  if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('extension_registry_invalid');
  return value;
}
function register(root: string, enabled: boolean) {
  mkdirSync(userState(), { recursive: true });
  safe(realpathSync(userState()), 'extension-projects.json');
  const projects = new Set(registeredProjects());
  enabled ? projects.add(root) : projects.delete(root);
  if (projects.size) write(registryPath(), JSON.stringify([...projects]) + '\n');
  else if (existsSync(registryPath())) rmSync(registryPath());
}

export async function enableExtension(rootInput: string, extension: Extension, hosts: string[], args: string[], localEntry?: string) {
  const release = lock(rootInput);
  try { return await enableUnlocked(rootInput, extension, hosts, args, localEntry); }
  finally { release(); }
}
async function enableUnlocked(rootInput: string, extension: Extension, hosts: string[], args: string[], localEntry?: string) {
  const root = realpathSync(rootInput);
  const state = extensionState(root, extension.id);
  const previous = installation(root, extension.id);
  if (!hosts.length || hosts.some(host => !mounts[host])) throw new Error('extension_host_required: select installed agents with --ide');
  const command = localEntry ? `node '${realpathSync(localEntry).replaceAll("'", "'\\''")}' ${extension.id}`
    : `npx -y @forgeax/game@${RELEASE_IDENTITY.gameVersion} ${extension.id}`;
  const files = hosts.flatMap(host => extension.skills.map(skill => {
    const content = readFileSync(safe(extension.directory, `${skill}/SKILL.md`), 'utf8').replaceAll('{{CLI}}', command);
    return { path: `${mounts[host]}/${skill.slice('skills/'.length)}/SKILL.md`, sha256: digest(content), content };
  }));
  for (const file of files) {
    const target = safe(root, file.path);
    if (existsSync(target) && digest(readFileSync(target)) !== previous?.files.find(f => f.path === file.path)?.sha256) {
      throw new Error('extension_skill_conflict: ' + file.path);
    }
  }
  // The extension may validate services, but only the manager publishes Skills/state.
  const cli = await load(extension);
  const config = await cli.check(context(root, extension.id), args);
  const targets = new Map<string, Buffer | undefined>();
  const remember = (path: string) => { targets.set(path, existsSync(path) ? readFileSync(path) : undefined); };
  for (const file of files) remember(safe(root, file.path));
  remember(safe(root, `.forgeax/extensions/${extension.id}/config.json`));
  remember(safe(root, `.forgeax/extensions/${extension.id}/install.json`));
  try {
    write(resolve(state, 'config.json'), JSON.stringify(config) + '\n');
    for (const file of files) write(safe(root, file.path), file.content);
    const record: Installation = { schemaVersion: 1, id: extension.id, version: extension.version,
      packageVersion: RELEASE_IDENTITY.gameVersion,
      files: [...(previous?.files.filter(f => !files.some(n => n.path === f.path)) ?? []), ...files.map(({path, sha256}) => ({path, sha256}))] };
    write(resolve(state, 'install.json'), JSON.stringify(record) + '\n');
    register(root, true);
  } catch (error) {
    for (const [path, old] of targets) {
      if (old) write(path, old.toString()); else if (existsSync(path)) rmSync(path);
    }
    throw error;
  }
  return { enabled: true, id: extension.id, version: extension.version, skillFiles: files.length };
}

export function disableExtension(rootInput: string, id: string) {
  const release = lock(rootInput);
  try { return disableUnlocked(rootInput, id); } finally { release(); }
}
function disableUnlocked(rootInput: string, id: string) {
  const root = realpathSync(rootInput);
  const previous = installation(root, id);
  if (!previous) return { disabled: true, id, removed: 0, backups: [] as string[] };
  const backups: string[] = [];
  let removed = 0;
  for (const file of previous.files) {
    const path = safe(root, file.path);
    if (existsSync(path)) {
      if (digest(readFileSync(path)) !== file.sha256) {
        const backup = safe(root, `.forgeax/extension-backups/${id}/${randomUUID()}/${file.path}`);
        mkdirSync(dirname(backup), { recursive: true });
        renameSync(path, backup); backups.push(backup);
      } else rmSync(path);
      removed++;
    }
    try { rmdirSync(dirname(path)); } catch { /* Keep other user files. */ }
  }
  rmSync(extensionState(root, id), { recursive: true });
  const installed = installedExtensions(root);
  if (!installed.length) register(root, false);
  return { disabled: true, id, removed, backups };
}
export function installedExtensions(root: string): string[] {
  const dir = safe(root, '.forgeax/extensions');
  return existsSync(dir) ? readdirSync(dir).filter(id => validId(id) && installation(root, id)) : [];
}
export function disableAllExtensions(root: string) {
  return installedExtensions(root).map(id => disableExtension(root, id));
}
export async function runExtension(root: string, extension: Extension, args: string[]) {
  const release = lock(root);
  try {
  const record = installation(root, extension.id);
  if (!record) throw new Error('extension_not_enabled: run ' + extension.id + ' enable');
  if (record.version !== extension.version || record.packageVersion !== RELEASE_IDENTITY.gameVersion) throw new Error('extension_version_mismatch: enable with this version');
  return await (await load(extension)).run(context(root, extension.id), args);
  } finally { release(); }
}
