import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';

export interface ActiveServerRole {
  packageDir: string;
  entry: string;
  packageName: string;
  priority: number;
}

export interface ResolveServerRoleOptions {
  root: string;
  profile?: string;
}

export interface ServerRuntimeInvocation {
  entryPath: string;
  orphanSignature: string;
}

/** Minimal persisted shape consumed by lifecycle state without importing it. */
export interface PersistedServerRoleIdentity {
  readonly packageDir: string;
  readonly entry: string;
}

const BASE_ENTRY = 'src/main.ts';
const BASE_PRIORITY = 0;

export function resolveActiveServerRole({
  root,
  profile = 'auto',
}: ResolveServerRoleOptions): ActiveServerRole {
  const normalizedProfile = profile.trim() || 'auto';
  if (normalizedProfile !== 'auto' && normalizedProfile !== 'base') {
    throw new Error(`Unsupported FORGEAX_SERVER_PROFILE: ${profile}`);
  }

  const packagesDir = join(resolve(root), 'packages');
  const packagesRealDir = realpathSync(packagesDir);
  const base = readRolePackage(
    join(packagesDir, 'server'),
    BASE_ENTRY,
    BASE_PRIORITY,
    'base server',
    packagesRealDir,
  );
  if (normalizedProfile === 'base') return base;

  const overrides: ActiveServerRole[] = [];
  for (const item of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    const packageDir = join(packagesDir, item.name);
    validatePackageDir(packageDir, packagesRealDir, `package ${item.name}`);
    const packageJsonPath = join(packageDir, 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = readPackageJson(packageJsonPath);
    if (!Object.hasOwn(packageJson, 'forgeaxStudio')) continue;
    const metadata = packageJson.forgeaxStudio;
    if (!isRecord(metadata)) {
      throw new Error(`Malformed forgeaxStudio metadata in ${packageJsonPath}: expected an object`);
    }
    if (metadata.runtimeRole !== 'server') continue;
    if (typeof metadata.entry !== 'string' || metadata.entry.length === 0) {
      throw new Error(`Malformed server role metadata in ${packageJsonPath}: entry must be a string`);
    }
    if (typeof metadata.priority !== 'number' || !Number.isFinite(metadata.priority)) {
      throw new Error(`Malformed server role metadata in ${packageJsonPath}: priority must be a finite number`);
    }
    overrides.push(
      readRolePackage(
        packageDir,
        metadata.entry,
        metadata.priority,
        `server role in ${packageJsonPath}`,
        packagesRealDir,
      ),
    );
  }

  if (overrides.length === 0) return base;
  const highestPriority = Math.max(...overrides.map(({ priority }) => priority));
  const winners = overrides.filter(({ priority }) => priority === highestPriority);
  if (winners.length !== 1) {
    throw new Error(
      `Multiple server role packages have highest priority ${highestPriority}: ${winners
        .map(({ packageName }) => packageName)
        .join(', ')}`,
    );
  }
  return winners[0] as ActiveServerRole;
}

/**
 * Accept only a real server role that this checkout itself declares. Runtime
 * state is not authority to turn an arbitrary package source file into
 * a stop target: base is fixed, while overrides must exactly match their
 * forgeaxStudio metadata and pass the same containment checks as launch.
 */
export function isDeclaredServerRole(
  root: string,
  identity: PersistedServerRoleIdentity,
): boolean {
  try {
    const packagesDir = join(resolve(root), 'packages');
    const packagesRealDir = realpathSync(packagesDir);
    validateEntry(identity.entry, 'persisted server role');
    const packageDir = resolve(identity.packageDir);
    const packageRealDir = realpathSync(packageDir);
    // Resolve the lexical parent separately: a package symlink must not become
    // a valid identity merely because its target happens to be under packages.
    const canonicalPackagePath = join(realpathSync(dirname(packageDir)), basename(packageDir));
    if (packageRealDir !== canonicalPackagePath || dirname(packageRealDir) !== packagesRealDir) return false;

    if (packageRealDir === join(packagesRealDir, 'server')) {
      return identity.entry === BASE_ENTRY
        && readRolePackage(packageRealDir, BASE_ENTRY, BASE_PRIORITY, 'persisted base server', packagesRealDir).entry === BASE_ENTRY;
    }

    const packageJsonPath = join(packageRealDir, 'package.json');
    const packageJson = readPackageJson(packageJsonPath);
    const metadata = packageJson.forgeaxStudio;
    if (!isRecord(metadata) || metadata.runtimeRole !== 'server'
      || metadata.entry !== identity.entry
      || typeof metadata.priority !== 'number' || !Number.isFinite(metadata.priority)) return false;
    return readRolePackage(
      packageRealDir,
      identity.entry,
      metadata.priority,
      `persisted server role in ${packageJsonPath}`,
      packagesRealDir,
    ).entry === identity.entry;
  } catch {
    return false;
  }
}

function readRolePackage(
  packageDir: string,
  entry: string,
  priority: number,
  context: string,
  packagesRealDir: string,
): ActiveServerRole {
  if (!existsSync(packageDir) || !statSync(packageDir).isDirectory()) {
    throw new Error(`${context} package directory does not exist: ${packageDir}`);
  }
  const packageRealDir = validatePackageDir(packageDir, packagesRealDir, context);
  validateEntry(entry, context);
  const entryPath = join(packageDir, entry);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    throw new Error(`${context} entry does not exist or is not a file: ${entryPath}`);
  }
  const entryRealPath = realpathSync(entryPath);
  if (!isPathContained(packageRealDir, entryRealPath)) {
    throw new Error(`${context} entry resolves outside its package: ${entryPath}`);
  }

  const packageJsonPath = join(packageDir, 'package.json');
  const packageJson = readPackageJson(packageJsonPath);
  if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
    throw new Error(`${context} package.json must declare a package name: ${packageJsonPath}`);
  }
  return { packageDir, entry, packageName: packageJson.name, priority };
}

export function serverRuntimeInvocation(role: ActiveServerRole): ServerRuntimeInvocation {
  const entryPath = resolve(role.packageDir, role.entry);
  return { entryPath, orphanSignature: escapeRegex(entryPath) };
}

export function serverOrphanNeedles(root: string, role: ActiveServerRole): string[] {
  return [resolve(root, 'scripts/run.ts'), serverRuntimeInvocation(role).entryPath];
}

export function matchesServerOrphanCommand(commandLine: string, needles: readonly string[]): boolean {
  return needles.some((needle) => needle.length > 0 && commandLine.includes(needle));
}

export function desktopServerEntryAdapter(entry: string): string | null {
  validateEntry(entry, 'desktop server role');
  if (entry === BASE_ENTRY) return null;
  const importPath = `./${posix.relative('src', entry)}`;
  return `await import(${JSON.stringify(importPath)});\n`;
}

function validateEntry(entry: string, context: string): void {
  const segments = entry.split('/');
  if (
    isAbsolute(entry) ||
    win32.isAbsolute(entry) ||
    entry.includes('\\') ||
    posix.normalize(entry) !== entry ||
    segments.includes('..') ||
    entry === '.'
  ) {
    throw new Error(`${context} entry must be a canonical package-relative path: ${entry}`);
  }
  if (segments.length < 2 || segments[0] !== 'src') {
    throw new Error(`${context} entry must be located under src/: ${entry}`);
  }
}

function validatePackageDir(packageDir: string, packagesRealDir: string, context: string): string {
  let packageRealDir: string;
  try {
    packageRealDir = realpathSync(packageDir);
  } catch {
    throw new Error(`${context} package directory does not exist: ${packageDir}`);
  }
  if (!isPathContained(packagesRealDir, packageRealDir)) {
    throw new Error(`${context} package resolves outside the packages directory: ${packageDir}`);
  }
  return packageRealDir;
}

export function isPathContained(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== '' &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${posix.sep}`) &&
    !pathFromParent.startsWith(`..${win32.sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readPackageJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) throw new Error(`Package manifest does not exist: ${file}`);
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error('expected an object');
    return parsed;
  } catch (error) {
    throw new Error(`Invalid package manifest ${file}: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
