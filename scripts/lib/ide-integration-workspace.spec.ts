import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createIdeIntegrationRootManifest,
  ensureIdeIntegrationPackageLinks,
  IDE_INTEGRATION_DEPENDENCIES,
  IDE_INTEGRATION_ROOT_WORKSPACES,
  IDE_INTEGRATION_WORKSPACES,
  writeIdeIntegrationWorkspaceManifest,
} from './ide-integration-workspace.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; workspaceDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-ide-integration-workspace-'));
  roots.push(root);
  const workspaceDir = join(root, '.forgeax/ide-source-workspace');
  for (const workspace of IDE_INTEGRATION_WORKSPACES) {
    if (workspace.includes('*')) continue;
    const packageDir = resolve(workspaceDir, workspace);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), '{"private":true}\n');
  }
  return { root, workspaceDir };
}

describe('IDE integration workspace manifest', () => {
  test('derives one install graph for the IDE, its packages, and Studio source dependencies', () => {
    const { workspaceDir } = fixture();
    const manifestPath = writeIdeIntegrationWorkspaceManifest(workspaceDir);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      workspaces: string[];
      dependencies: Record<string, string>;
      overrides?: Record<string, string>;
    };

    expect(manifest.workspaces).toEqual([...IDE_INTEGRATION_WORKSPACES]);
    expect(manifest.workspaces).toContain('../../packages/ide/packages/*');
    expect(manifest.workspaces).toContain('../../packages/cli');
    expect(manifest.workspaces).toContain('../../packages/editor');
    expect(manifest.workspaces).toContain('../../packages/editor/packages/core');
    expect(manifest.workspaces).toContain('../../packages/editor/packages/edit-runtime');
    expect(manifest.workspaces).toContain('../../packages/platform-io');
    expect(manifest.workspaces).toContain('../../packages/editor/packages/engine/packages/*');
    expect(manifest.workspaces).toContain('../../packages/interface');
    expect(manifest.workspaces).not.toContain('../../packages/host-sdk');
    expect(manifest.dependencies).toEqual(IDE_INTEGRATION_DEPENDENCIES);
    expect(manifest.overrides).toEqual({
      '@happy-dom/global-registrator': '20.11.0',
      'happy-dom': '20.11.0',
    });
  });

  test('fails before install when a required source package is missing', () => {
    const { root, workspaceDir } = fixture();
    rmSync(join(root, 'packages/interface'), { recursive: true, force: true });

    expect(() => writeIdeIntegrationWorkspaceManifest(workspaceDir)).toThrow('IDE integration workspace missing package');
  });

  test('links the public Editor facade into the IDE package after the sibling install', () => {
    const { root } = fixture();
    const linkPath = join(root, 'packages/ide/node_modules/@forgeax/editor');

    expect(ensureIdeIntegrationPackageLinks(root)).toHaveLength(11);
    expect(readlinkSync(linkPath)).toBe(join(root, 'packages/editor'));
    expect(readlinkSync(join(root, 'packages/ide/node_modules/@forgeax/editor-panels')))
      .toBe(join(root, 'packages/editor/packages/panels'));
  });

  test('derives a descendant-only workspace graph for the Windows CI install', () => {
    const manifest = createIdeIntegrationRootManifest({
      name: 'forgeax-studio',
      workspaces: ['packages/npc-client'],
      overrides: { existing: '1.0.0' },
    }) as { workspaces: string[]; dependencies: Record<string, string>; overrides: Record<string, string> };

    expect(manifest.workspaces).toEqual(IDE_INTEGRATION_ROOT_WORKSPACES);
    expect(manifest.workspaces).toContain('packages/ide/packages/*');
    expect(manifest.workspaces).toContain('packages/cli');
    expect(manifest.workspaces).toContain('packages/editor');
    expect(manifest.workspaces).toContain('packages/editor/packages/core');
    expect(manifest.workspaces).toContain('packages/editor/packages/edit-runtime');
    expect(manifest.workspaces).toContain('packages/platform-io');
    expect(manifest.workspaces).toContain('packages/editor/packages/engine/packages/*');
    expect(manifest.workspaces).toContain('packages/recursive-input-contract');
    expect(manifest.dependencies).toEqual({
      '@forgeax/editor': 'workspace:*',
    });
    expect(manifest.workspaces.every((workspace) => !workspace.startsWith('../'))).toBe(true);
    expect(manifest.overrides).toEqual({
      existing: '1.0.0',
      '@happy-dom/global-registrator': '20.11.0',
      'happy-dom': '20.11.0',
    });
  });
});
