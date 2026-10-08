import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ensureWorkspacePackageLink, type WorkspacePackageLinkResult } from './workspace-package-link.ts';

export const IDE_INTEGRATION_WORKSPACES = [
  '../../packages/ide',
  '../../packages/ide/packages/*',
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
] as const;

function ideDeclaredWorkspaces(root: string): string[] {
  const path = join(root, 'packages/ide/package.json');
  if (!existsSync(path)) return [];
  const workspaces = JSON.parse(readFileSync(path, 'utf8')).workspaces ?? [];
  return workspaces.map((workspace: string) => {
    if (typeof workspace !== 'string' || workspace.startsWith('/') || workspace.includes('..') || workspace.includes('\\')) {
      throw new Error('IDE workspace must stay inside its owning repository');
    }
    return `../../packages/ide/${workspace}`;
  });
}

const ROOT_ONLY_WORKSPACES = ['packages/recursive-input-contract'] as const;

function editorWorkspaces(root: string, prefix: string): string[] {
  const editorPackagesRoot = join(root, 'packages/editor/packages');
  if (!existsSync(editorPackagesRoot)) return [];

  return readdirSync(editorPackagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !['interface', 'platform-io'].includes(entry.name))
    .map((entry) => ({
      path: join(editorPackagesRoot, entry.name),
      workspace: `${prefix}/${entry.name}`,
    }))
    .filter(({ path }) => existsSync(join(path, 'package.json')))
    .map(({ workspace }) => workspace)
    .sort();
}

export function ideIntegrationWorkspaces(root: string): string[] {
  return [...new Set([
    ...IDE_INTEGRATION_WORKSPACES.slice(0, 2),
    ...ideDeclaredWorkspaces(root),
    ...editorWorkspaces(root, '../../packages/editor/packages'),
    '../../packages/editor/packages/engine/packages/*',
    ...IDE_INTEGRATION_WORKSPACES.slice(2),
    ...ROOT_ONLY_WORKSPACES.map((workspace) => `../../${workspace}`),
  ])];
}

export function ideIntegrationRootWorkspaces(root: string): string[] {
  return [...new Set([
    ...ideIntegrationWorkspaces(root).map((workspace) => {
      if (!workspace.startsWith('../../')) {
        throw new Error(`IDE integration workspace must be rooted from .forgeax/ide-source-workspace: ${workspace}`);
      }
      return workspace.slice('../../'.length);
    }),
    ...ROOT_ONLY_WORKSPACES,
  ])];
}

// Keep fresh integration installs deterministic while upstream publishes the
// global registrator and its happy-dom runtime as separate artifacts.
export const IDE_INTEGRATION_OVERRIDES = {
  '@happy-dom/global-registrator': '20.11.0',
  'happy-dom': '20.11.0',
  // Keep all consumers on the same candidate AppShell source and contracts.
  '@forgeax/app-shell': 'workspace:*',
  '@forgeax/extension-platform': 'workspace:*',
  'npm-run-path': '6.0.0',
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
  const results = IDE_INTEGRATION_PACKAGE_LINKS.map(({ consumer, name, source }) => {
    const linkPath = join(root, consumer, 'node_modules', ...name.split('/'));
    mkdirSync(resolve(linkPath, '..'), { recursive: true });
    const result = ensureWorkspacePackageLink(linkPath, join(root, source), root, process.platform === 'win32');
    if (result === 'occupied') {
      throw new Error(`IDE integration package link is occupied: ${linkPath}`);
    }
    return result;
  });
  return [...results, ...ensureIdeIntegrationSourceOverrides(root)];
}

/** Bun leaves existing package directories in sibling workspaces untouched, even
 * with --force. Enforce workspace overrides at each consumer's resolution path. */
function ensureIdeIntegrationSourceOverrides(root: string): WorkspacePackageLinkResult[] {
  const members = [...new Set(ideIntegrationRootWorkspaces(root).flatMap((workspace) =>
    [...new Bun.Glob(`${workspace}/package.json`).scanSync({ cwd: root, absolute: true })],
  ))].map((path) => ({ path: dirname(path), manifest: JSON.parse(readFileSync(path, 'utf8')) }));
  const results: WorkspacePackageLinkResult[] = [];
  for (const [name, selector] of Object.entries(IDE_INTEGRATION_OVERRIDES)) {
    if (selector !== 'workspace:*') continue;
    const source = members.find(({ manifest }) => manifest.name === name);
    if (!source) throw new Error(`IDE integration override missing source package: ${name}`);
    for (const consumer of members) {
      if (!['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .some((field) => Object.hasOwn(consumer.manifest[field] ?? {}, name))) continue;
      const link = join(consumer.path, 'node_modules', name);
      const existing = lstatSync(link, { throwIfNoEntry: false });
      if (existing?.isSymbolicLink()) {
        try {
          if (realpathSync(link) === realpathSync(source.path)) { results.push('current'); continue; }
        } catch { /* Replace dangling links as well as links to another install graph. */ }
        unlinkSync(link);
      } else if (existing) {
        const backups = join(root, '.forgeax/ide-source-workspace/link-backups');
        mkdirSync(backups, { recursive: true });
        const backup = join(mkdtempSync(join(backups, 'package-')), 'original');
        renameSync(link, backup);
        console.log(`[ide-install] Preserved replaced dependency ${link} at ${backup}`);
      }
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(source.path, link, process.platform === 'win32' ? 'junction' : 'dir');
      results.push(existing ? 'relinked' : 'linked');
    }
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Root-pinned deps (DSH peers, engine browser runtime) must hoist into the IDE graph too. */
function ideIntegrationPinnedFields(rootManifest: Record<string, unknown>): Record<string, unknown> {
  // Studio-root patches such as Ink keep their original install scope. Server
  // dependency patches are rebased separately for this shared runtime graph.
  return { dependencies: { ...(isRecord(rootManifest.dependencies) ? rootManifest.dependencies : {}), ...IDE_INTEGRATION_DEPENDENCIES } };
}

// Published host declarations resolve React types from the install root. Keep the
// host's type universe explicit when iframe product workspaces use older React.
function ideIntegrationTypeDependencies(rootManifest: Record<string, unknown>, root: string): Record<string, unknown> {
  const path = join(root, 'packages/ide/package.json');
  const ide = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const types = Object.fromEntries(['@types/node', '@types/react', '@types/react-dom']
    .filter((id) => typeof ide.devDependencies?.[id] === 'string')
    .map((id) => [id, ide.devDependencies[id]]));
  return { devDependencies: { ...(isRecord(rootManifest.devDependencies) ? rootManifest.devDependencies : {}), ...types } };
}

function ideIntegrationOverrides(rootManifest: Record<string, unknown>): Record<string, string> {
  return {
    ...(isRecord(rootManifest.overrides) ? rootManifest.overrides as Record<string, string> : {}),
    ...IDE_INTEGRATION_OVERRIDES,
  };
}

// Server and Orchestrator share stateful runtime dependencies. Install them in
// one graph and preserve the Server package's required dependency patches.
function serverDependencyPatches(root: string, prefix: string): Record<string, string> {
  const path = join(root, 'packages/server/package.json');
  if (!existsSync(path)) return {};
  const patches = JSON.parse(readFileSync(path, 'utf8')).patchedDependencies ?? {};
  return Object.fromEntries(Object.entries(patches).map(([id, path]) => [id, `${prefix}packages/server/${path}`]));
}

export function createIdeIntegrationWorkspaceManifest(
  rootManifest: Record<string, unknown>,
  root: string,
): Record<string, unknown> {
  return {
    name: '@forgeax/ide-source-workspace',
    private: true,
    ...(Object.keys(serverDependencyPatches(root, '../../')).length ? { patchedDependencies: serverDependencyPatches(root, '../../') } : {}),
    ...ideIntegrationPinnedFields(rootManifest),
    ...ideIntegrationTypeDependencies(rootManifest, root),
    workspaces: ideIntegrationWorkspaces(root),
    overrides: ideIntegrationOverrides(rootManifest),
  };
}

export function createIdeIntegrationRootManifest(
  rootManifest: Record<string, unknown>,
  root: string,
): Record<string, unknown> {
  return {
    ...rootManifest,
    ...ideIntegrationPinnedFields(rootManifest),
    patchedDependencies: { ...(isRecord(rootManifest.patchedDependencies) ? rootManifest.patchedDependencies : {}), ...serverDependencyPatches(root, '') },
    ...ideIntegrationTypeDependencies(rootManifest, root),
    workspaces: ideIntegrationRootWorkspaces(root),
    overrides: ideIntegrationOverrides(rootManifest),
  };
}

export function writeIdeIntegrationWorkspaceManifest(workspaceDir: string): string {
  const root = resolve(workspaceDir, '../..');
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const workspaces = ideIntegrationWorkspaces(root);
  for (const workspace of workspaces) {
    if (workspace.includes('*')) continue;
    const packageDir = resolve(workspaceDir, workspace);
    if (!existsSync(join(packageDir, 'package.json'))) {
      throw new Error(`IDE integration workspace missing package: ${packageDir}`);
    }
  }

  mkdirSync(workspaceDir, { recursive: true });
  const manifestPath = join(workspaceDir, 'package.json');
  writeFileSync(manifestPath, `${JSON.stringify(createIdeIntegrationWorkspaceManifest(rootManifest, root), null, 2)}\n`);
  return manifestPath;
}
