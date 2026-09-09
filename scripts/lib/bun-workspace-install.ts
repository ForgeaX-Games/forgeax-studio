import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ensureWorkspacePackageLink, type WorkspacePackageLinkResult } from './workspace-package-link.ts';

export interface PreparedWorkspaceLink {
  linkPath: string;
  nodeModulesPath: string;
  packageName: string;
  result: WorkspacePackageLinkResult;
  targetPath: string;
}

export interface RepairedWindowsDirectoryAlias {
  linkPath: string;
  rawTarget: string;
}

export function bunWorkspaceInstallArgs(
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args = ['install', '--ignore-scripts'];
  if (platform === 'win32') {
    // Bun's isolated linker creates workspace symlinks. Fresh Windows machines
    // commonly cannot create those links without Developer Mode or elevation.
    // Hoisted installs plus copyfile keep registry packages link-free; workspace
    // packages are pre-created as directory junctions below.
    args.push('--linker', 'hoisted', '--backend', 'copyfile');
  }
  return args;
}

export function prepareWindowsWorkspaceJunctions(
  packageDir: string,
  platform: NodeJS.Platform = process.platform,
  bridgeWorkspaceNodeModules = true,
): PreparedWorkspaceLink[] {
  if (platform !== 'win32') return [];

  const manifest = readManifest(join(packageDir, 'package.json'));
  const workspacePatterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const prepared: PreparedWorkspaceLink[] = [];
  const installNodeModules = join(packageDir, 'node_modules');
  mkdirSync(installNodeModules, { recursive: true });

  for (const targetPath of expandWorkspaceDirectories(packageDir, workspacePatterns)) {
    const targetManifestPath = join(targetPath, 'package.json');
    if (!existsSync(targetManifestPath)) continue;

    const targetManifest = readManifest(targetManifestPath);
    if (typeof targetManifest.name !== 'string' || targetManifest.name.length === 0) continue;

    const linkPath = join(packageDir, 'node_modules', ...targetManifest.name.split('/'));
    mkdirSync(dirname(linkPath), { recursive: true });
    const result = ensureWorkspacePackageLink(linkPath, targetPath, targetPath, true);
    if (result === 'occupied') {
      throw new Error(
        `cannot prepare Windows workspace junction for ${targetManifest.name}: ${linkPath} is occupied`,
      );
    }

    // The workspace root is a sibling package rather than a common ancestor of
    // its members. With a hoisted install, imports originating in that sibling
    // cannot walk up to the generated install root's node_modules. Point each member's
    // generated node_modules directory back at the hoisted install root.
    const nodeModulesPath = join(targetPath, 'node_modules');
    if (bridgeWorkspaceNodeModules) {
      ensureDirectoryJunction(nodeModulesPath, installNodeModules);
    }
    prepared.push({ linkPath, nodeModulesPath, packageName: targetManifest.name, result, targetPath });
  }

  return prepared;
}

export function removeWindowsWorkspaceNodeModulesBridges(
  packageDir: string,
  prepared: readonly PreparedWorkspaceLink[],
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform !== 'win32') return 0;
  const installNodeModules = join(packageDir, 'node_modules');
  if (!existsSync(installNodeModules)) return 0;
  const installTarget = realpathSync(installNodeModules);
  let removed = 0;

  for (const nodeModulesPath of new Set(prepared.map((entry) => entry.nodeModulesPath))) {
    try {
      const stat = lstatSync(nodeModulesPath);
      if (!stat.isSymbolicLink() || realpathSync(nodeModulesPath) !== installTarget) continue;
      unlinkSync(nodeModulesPath);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/**
 * pnpm uses relative directory symlinks inside package-local node_modules.
 * When the package itself is reached through an outer Windows junction, those
 * links are resolved against the alias path and may open the wrong package.
 * Replace only those relative directory links with absolute junctions while
 * preserving the package's own third-party dependency graph.
 */
export function repairWindowsNestedDirectoryLinks(
  packagesRoot: string,
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform !== 'win32' || !existsSync(packagesRoot)) return 0;
  let repaired = 0;

  const repair = (linkPath: string): void => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(linkPath);
    } catch {
      return;
    }
    if (!stat.isSymbolicLink()) return;
    const rawTarget = readlinkSync(linkPath);
    if (isAbsolute(rawTarget)) return;
    const targetPath = realpathSync(linkPath);
    if (!statSync(targetPath).isDirectory()) return;
    unlinkSync(linkPath);
    symlinkSync(targetPath, linkPath, 'junction');
    repaired++;
  };

  for (const packageEntry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue;
    const nodeModules = join(packagesRoot, packageEntry.name, 'node_modules');
    if (!existsSync(nodeModules)) continue;
    for (const dependency of readdirSync(nodeModules, { withFileTypes: true })) {
      const dependencyPath = join(nodeModules, dependency.name);
      if (dependency.isSymbolicLink()) {
        repair(dependencyPath);
      } else if (dependency.isDirectory() && dependency.name.startsWith('@')) {
        for (const scopedDependency of readdirSync(dependencyPath, { withFileTypes: true })) {
          if (scopedDependency.isSymbolicLink()) {
            repair(join(dependencyPath, scopedDependency.name));
          }
        }
      }
    }
  }
  return repaired;
}

/**
 * Temporarily materialize Git's plain-text representation of a directory
 * symlink as a Windows junction. Git writes the link target as a normal file
 * when core.symlinks=false; consumers such as Bun need an actual directory.
 */
export function repairWindowsDirectoryAlias(
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
): RepairedWindowsDirectoryAlias | null {
  if (platform !== 'win32') return null;

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;

  const rawTarget = readFileSync(linkPath, 'utf8').trim();
  if (rawTarget.length === 0 || rawTarget.includes('\n')) return null;
  const targetPath = resolve(dirname(linkPath), rawTarget);
  try {
    if (!statSync(targetPath).isDirectory()) return null;
  } catch {
    return null;
  }

  unlinkSync(linkPath);
  symlinkSync(targetPath, linkPath, 'junction');
  return { linkPath, rawTarget };
}

/** Restore Git's checkout representation so setup does not dirty a submodule. */
export function restoreWindowsDirectoryAlias(
  repaired: RepairedWindowsDirectoryAlias | null,
): void {
  if (!repaired) return;
  try {
    const stat = lstatSync(repaired.linkPath);
    if (stat.isSymbolicLink()) unlinkSync(repaired.linkPath);
    else rmSync(repaired.linkPath, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(repaired.linkPath, repaired.rawTarget);
}

function expandWorkspaceDirectories(packageDir: string, workspaces: string[]): string[] {
  const directories: string[] = [];
  for (const workspace of workspaces) {
    if (!workspace.includes('*')) {
      directories.push(resolve(packageDir, workspace));
      continue;
    }

    // Bun workspace manifests in Studio use directory-star patterns only.
    // Expand them before install so every workspace package can be represented
    // by a Windows junction without requiring symlink privileges.
    if (!workspace.endsWith('/*') || workspace.slice(0, -2).includes('*')) continue;
    const parent = resolve(packageDir, workspace.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(parent, entry.name));
    }
  }
  return [...new Set(directories)];
}

function ensureDirectoryJunction(linkPath: string, targetPath: string): void {
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      try {
        if (realpathSync(linkPath) === realpathSync(targetPath)) return;
      } catch {
        // A dangling or unreadable junction is replaced below.
      }
      unlinkSync(linkPath);
    } else {
      // node_modules is generated state. A previous isolated install may have
      // left a real directory here; replace it with the shared hoisted root.
      rmSync(linkPath, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(resolve(targetPath), linkPath, 'junction');
}

function readManifest(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid package manifest: ${path}`);
  }
  return parsed as Record<string, unknown>;
}
