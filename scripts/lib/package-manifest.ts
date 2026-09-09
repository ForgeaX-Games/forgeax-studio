import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export type PackageMirror = {
  name: string;
  url: string;
};

export type PackageEntry = {
  path: string;
  url: string;
  branch: string;
  optional?: boolean;
  skipEnv?: string;
  sparse?: string[];
  links?: Record<string, string>;
  mirrors?: PackageMirror[];
};

export type PackagesLocalConfig = {
  replace?: PackageEntry[];
  assign?: PackageEntry[];
  [key: string]: unknown;
};

export type PackagesLocalInput = PackageEntry[] | PackagesLocalConfig | null | undefined;

export type PackageFiles = {
  base: PackageEntry[];
  local: PackagesLocalInput;
  basePath: string;
  localPath: string;
};

function safeRelativePath(value: unknown, label: string, scope = 'project'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const path = value.trim();
  const segments = path.split(/[\\/]+/);
  if (
    path.startsWith('/')
    || path.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(path)
    || segments.includes('..')
    || segments.includes('')
  ) {
    throw new Error(`${label} must be a safe ${scope}-relative path: ${value}`);
  }
  return path;
}

function validateEntry(value: unknown): PackageEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('.packages entries must be objects.');
  }
  const entry = { ...(value as Record<string, unknown>) };
  const path = safeRelativePath(entry.path, '.packages entry path');
  if (typeof entry.url !== 'string' || entry.url.trim() === '') {
    throw new Error(`.packages entry ${path} is missing url.`);
  }
  if (typeof entry.branch !== 'string' || entry.branch.trim() === '') {
    throw new Error(`.packages entry ${path} is missing branch.`);
  }
  if (entry.optional !== undefined && typeof entry.optional !== 'boolean') {
    throw new Error(`.packages entry ${path}.optional must be boolean.`);
  }
  if (entry.skipEnv !== undefined && (typeof entry.skipEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(entry.skipEnv))) {
    throw new Error(`.packages entry ${path}.skipEnv must be an uppercase environment variable name.`);
  }
  if (entry.sparse !== undefined) {
    if (!Array.isArray(entry.sparse) || entry.sparse.length === 0) {
      throw new Error(`.packages entry ${path}.sparse must be a non-empty array.`);
    }
    entry.sparse = entry.sparse.map((item) => safeRelativePath(item, `${path}.sparse item`).replaceAll('\\', '/'));
  }
  if (entry.links !== undefined) {
    if (!entry.links || typeof entry.links !== 'object' || Array.isArray(entry.links)) {
      throw new Error(`.packages entry ${path}.links must be an object.`);
    }
    const links: Record<string, string> = {};
    for (const [source, target] of Object.entries(entry.links)) {
      links[safeRelativePath(source, `${path}.links source`, 'package').replaceAll('\\', '/')] = safeRelativePath(target, `${path}.links target`);
    }
    entry.links = links;
  }
  if (entry.mirrors !== undefined) {
    if (!Array.isArray(entry.mirrors)) throw new Error(`.packages entry ${path}.mirrors must be an array.`);
    entry.mirrors = entry.mirrors.map((mirror) => {
      if (!mirror || typeof mirror !== 'object' || Array.isArray(mirror)) {
        throw new Error(`.packages entry ${path}.mirrors entries must be objects.`);
      }
      const candidate = mirror as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(candidate.name)) {
        throw new Error(`.packages entry ${path}.mirror name is invalid.`);
      }
      if (typeof candidate.url !== 'string' || candidate.url.trim() === '') {
        throw new Error(`.packages entry ${path}.mirror url is missing.`);
      }
      return { name: candidate.name, url: candidate.url };
    });
  }
  return {
    ...entry,
    path,
    url: entry.url.trim(),
    branch: entry.branch.trim(),
  } as PackageEntry;
}

function normalizeEntries(input: unknown, label = '.packages'): PackageEntry[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be a JSON array.`);
  const order: string[] = [];
  const byPath = new Map<string, PackageEntry>();
  for (const raw of input) {
    const entry = validateEntry(raw);
    if (!byPath.has(entry.path)) order.push(entry.path);
    byPath.set(entry.path, entry);
  }
  return order.map((path) => byPath.get(path)!);
}

function mergeByPath(base: PackageEntry[], assign: PackageEntry[]): PackageEntry[] {
  const order = base.map((entry) => entry.path);
  const byPath = new Map(base.map((entry) => [entry.path, entry]));
  for (const entry of assign) {
    if (!byPath.has(entry.path)) order.push(entry.path);
    byPath.set(entry.path, entry);
  }
  return order.map((path) => byPath.get(path)!);
}

function normalizeLocal(local: PackagesLocalInput): PackagesLocalConfig {
  if (local == null) return {};
  if (Array.isArray(local)) return { assign: normalizeEntries(local, '.packages.local') };
  if (typeof local !== 'object') throw new Error('.packages.local must be a JSON array or object.');
  if (Object.prototype.hasOwnProperty.call(local, 'append')) {
    throw new Error('.packages.local uses deprecated "append"; rename it to "assign".');
  }
  return local;
}

export function resolvePackageConfig(base: unknown, local: PackagesLocalInput): PackageEntry[] {
  const normalizedBase = normalizeEntries(base);
  const config = normalizeLocal(local);
  const effective = config.replace === undefined
    ? normalizedBase
    : normalizeEntries(config.replace, '.packages.local.replace');
  const assign = config.assign === undefined
    ? []
    : normalizeEntries(config.assign, '.packages.local.assign');
  return mergeByPath(effective, assign);
}

export function focusPackagePaths(local: PackagesLocalInput): string[] {
  if (local == null) throw new Error('--focus requires .packages.local.');
  const config = normalizeLocal(local);
  const entries = [
    ...(config.replace === undefined ? [] : normalizeEntries(config.replace, '.packages.local.replace')),
    ...(config.assign === undefined ? [] : normalizeEntries(config.assign, '.packages.local.assign')),
  ];
  const paths = [...new Set(entries.map((entry) => entry.path))];
  if (paths.length === 0) throw new Error('.packages.local focus scope is empty.');
  return paths;
}

export function selectPackageEntries(entries: PackageEntry[], selectors: string[] = []): PackageEntry[] {
  if (selectors.length === 0) return entries;
  const wanted = selectors.map((selector) => selector.trim()).filter(Boolean);
  const selected = entries.filter((entry) => wanted.includes(entry.path) || wanted.includes(basename(entry.path)));
  const matched = new Set(selected.flatMap((entry) => [entry.path, basename(entry.path)]));
  const missing = wanted.filter((selector) => !matched.has(selector));
  if (missing.length > 0) throw new Error(`Package selector(s) missing from .packages: ${missing.join(', ')}`);
  return selected;
}

export function validateBranchName(value: unknown): string {
  const branch = String(value ?? '').trim();
  if (
    !branch
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.includes('..')
    || branch.includes('@{')
    || /[\s~^:?*[\\]/.test(branch)
    || branch.endsWith('.lock')
  ) throw new Error(`Invalid branch name: ${value}`);
  return branch;
}

export function buildPackagesLocalConfig(
  entries: PackageEntry[],
  options: { branch: string; selectors?: string[] },
): PackagesLocalConfig {
  const branch = validateBranchName(options.branch);
  return {
    assign: selectPackageEntries(resolvePackageConfig(entries, null), options.selectors).map((entry) => ({ ...entry, branch })),
  };
}

export function mergePackagesLocalConfig(
  existing: PackagesLocalInput,
  entries: PackageEntry[],
  options: { branch: string; selectors?: string[] },
): PackagesLocalConfig | PackageEntry[] {
  const next = buildPackagesLocalConfig(entries, options).assign ?? [];
  if (existing == null) return { assign: next };
  if (Array.isArray(existing)) return mergeByPath(normalizeEntries(existing, '.packages.local'), next);
  const config = normalizeLocal(existing);
  const current = config.assign === undefined ? [] : normalizeEntries(config.assign, '.packages.local.assign');
  return { ...config, assign: mergeByPath(current, next) };
}

export function readPackageFiles(
  root: string,
  paths: { basePath?: string; localPath?: string } = {},
): PackageFiles {
  const basePath = paths.basePath ? resolve(root, paths.basePath) : resolve(root, '.packages');
  const localPath = paths.localPath ? resolve(root, paths.localPath) : resolve(root, '.packages.local');
  if (!existsSync(basePath)) throw new Error(`.packages not found: ${basePath}`);
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as unknown;
  const local = existsSync(localPath)
    ? JSON.parse(readFileSync(localPath, 'utf8')) as PackagesLocalInput
    : null;
  return { base: normalizeEntries(base), local, basePath, localPath };
}
