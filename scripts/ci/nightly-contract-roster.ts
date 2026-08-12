#!/usr/bin/env bun
/**
 * Derive and execute the Studio nightly contract suite from package ownership.
 *
 * The root workspace list is the path authority. The root `forgeaxStudio.ci`
 * contract names the package owners by package name, and this module resolves
 * those names back to workspace paths. A missing workspace manifest or invalid
 * owner declaration is an admission error; the workflow must not silently skip
 * a moved package. Each owner runs its own `scripts.test` command.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface NightlyContractEntry {
  name: string;
  path: string;
  testScript: string;
}

interface PackageManifest {
  name?: unknown;
  scripts?: { test?: unknown };
}

interface NightlyContractOwner {
  package?: unknown;
}

interface RootManifest {
  workspaces?: unknown;
  forgeaxStudio?: {
    ci?: {
      nightlyContractOwners?: unknown;
    };
  };
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(
      `cannot read JSON manifest ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function assertWorkspacePath(root: string, workspacePath: string): void {
  const rootPath = resolve(root);
  const candidate = resolve(root, workspacePath);
  const escaped = relative(rootPath, candidate);
  if (
    isAbsolute(workspacePath) ||
    escaped === '..' ||
    escaped.startsWith(`..${sep}`) ||
    isAbsolute(escaped)
  ) {
    throw new Error(`workspace path must stay inside repository root: ${workspacePath}`);
  }
}

/** Expand the concrete and trailing-star workspace forms used by Studio. */
export function expandWorkspaceEntries(root: string, entries: unknown[]): string[] {
  const expanded: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error('package.json workspaces must contain non-empty strings');
    }

    if (!entry.includes('*')) {
      assertWorkspacePath(root, entry);
      expanded.push(entry);
      continue;
    }

    if (!entry.endsWith('/*') || entry.slice(0, -2).includes('*')) {
      throw new Error(`unsupported workspace glob: ${entry}`);
    }

    const parent = entry.slice(0, -2);
    assertWorkspacePath(root, parent);
    const parentPath = join(root, parent);
    if (!existsSync(parentPath)) {
      throw new Error(`workspace glob parent is missing: ${parent}`);
    }

    for (const child of readdirSync(parentPath, { withFileTypes: true })) {
      if (child.isDirectory()) expanded.push(join(parent, child.name));
    }
  }

  return [...new Set(expanded)];
}

export function deriveNightlyContractRoster(root = ROOT): NightlyContractEntry[] {
  const manifest = readJson<RootManifest>(join(root, 'package.json'));
  if (!Array.isArray(manifest.workspaces)) {
    throw new Error('root package.json must declare a workspaces array');
  }

  const packageByName = new Map<string, { path: string; manifest: PackageManifest }>();
  const missingWorkspacePaths: string[] = [];
  for (const packagePath of expandWorkspaceEntries(root, manifest.workspaces)) {
    const packageDir = join(root, packagePath);
    const manifestPath = join(packageDir, 'package.json');
    if (!existsSync(manifestPath)) {
      missingWorkspacePaths.push(packagePath);
      continue;
    }

    const packageManifest = readJson<PackageManifest>(manifestPath);
    if (typeof packageManifest.name !== 'string' || packageManifest.name.length === 0) {
      throw new Error(`workspace package is missing a package name: ${packagePath}`);
    }
    if (packageByName.has(packageManifest.name)) {
      throw new Error(`duplicate workspace package name: ${packageManifest.name}`);
    }
    packageByName.set(packageManifest.name, { path: packagePath, manifest: packageManifest });
  }

  const owners = manifest.forgeaxStudio?.ci?.nightlyContractOwners;
  if (
    !Array.isArray(owners) ||
    owners.length === 0 ||
    owners.some(
      (owner) =>
        typeof owner !== 'object' ||
        owner === null ||
        typeof (owner as NightlyContractOwner).package !== 'string',
    )
  ) {
    throw new Error('forgeaxStudio.ci.nightlyContractOwners must be a non-empty package-name array');
  }

  const seenOwners = new Set<string>();
  return owners.map((ownerValue) => {
    const owner = ownerValue as NightlyContractOwner;
    const name = owner.package as string;
    if (seenOwners.has(name)) throw new Error(`duplicate nightly contract owner: ${name}`);
    seenOwners.add(name);

    const resolved = packageByName.get(name);
    if (!resolved) {
      const missing = missingWorkspacePaths.length
        ? `; workspace package manifests missing for ${missingWorkspacePaths.join(', ')}`
        : '';
      throw new Error(`nightly contract owner is not a workspace package: ${name}${missing}`);
    }
    if (typeof resolved.manifest.scripts?.test !== 'string' || resolved.manifest.scripts.test.length === 0) {
      throw new Error(`nightly contract owner is missing scripts.test: ${name}`);
    }

    return {
      name,
      path: resolved.path,
      testScript: resolved.manifest.scripts.test,
    };
  });
}

function slugify(value: string): string {
  return value
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function runBun(
  args: string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(process.env.BUN_BIN ?? 'bun', args, {
    cwd,
    encoding: 'utf8',
    env,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(logPath, output);
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status ?? 'unknown'}): bun ${args.join(' ')}`);
  }
}

export function runNightlyContracts(root = ROOT): void {
  const roster = deriveNightlyContractRoster(root);
  const env = { ...process.env, FORGEAX_SKIP_PREPARE: '1' };

  console.log(`[nightly-contract] derived ${roster.length} owner packages`);
  for (const entry of roster) {
    console.log(`[nightly-contract] ${entry.name} -> ${entry.path}`);
    const slug = slugify(entry.name);
    runBun(['install'], join(root, entry.path), `/tmp/test-${slug}-install.log`, env);
    runBun(['run', 'test'], join(root, entry.path), `/tmp/test-${slug}.log`, env);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runNightlyContracts();
  } catch (error) {
    console.error(
      `[nightly-contract] admission/test failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}
