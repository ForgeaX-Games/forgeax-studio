import { lstatSync, readFileSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HOSTS: Record<string, string[]> = {
  '.agents/skills': ['codex'],
  '.claude/skills': ['claude'],
  '.cursor/skills': ['cursor'],
  '.codebuddy/skills': ['codebuddy', 'workbuddy'],
  '.workbuddy/skills': ['workbuddy'],
};

/** Remove only pristine Engine-generated mounts for unselected clients. */
export function pruneUnselectedEngineMounts(root: string, clients: readonly string[]): string[] {
  const manifestPath = join(root, '.forgeax', 'skill-install-manifest.json');
  const regular = (path: string) => {
    try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
  };
  const directory = (path: string) => {
    try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
  };
  if (!directory(join(root, '.forgeax')) || !regular(manifestPath)) return [];
  let manifest: { schemaVersion?: string; sourceRoot?: string; mounts?: Array<{ root: string; skills: string[] }> };
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return []; }
  if (!manifest || manifest.schemaVersion !== '1.0.0' || manifest.sourceRoot !== 'skills' || !Array.isArray(manifest.mounts)) return [];
  const removed: string[] = [];
  for (const mount of manifest.mounts) {
    if (!mount || typeof mount.root !== 'string' || !Object.hasOwn(HOSTS, mount.root)) continue;
    const hosts = HOSTS[mount.root];
    if (!hosts || hosts.some(host => clients.includes(host)) || !Array.isArray(mount.skills)) continue;
    if (!mount.skills.length || !mount.skills.every(id => /^forgeax-engine-[a-z0-9-]+$/.test(id)) || new Set(mount.skills).size !== mount.skills.length) continue;
    const path = join(root, mount.root);
    if (!directory(dirname(path)) || !directory(path)) continue;
    const expected = ['.gitignore', ...mount.skills].sort();
    if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(expected)) continue;
    const ignore = join(path, '.gitignore');
    const expectedIgnore = ['# BEGIN FORGEAX MANAGED SKILLS', ...mount.skills.map(id => `/${id}`), '# END FORGEAX MANAGED SKILLS', ''].join('\n');
    if (!regular(ignore) || readFileSync(ignore, 'utf8') !== expectedIgnore) continue;
    if (!mount.skills.every(id => {
      const link = join(path, id);
      return lstatSync(link).isSymbolicLink() && resolve(path, readlinkSync(link)) === resolve(root, 'skills', id);
    })) continue;
    for (const id of mount.skills) unlinkSync(join(path, id));
    unlinkSync(ignore);
    rmdirSync(path);
    if (readdirSync(dirname(path)).length === 0) rmdirSync(dirname(path));
    removed.push(mount.root);
  }
  if (removed.length) {
    manifest.mounts = manifest.mounts.filter(mount => !mount || !removed.includes(mount.root));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return removed;
}
