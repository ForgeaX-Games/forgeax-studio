import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface LocalPackageLink {
  readonly producerPath: string;
  readonly producerRevision: string;
  readonly linkedAt: string;
}

export interface LocalPackageLinkState {
  readonly schemaVersion: 1;
  readonly links: Record<string, LocalPackageLink>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateLocalPackageLinkState(value: unknown): LocalPackageLinkState {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.links)) {
    throw new Error('invalid local package link state');
  }
  for (const [name, link] of Object.entries(value.links)) {
    if (!name.startsWith('@') || !isObject(link)
      || typeof link.producerPath !== 'string' || !link.producerPath
      || typeof link.producerRevision !== 'string' || !/^[a-f0-9]{40}$/u.test(link.producerRevision)
      || typeof link.linkedAt !== 'string' || Number.isNaN(Date.parse(link.linkedAt))) {
      throw new Error(`invalid local package link record: ${name}`);
    }
  }
  return value as unknown as LocalPackageLinkState;
}

export function activeLocalPackageLinks(value: unknown): string[] {
  return Object.keys(validateLocalPackageLinkState(value).links).sort();
}

export function localPackageLinkCiError(value: unknown): string | undefined {
  try {
    const links = activeLocalPackageLinks(value);
    return links.length > 0 ? `active local package links are forbidden in CI: ${links.join(', ')}` : undefined;
  } catch (error) {
    return `local package link state is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function localPackageLinkCiErrorFromRoot(root: string): string | undefined {
  try {
    return localPackageLinkCiError(readLocalPackageLinkState(root));
  } catch (error) {
    return `local package link state is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export const EMPTY_LOCAL_PACKAGE_LINK_STATE: LocalPackageLinkState = { schemaVersion: 1, links: {} };

export type LocalPackageLinkRunner = (command: string, args: string[], cwd: string) => string;

function defaultRunner(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  }
  return result.stdout.trim();
}

export function localPackageLinkStatePath(root: string): string {
  return join(root, '.forgeax', 'local-package-links.json');
}

export function readLocalPackageLinkState(root: string): LocalPackageLinkState {
  const path = localPackageLinkStatePath(root);
  if (!existsSync(path)) return EMPTY_LOCAL_PACKAGE_LINK_STATE;
  return validateLocalPackageLinkState(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function writeLocalPackageLinkState(root: string, state: LocalPackageLinkState): void {
  const path = localPackageLinkStatePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function protectedFiles(root: string): Map<string, string | undefined> {
  return new Map(['package.json', 'bun.lock'].map((name) => {
    const path = join(root, name);
    return [path, existsSync(path) ? readFileSync(path, 'utf8') : undefined];
  }));
}

function assertProtectedFilesUnchanged(before: Map<string, string | undefined>): void {
  for (const [path, content] of before) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current !== content) throw new Error(`local package linking changed protected dependency state: ${path}`);
  }
}

export function linkLocalPackage(options: {
  readonly root: string;
  readonly packageName: string;
  readonly producerPath: string;
  readonly run?: LocalPackageLinkRunner;
  readonly now?: () => string;
}): LocalPackageLinkState {
  const root = resolve(options.root);
  const producerPath = resolve(options.producerPath);
  const producerManifest = JSON.parse(readFileSync(join(producerPath, 'package.json'), 'utf8')) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  if (producerManifest.name !== options.packageName) {
    throw new Error(`producer declares ${producerManifest.name ?? '<no name>'}, expected ${options.packageName}`);
  }
  if (!producerManifest.scripts?.build) throw new Error(`producer ${options.packageName} has no build command`);
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies'].some((field) => rootManifest[field]?.[options.packageName]);
  if (!declared) throw new Error(`${options.packageName} is not declared by the consumer`);

  const before = protectedFiles(root);
  const run = options.run ?? defaultRunner;
  run('bun', ['run', 'build'], producerPath);
  run('bun', ['link'], producerPath);
  run('bun', ['link', options.packageName], root);
  const producerRevision = run('git', ['rev-parse', 'HEAD'], producerPath);
  if (!/^[a-f0-9]{40}$/u.test(producerRevision)) throw new Error('producer HEAD is not a full commit SHA');
  assertProtectedFilesUnchanged(before);

  const current = readLocalPackageLinkState(root);
  const state: LocalPackageLinkState = {
    schemaVersion: 1,
    links: {
      ...current.links,
      [options.packageName]: {
        producerPath,
        producerRevision,
        linkedAt: (options.now ?? (() => new Date().toISOString()))(),
      },
    },
  };
  writeLocalPackageLinkState(root, state);
  return state;
}

export function unlinkLocalPackage(options: {
  readonly root: string;
  readonly packageName: string;
  readonly run?: LocalPackageLinkRunner;
}): LocalPackageLinkState {
  const root = resolve(options.root);
  const before = protectedFiles(root);
  const run = options.run ?? defaultRunner;
  run('bun', ['unlink', options.packageName], root);
  run('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], root);
  assertProtectedFilesUnchanged(before);
  const current = readLocalPackageLinkState(root);
  const links = { ...current.links };
  delete links[options.packageName];
  const state: LocalPackageLinkState = { schemaVersion: 1, links };
  writeLocalPackageLinkState(root, state);
  return state;
}
