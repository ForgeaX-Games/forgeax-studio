import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureWorkspacePackageLink, type WorkspacePackageLinkResult } from './workspace-package-link.ts';

export const IDE_INTEGRATION_WORKSPACES = [
  '../../packages/ide',
  '../../packages/ide/packages/*',
  '../../packages/cli',
  '../../packages/editor',
  '../../packages/editor/packages/content-browser',
  '../../packages/editor/packages/core',
  '../../packages/editor/packages/edit-runtime',
  '../../packages/editor/packages/file-preview',
  '../../packages/editor/packages/game-plugins',
  '../../packages/editor/packages/panels',
  '../../packages/platform-io',
  '../../packages/editor/packages/play-runtime',
  '../../packages/editor/packages/product',
  '../../packages/editor/packages/ui',
  '../../packages/editor/packages/engine/packages/*',
  '../../packages/interface',
  '../../packages/interface/packages/design',
  '../../packages/chat',
  '../../packages/dashboard',
  '../../packages/settings',
] as const;

const ROOT_ONLY_WORKSPACES = ['packages/recursive-input-contract'] as const;

export const IDE_INTEGRATION_ROOT_WORKSPACES = [...IDE_INTEGRATION_WORKSPACES.map((workspace) => {
  if (!workspace.startsWith('../../')) {
    throw new Error(`IDE integration workspace must be rooted from .forgeax/ide-source-workspace: ${workspace}`);
  }
  return workspace.slice('../../'.length);
}), ...ROOT_ONLY_WORKSPACES];

// Keep fresh integration installs deterministic while upstream publishes the
// global registrator and its happy-dom runtime as separate artifacts.
export const IDE_INTEGRATION_OVERRIDES = {
  '@happy-dom/global-registrator': '20.11.0',
  'happy-dom': '20.11.0',
} as const;

export const IDE_INTEGRATION_DEPENDENCIES = {
  '@forgeax/editor': 'workspace:*',
} as const;

const IDE_INTEGRATION_PACKAGE_LINKS = [
  { consumer: 'packages/ide', name: '@forgeax/editor', source: 'packages/editor' },
  { consumer: 'packages/ide', name: '@forgeax/editor-content-browser', source: 'packages/editor/packages/content-browser' },
  { consumer: 'packages/ide', name: '@forgeax/editor-core', source: 'packages/editor/packages/core' },
  { consumer: 'packages/ide', name: '@forgeax/editor-edit-runtime', source: 'packages/editor/packages/edit-runtime' },
  { consumer: 'packages/ide', name: '@forgeax/editor-file-preview', source: 'packages/editor/packages/file-preview' },
  { consumer: 'packages/ide', name: '@forgeax/editor-game-plugins', source: 'packages/editor/packages/game-plugins' },
  { consumer: 'packages/ide', name: '@forgeax/editor-panels', source: 'packages/editor/packages/panels' },
  { consumer: 'packages/ide', name: '@forgeax/editor-play-runtime', source: 'packages/editor/packages/play-runtime' },
  { consumer: 'packages/ide', name: '@forgeax/editor-product', source: 'packages/editor/packages/product' },
  { consumer: 'packages/ide', name: '@forgeax/editor-ui', source: 'packages/editor/packages/ui' },
  { consumer: 'packages/ide', name: '@forgeax/platform-io', source: 'packages/platform-io' },
] as const;

export function ensureIdeIntegrationPackageLinks(root: string): WorkspacePackageLinkResult[] {
  return IDE_INTEGRATION_PACKAGE_LINKS.map(({ consumer, name, source }) => {
    const linkPath = join(root, consumer, 'node_modules', ...name.split('/'));
    mkdirSync(resolve(linkPath, '..'), { recursive: true });
    const result = ensureWorkspacePackageLink(linkPath, join(root, source), root, process.platform === 'win32');
    if (result === 'occupied') {
      throw new Error(`IDE integration package link is occupied: ${linkPath}`);
    }
    return result;
  });
}

export function createIdeIntegrationRootManifest(
  rootManifest: Record<string, unknown>,
): Record<string, unknown> {
  const existingOverrides = rootManifest.overrides;
  return {
    ...rootManifest,
    workspaces: IDE_INTEGRATION_ROOT_WORKSPACES,
    dependencies: {
      ...(rootManifest.dependencies && typeof rootManifest.dependencies === 'object' ? rootManifest.dependencies : {}),
      ...IDE_INTEGRATION_DEPENDENCIES,
    },
    overrides: {
      ...(existingOverrides && typeof existingOverrides === 'object' ? existingOverrides : {}),
      ...IDE_INTEGRATION_OVERRIDES,
    },
  };
}

export function writeIdeIntegrationWorkspaceManifest(workspaceDir: string): string {
  for (const workspace of IDE_INTEGRATION_WORKSPACES) {
    if (workspace.includes('*')) continue;
    const packageDir = resolve(workspaceDir, workspace);
    if (!existsSync(join(packageDir, 'package.json'))) {
      throw new Error(`IDE integration workspace missing package: ${packageDir}`);
    }
  }

  mkdirSync(workspaceDir, { recursive: true });
  const manifestPath = join(workspaceDir, 'package.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    name: '@forgeax/ide-source-workspace',
    private: true,
    workspaces: IDE_INTEGRATION_WORKSPACES,
    dependencies: IDE_INTEGRATION_DEPENDENCIES,
    overrides: IDE_INTEGRATION_OVERRIDES,
  }, null, 2)}\n`);
  return manifestPath;
}
