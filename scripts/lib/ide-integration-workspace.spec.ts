import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createIdeIntegrationRootManifest,
  ensureIdeIntegrationPackageLinks,
  IDE_INTEGRATION_DEPENDENCIES,
  ideIntegrationRootWorkspaces,
  ideIntegrationWorkspaces,
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
  for (const workspace of [
    '../../packages/ide',
    '../../packages/app-shell',
    '../../packages/extension-platform',
    '../../packages/editor',
    '../../packages/agent-host',
    '../../packages/orchestrator',
    '../../packages/server',
    '../../packages/platform-io',
    '../../packages/cli',
    '../../packages/interface',
    '../../packages/interface/packages/design',
    '../../packages/chat',
    '../../packages/dashboard',
    '../../packages/settings',
    '../../packages/recursive-input-contract',
  ]) {
    if (workspace.includes('*')) continue;
    const packageDir = resolve(workspaceDir, workspace);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ private: true,
      ...(workspace.endsWith('/app-shell') ? { name: '@forgeax/app-shell', version: '0.103.0' } : {}),
      ...(workspace.endsWith('/extension-platform') ? { name: '@forgeax/extension-platform', version: '0.7.0' } : {}),
    }));
  }
  for (const name of ['app', 'interface', 'play-runtime', 'without-manifest']) {
    const packageDir = join(root, 'packages/editor/packages', name);
    mkdirSync(packageDir, { recursive: true });
    if (name !== 'without-manifest') {
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: name === 'interface' ? '@forgeax/interface' : `@forgeax/editor-${name}` }),
      );
    }
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'forgeax-studio',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
      scheduler: '^0.27.0',
      ...IDE_INTEGRATION_DEPENDENCIES,
    },
    patchedDependencies: {
      'ink@6.8.0': 'patches/ink@6.8.0.patch',
    },
  }, null, 2)}\n`);
  return { root, workspaceDir };
}

describe('IDE integration workspace manifest', () => {
  test('includes IDE-owned artifact workspaces in both POSIX and Windows install graphs', () => {
    const { root, workspaceDir } = fixture();
    writeFileSync(join(root, 'packages/ide/package.json'), JSON.stringify({
      private: true, workspaces: ['.forgeax/product-packages/*'],
    }));
    const manifest = JSON.parse(readFileSync(writeIdeIntegrationWorkspaceManifest(workspaceDir), 'utf8'));
    expect(manifest.workspaces).toContain('../../packages/ide/.forgeax/product-packages/*');
    expect(ideIntegrationRootWorkspaces(root)).toContain('packages/ide/.forgeax/product-packages/*');
  });

  test('pins host React types at both install roots without overriding iframe dependencies', () => {
    const { root, workspaceDir } = fixture();
    writeFileSync(join(root, 'packages/ide/package.json'), JSON.stringify({
      devDependencies: { '@types/react': '19.1.10', '@types/react-dom': '19.1.7' },
    }));
    const manifests = [
      JSON.parse(readFileSync(writeIdeIntegrationWorkspaceManifest(workspaceDir), 'utf8')),
      createIdeIntegrationRootManifest({ devDependencies: { existing: '1.0.0' } }, root),
    ];
    for (const manifest of manifests) {
      expect(manifest.devDependencies).toMatchObject({ '@types/react': '19.1.10', '@types/react-dom': '19.1.7' });
      expect(manifest.overrides).not.toHaveProperty('@types/react');
    }
    expect(manifests[1].devDependencies.existing).toBe('1.0.0');
  });

  test('rejects IDE workspace paths outside the owning checkout', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'packages/ide/package.json'), JSON.stringify({workspaces: ['../other']}));
    expect(() => ideIntegrationWorkspaces(root)).toThrow('inside its owning repository');
  });

  test('derives one install graph for the IDE, its packages, and Studio source dependencies', () => {
    const { workspaceDir } = fixture();
    const manifestPath = writeIdeIntegrationWorkspaceManifest(workspaceDir);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      workspaces: string[];
      dependencies?: Record<string, string>;
      patchedDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };

    expect(manifest.workspaces).toEqual(ideIntegrationWorkspaces(resolve(workspaceDir, '../..')));
    expect(manifest.workspaces).toContain('../../packages/ide/packages/*');
    expect(manifest.workspaces).toContain('../../packages/agent-host');
    expect(manifest.workspaces).toContain('../../packages/extension-platform');
    expect(manifest.workspaces).toContain('../../packages/orchestrator');
    expect(manifest.workspaces).toContain('../../packages/platform-io');
    expect(manifest.workspaces).toContain('../../packages/cli');
    expect(manifest.workspaces).toContain('../../packages/editor/packages/app');
    expect(manifest.workspaces).toContain('../../packages/editor/packages/play-runtime');
    expect(manifest.workspaces).toContain('../../packages/editor/packages/engine/packages/*');
    expect(manifest.workspaces).toContain('../../packages/interface');
    expect(manifest.workspaces).toContain('../../packages/recursive-input-contract');
    expect(manifest.workspaces).not.toContain('../../packages/editor/packages/interface');
    expect(manifest.workspaces).not.toContain('../../packages/editor/packages/platform-io');
    expect(manifest.workspaces).not.toContain('../../packages/editor/packages/without-manifest');
    expect(manifest.workspaces).not.toContain('../../packages/host-sdk');
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
      scheduler: '^0.27.0',
      ...IDE_INTEGRATION_DEPENDENCIES,
    });
    expect(manifest.patchedDependencies).toBeUndefined();
    expect(manifest.overrides).toEqual({
      '@happy-dom/global-registrator': '20.11.0',
      'happy-dom': '20.11.0',
      '@forgeax/app-shell': 'workspace:*',
      '@forgeax/extension-platform': 'workspace:*',
      'npm-run-path': '6.0.0',
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

  test('replaces stale installed AppShell copies with the overridden source and preserves their contents', () => {
    const { root } = fixture();
    const consumer = join(root, 'packages/interface');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: '@forgeax/interface', dependencies: { '@forgeax/app-shell': '0.104.0' },
    }));
    const link = join(consumer, 'node_modules/@forgeax/app-shell');
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'package.json'), '{"name":"@forgeax/app-shell","version":"0.103.0"}');
    writeFileSync(join(link, 'local-note'), 'preserve this file');

    ensureIdeIntegrationPackageLinks(root);
    expect(realpathSync(link)).toBe(realpathSync(join(root, 'packages/app-shell')));
    const backups = join(root, '.forgeax/ide-source-workspace/link-backups');
    const [backup] = readdirSync(backups);
    expect(readFileSync(join(backups, backup!, 'original/local-note'), 'utf8')).toBe('preserve this file');
    ensureIdeIntegrationPackageLinks(root);
    expect(readdirSync(backups)).toEqual([backup!]);
  });

  test('repairs an override linked to another package inside the same checkout', () => {
    const { root } = fixture();
    const consumer = join(root, 'packages/interface');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      dependencies: { '@forgeax/app-shell': '0.104.0' },
    }));
    const link = join(consumer, 'node_modules/@forgeax/app-shell');
    mkdirSync(resolve(link, '..'), { recursive: true });
    symlinkSync(join(root, 'packages/editor'), link, process.platform === 'win32' ? 'junction' : 'dir');
    ensureIdeIntegrationPackageLinks(root);
    expect(realpathSync(link)).toBe(realpathSync(join(root, 'packages/app-shell')));
  });

  test('derives a descendant-only workspace graph for the Windows CI install', () => {
    const { root } = fixture();
    const manifest = createIdeIntegrationRootManifest({
      name: 'forgeax-studio',
      workspaces: ['packages/npc-client'],
      overrides: { existing: '1.0.0' },
    }, root) as { workspaces: string[]; overrides: Record<string, string> };

    expect(manifest.workspaces).toEqual(ideIntegrationRootWorkspaces(root));
    expect(manifest.workspaces).toContain('packages/ide/packages/*');
    expect(manifest.workspaces).toContain('packages/agent-host');
    expect(manifest.workspaces).toContain('packages/extension-platform');
    expect(manifest.workspaces).toContain('packages/orchestrator');
    expect(manifest.workspaces).toContain('packages/server');
    expect(manifest.workspaces).toContain('packages/platform-io');
    expect(manifest.workspaces).toContain('packages/cli');
    expect(manifest.workspaces).toContain('packages/editor/packages/app');
    expect(manifest.workspaces).toContain('packages/editor/packages/play-runtime');
    expect(manifest.workspaces).toContain('packages/editor/packages/engine/packages/*');
    expect(manifest.workspaces).not.toContain('packages/editor/packages/interface');
    expect(manifest.workspaces).not.toContain('packages/editor/packages/platform-io');
    expect(manifest.workspaces).toContain('packages/recursive-input-contract');
    expect(manifest.dependencies).toEqual({
      '@forgeax/editor': 'workspace:*',
    });
    expect(manifest.workspaces.every((workspace) => !workspace.startsWith('../'))).toBe(true);
    expect(manifest.overrides).toEqual({
      existing: '1.0.0',
      '@happy-dom/global-registrator': '20.11.0',
      'happy-dom': '20.11.0',
      '@forgeax/app-shell': 'workspace:*',
      '@forgeax/extension-platform': 'workspace:*',
      'npm-run-path': '6.0.0',
    });
  });
});


test('preserves Server dependency patches at both integration install roots', () => {
  const { root, workspaceDir } = fixture();
  writeFileSync(join(root, 'packages/server/package.json'), JSON.stringify({ patchedDependencies: { 'runtime@1': 'patches/runtime.patch' } }));
  const manifest = JSON.parse(readFileSync(writeIdeIntegrationWorkspaceManifest(workspaceDir), 'utf8'));
  expect(manifest.patchedDependencies).toEqual({ 'runtime@1': '../../packages/server/patches/runtime.patch' });
  expect(createIdeIntegrationRootManifest({ patchedDependencies: { 'other@1': 'patches/other.patch' } }, root).patchedDependencies).toEqual({ 'other@1': 'patches/other.patch', 'runtime@1': 'packages/server/patches/runtime.patch' });
});
