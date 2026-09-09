import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bunWorkspaceInstallArgs,
  prepareWindowsWorkspaceJunctions,
  removeWindowsWorkspaceNodeModulesBridges,
  repairWindowsNestedDirectoryLinks,
  repairWindowsDirectoryAlias,
  restoreWindowsDirectoryAlias,
} from './bun-workspace-install.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Windows Bun workspace installation', () => {
  test('uses a hoisted copyfile install without requiring package symlinks', () => {
    expect(bunWorkspaceInstallArgs('win32')).toEqual([
      'install',
      '--ignore-scripts',
      '--linker',
      'hoisted',
      '--backend',
      'copyfile',
    ]);
    expect(bunWorkspaceInstallArgs('linux')).toEqual(['install', '--ignore-scripts']);
  });

  test('prepares sibling workspaces as directory junctions', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-bun-workspace-'));
    roots.push(root);
    const composition = join(root, 'packages/composition');
    const basePackage = join(root, 'packages/base');
    mkdirSync(composition, { recursive: true });
    mkdirSync(basePackage, { recursive: true });
    writeFileSync(
      join(composition, 'package.json'),
      JSON.stringify({ name: '@example/composition', workspaces: ['../base'] }),
    );
    writeFileSync(
      join(basePackage, 'package.json'),
      JSON.stringify({ name: '@example/base' }),
    );

    const prepared = prepareWindowsWorkspaceJunctions(composition, 'win32');
    const link = join(composition, 'node_modules/@example/base');

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.packageName).toBe('@example/base');
    expect(realpathSync(link)).toBe(realpathSync(basePackage));
    expect(realpathSync(join(basePackage, 'node_modules'))).toBe(
      realpathSync(join(composition, 'node_modules')),
    );
    expect(removeWindowsWorkspaceNodeModulesBridges(composition, prepared, 'win32')).toBe(1);
    expect(() => realpathSync(join(basePackage, 'node_modules'))).toThrow();
  });

  test('expands directory-star workspaces without bridging member node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-bun-workspace-glob-'));
    roots.push(root);
    const editor = join(root, 'editor');
    const runtime = join(editor, 'packages/runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(editor, 'package.json'),
      JSON.stringify({ name: '@forgeax/editor', workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(runtime, 'package.json'),
      JSON.stringify({ name: '@forgeax/editor-runtime' }),
    );

    const prepared = prepareWindowsWorkspaceJunctions(editor, 'win32', false);

    expect(prepared.map(({ packageName }) => packageName)).toEqual(['@forgeax/editor-runtime']);
    expect(realpathSync(join(editor, 'node_modules/@forgeax/editor-runtime'))).toBe(
      realpathSync(runtime),
    );
    expect(() => realpathSync(join(runtime, 'node_modules'))).toThrow();
  });

  test('materializes and restores a Git plain-text directory alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-bun-directory-alias-'));
    roots.push(root);
    const consumer = join(root, 'consumer');
    const sharedPatches = join(root, 'source/patches');
    const alias = join(consumer, 'patches');
    mkdirSync(consumer, { recursive: true });
    mkdirSync(sharedPatches, { recursive: true });
    writeFileSync(alias, '../source/patches');

    const repaired = repairWindowsDirectoryAlias(alias, 'win32');

    expect(repaired).not.toBeNull();
    expect(realpathSync(alias)).toBe(realpathSync(sharedPatches));

    restoreWindowsDirectoryAlias(repaired);
    expect(readFileSync(alias, 'utf8')).toBe('../source/patches');
  });

  test('does nothing outside Windows', () => {
    expect(prepareWindowsWorkspaceJunctions('not-used', 'linux')).toEqual([]);
    expect(removeWindowsWorkspaceNodeModulesBridges('not-used', [], 'linux')).toBe(0);
    expect(repairWindowsNestedDirectoryLinks('not-used', 'linux')).toBe(0);
  });
});
