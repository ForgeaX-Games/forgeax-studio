import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { discoverExtensions, enableExtension, disableExtension, disableAllExtensions, runExtension, registeredProjects } from '../src/extensions/manager';
const roots: string[] = [];
const previousState = process.env.FORGEAX_USER_STATE_DIR;
afterEach(() => {
  if (previousState === undefined) delete process.env.FORGEAX_USER_STATE_DIR; else process.env.FORGEAX_USER_STATE_DIR = previousState;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(id = 'sample') {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'extension-test-'))); roots.push(root);
  process.env.FORGEAX_USER_STATE_DIR = resolve(root, 'user-state');
  const directory = resolve(root, 'extensions', id);
  mkdirSync(resolve(directory, 'skills/sample-skill'), { recursive: true });
  writeFileSync(resolve(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', skills: ['skills/sample-skill'], cli: 'cli.mjs' }));
  writeFileSync(resolve(directory, 'skills/sample-skill/SKILL.md'), '# Sample\n{{CLI}} echo --json\n');
  writeFileSync(resolve(directory, 'cli.mjs'), 'export async function check(c,a) { if(a.includes("--fail")) throw new Error("check_failed"); return {ready:true}; } export async function run(c,a) { return {operation:a[0],root:c.projectRoot}; }');
  const extension = discoverExtensions(resolve(root, 'extensions'))[0]!;
  const project = resolve(root, 'game'); mkdirSync(project);
  return { root, project, extension, skill: resolve(project, '.agents/skills/sample-skill/SKILL.md') };
}
test('directory-only extension enables, routes, disables and re-enables without host code', async () => {
  const f = fixture();
  await expect(runExtension(f.project, f.extension, ['echo'])).rejects.toThrow('extension_not_enabled');
  await enableExtension(f.project, f.extension, ['codex'], []);
  expect(readFileSync(f.skill, 'utf8')).toContain('npx -y @forgeax/game@');
  expect(readFileSync(f.skill, 'utf8')).toContain('sample echo');
  expect(await runExtension(f.project, f.extension, ['echo'])).toEqual({ operation: 'echo', root: f.project });
  await enableExtension(f.project, f.extension, ['codex'], []);
  expect(readdirSync(resolve(f.project, '.agents/skills'))).toEqual(['sample-skill']);
  expect(existsSync(resolve(f.project, '.claude'))).toBeFalse();
  expect(registeredProjects()).toEqual([f.project]);
  expect(disableExtension(f.project, 'sample').removed).toBe(1);
  expect(existsSync(f.skill)).toBeFalse();
  expect(existsSync(resolve(f.project, '.forgeax/extensions/sample'))).toBeFalse();
  expect(registeredProjects()).toEqual([]);
  expect(disableExtension(f.project, 'sample').removed).toBe(0);
  await expect(runExtension(f.project, f.extension, ['echo'])).rejects.toThrow('extension_not_enabled');
  await enableExtension(f.project, f.extension, ['codex'], []);
  expect(disableAllExtensions(f.project)).toHaveLength(1);
});
test('failed checks leave no registration or discoverable skill', async () => {
  const f = fixture();
  await expect(enableExtension(f.project, f.extension, ['codex'], ['--fail'])).rejects.toThrow('check_failed');
  expect(existsSync(f.skill)).toBeFalse();
  expect(existsSync(resolve(f.project, '.forgeax/extensions/sample/install.json'))).toBeFalse();
  expect(registeredProjects()).toEqual([]);
});
test('disable archives edited skills outside discovery and preserves authored assets', async () => {
  const f = fixture();
  await enableExtension(f.project, f.extension, ['codex'], []);
  writeFileSync(f.skill, 'user edit');
  writeFileSync(resolve(f.project, 'game.pack.ts'), 'user asset');
  await expect(enableExtension(f.project, f.extension, ['codex'], [])).rejects.toThrow('extension_skill_conflict');
  const result = disableExtension(f.project, 'sample');
  expect(result.backups).toHaveLength(1);
  expect(readFileSync(result.backups[0]!, 'utf8')).toBe('user edit');
  expect(existsSync(f.skill)).toBeFalse();
  expect(readFileSync(resolve(f.project, 'game.pack.ts'), 'utf8')).toBe('user asset');
});
test('rejects symlink mounts and escaped manifests before mutation', async () => {
  const f = fixture();
  const outside = resolve(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, resolve(f.project, '.agents'));
  await expect(enableExtension(f.project, f.extension, ['codex'], [])).rejects.toThrow('extension_symlink');
  expect(readdirSync(outside)).toEqual([]);
  writeFileSync(resolve(f.extension.directory, 'extension.json'), JSON.stringify({ ...f.extension, cli: '../escape.mjs' }));
  expect(() => discoverExtensions(resolve(f.root, 'extensions'))).toThrow('extension_path_escape');
});

test('active business calls prevent disable from deleting their state', async () => {
  const f = fixture('slow');
  writeFileSync(resolve(f.extension.directory, 'cli.mjs'), 'export async function check(){return {}} export async function run(){await new Promise(r=>setTimeout(r,30));return {done:true}}');
  await enableExtension(f.project, f.extension, ['codex'], []);
  const running = runExtension(f.project, f.extension, ['run']);
  expect(() => disableExtension(f.project, 'slow')).toThrow('extension_busy');
  expect(await running).toEqual({ done: true });
  expect(disableExtension(f.project, 'slow').disabled).toBeTrue();
});

test('registry tracks multiple projects and each cleanup preserves the others', async () => {
  const f = fixture();
  const second = resolve(f.root, 'second'); mkdirSync(second);
  await enableExtension(f.project, f.extension, ['codex'], []);
  await enableExtension(second, f.extension, ['cursor'], []);
  expect(new Set(registeredProjects())).toEqual(new Set([f.project, second]));
  disableAllExtensions(f.project);
  expect(registeredProjects()).toEqual([second]);
  disableAllExtensions(second);
  expect(registeredProjects()).toEqual([]);
});
