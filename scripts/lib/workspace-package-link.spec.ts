import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureWorkspacePackageLink } from './workspace-package-link.ts';

const roots: string[] = [];

function fixture(): { root: string; link: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-workspace-link-'));
  roots.push(root);
  const link = join(root, 'node_modules/@forgeax/editor-core');
  const target = join(root, 'packages/editor/packages/core');
  mkdirSync(join(root, 'node_modules/@forgeax'), { recursive: true });
  mkdirSync(target, { recursive: true });
  return { root, link, target };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ensureWorkspacePackageLink', () => {
  test('keeps a link that already resolves to the current workspace package', () => {
    const { root, link, target } = fixture();
    symlinkSync(target, link, 'dir');

    expect(ensureWorkspacePackageLink(link, target, root, false)).toBe('current');
    expect(resolve(link, '..', readlinkSync(link))).toBe(target);
  });

  test('keeps a link to another package location inside the current workspace', () => {
    const { root, link, target } = fixture();
    const duplicateTarget = join(root, 'packages/editor/packages/interface');
    mkdirSync(duplicateTarget, { recursive: true });
    symlinkSync(duplicateTarget, link, 'dir');

    expect(ensureWorkspacePackageLink(link, target, root, false)).toBe('current');
    expect(readlinkSync(link)).toBe(duplicateTarget);
  });

  test('replaces a link to an old image workspace', () => {
    const { root, link, target } = fixture();
    const oldWorkspace = mkdtempSync(join(tmpdir(), 'forgeax-workspace-seed-'));
    roots.push(oldWorkspace);
    const oldTarget = join(oldWorkspace, 'packages/editor/packages/core');
    mkdirSync(oldTarget, { recursive: true });
    symlinkSync(oldTarget, link, 'dir');

    expect(ensureWorkspacePackageLink(link, target, root, false)).toBe('relinked');
    expect(readlinkSync(link)).toBe(target);
  });

  test('replaces a dangling link', () => {
    const { root, link, target } = fixture();
    symlinkSync(join(root, 'deleted-workspace/editor-core'), link, 'dir');

    expect(ensureWorkspacePackageLink(link, target, root, false)).toBe('relinked');
    expect(readlinkSync(link)).toBe(target);
  });

  test('does not delete a real directory occupying the package path', () => {
    const { root, link, target } = fixture();
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'package.json'), '{"name":"@forgeax/editor-core"}\n');

    expect(ensureWorkspacePackageLink(link, target, root, false)).toBe('occupied');
  });
});
