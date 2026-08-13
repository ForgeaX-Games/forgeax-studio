import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { repairPluginDirectoryLink } from './plugin-directory-links';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

function makeFixture(): { root: string; target: string; alias: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-plugin-link-'));
  fixtures.push(root);
  const target = join(root, 'node-editor', 'apps', 'wb-3d-lowpoly');
  const alias = join(root, 'extensions', 'wb-3d-lowpoly');
  mkdirSync(target, { recursive: true });
  mkdirSync(dirname(alias), { recursive: true });
  writeFileSync(join(target, 'package.json'), '{}\n');
  return { root, target, alias };
}

test('repairs a Windows text symlink placeholder into a directory link', () => {
  const { target, alias } = makeFixture();
  writeFileSync(alias, relative(dirname(alias), target));

  expect(repairPluginDirectoryLink(alias, 'win32')).toBe(resolve(target));
  expect(statSync(alias).isDirectory()).toBe(true);
});

test('leaves an existing directory link unchanged', () => {
  const { target, alias } = makeFixture();
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const before = readlinkSync(alias);

  expect(repairPluginDirectoryLink(alias, 'win32')).toBeNull();
  expect(readlinkSync(alias)).toBe(before);
});
