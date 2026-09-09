#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALL_ENGINE_PACKAGES_FILTER, buildEngineDeclarations } from './ci/build-engine-packages';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TREE_BUILD_OUTPUT = new Set(['node_modules', '.git', 'target']);
const NON_AUTHORING_SOURCE = new Set([
  ...TREE_BUILD_OUTPUT,
  '__tests__',
  '__fixtures__',
  '__snapshots__',
  'test',
  'tests',
  'fixture',
  'fixtures',
  'snapshot',
  'snapshots',
]);

function copyTree(source: string, destination: string, excluded: ReadonlySet<string> = TREE_BUILD_OUTPUT): void {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, excluded);
    else cpSync(from, to);
  }
}

interface EnginePackageMetadata {
  readonly name?: string;
  readonly exports?: unknown;
  readonly types?: unknown;
}

export interface BuildRuntimeSdkOptions {
  readonly root?: string;
  readonly output?: string;
  readonly buildDeclarations?: (engineRoot: string) => void;
}

function declarationEntries(metadata: EnginePackageMetadata): string[] {
  const entries = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && value.endsWith('.d.ts')) {
      entries.add(value.replace(/^\.\/+/, ''));
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) visit(child);
    }
  };
  visit(metadata.types);
  visit(metadata.exports);
  return [...entries].sort();
}

function packageHasPublicDeclarations(packageRoot: string, metadata: EnginePackageMetadata): boolean {
  const entries = declarationEntries(metadata);
  return entries.length > 0 && entries.every((entry) => existsSync(join(packageRoot, entry)));
}

/**
 * Copy only the public declaration entry closure.
 *
 * Engine dist trees also contain declarations emitted for tests and internal build
 * fixtures. They are not package API and can be much larger than the public surface.
 * Public barrels, however, re-export relative declarations transitively; every one of
 * those referenced files must travel with the entry or TypeScript sees a broken API.
 */
function copyPublicDeclarationClosure(
  source: string,
  destination: string,
  metadata: EnginePackageMetadata,
): number {
  const queue = declarationEntries(metadata);
  const seen = new Set(queue);
  const resolveDeclaration = (fromRelative: string, specifier: string): string | undefined => {
    const base = join(dirname(fromRelative), specifier);
    const withoutJs = base.replace(/\.[cm]?js$/, '');
    for (const candidate of [
      `${withoutJs}.d.ts`,
      join(withoutJs, 'index.d.ts'),
      `${base}.d.ts`,
      join(base, 'index.d.ts'),
      base,
    ]) {
      const normalized = candidate.replace(/^\.\/+/, '');
      if (normalized.endsWith('.d.ts') && existsSync(join(source, normalized))) return normalized;
    }
    return undefined;
  };
  const enqueueSpecifier = (fromRelative: string, specifier: string): void => {
    if (!specifier.startsWith('.')) return;
    const resolved = resolveDeclaration(fromRelative, specifier);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    queue.push(resolved);
  };

  let copied = 0;
  while (queue.length > 0) {
    const fromRelative = queue.shift()!;
    const from = join(source, fromRelative);
    if (!existsSync(from)) {
      throw new Error(`Public declaration entry is missing: ${from}`);
    }
    const to = join(destination, fromRelative);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    copied += 1;

    const text = readFileSync(from, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      enqueueSpecifier(fromRelative, match[1]!);
    }
    for (const match of text.matchAll(/<reference\s+path=['"](\.[^'"]+)['"]/g)) {
      enqueueSpecifier(fromRelative, match[1]!);
    }
  }
  return copied;
}

function enginePackages(engineRoot: string): Array<{ root: string; directory: string; metadata: EnginePackageMetadata }> {
  return readdirSync(join(engineRoot, 'packages'), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const packageRoot = join(engineRoot, 'packages', entry.name);
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) return [];
    const metadata = JSON.parse(readFileSync(manifestPath, 'utf8')) as EnginePackageMetadata;
    return metadata.name?.startsWith('@forgeax/engine-')
      ? [{ root: packageRoot, directory: entry.name, metadata }]
      : [];
  });
}

function buildMissingDeclarations(engineRoot: string): void {
  if (!buildEngineDeclarations({
    engineRoot,
    filters: [ALL_ENGINE_PACKAGES_FILTER],
    env: process.env,
  })) {
    throw new Error('Engine package declaration build failed');
  }
}

function topLevelDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function assertExactList(label: string, declared: readonly string[], actual: readonly string[]): void {
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new Error(`${label} metadata does not match generated snapshot: declared=${JSON.stringify(declared)} actual=${JSON.stringify(actual)}`);
  }
}

function snapshotPackages(
  output: string,
  entries: ReturnType<typeof enginePackages>,
): { packages: string[]; packageDirectories: string[]; packageDirectoryByName: ReadonlyMap<string, string> } {
  const packages: string[] = [];
  const packageDirectories: string[] = [];
  const packageDirectoryByName = new Map<string, string>();
  for (const { root: packageRoot, directory, metadata } of entries) {
    const destination = join(output, 'packages', directory);
    mkdirSync(destination, { recursive: true });
    cpSync(join(packageRoot, 'package.json'), join(destination, 'package.json'));
    if (copyPublicDeclarationClosure(packageRoot, destination, metadata) === 0) {
      throw new Error(`Engine package has no public declaration closure: ${metadata.name}`);
    }
    packages.push(metadata.name!);
    packageDirectories.push(directory);
    packageDirectoryByName.set(metadata.name!, directory);
  }
  return {
    packages: packages.sort(),
    packageDirectories: packageDirectories.sort(),
    packageDirectoryByName,
  };
}

function snapshotTemplates(engineRoot: string, output: string): string[] {
  const templates: string[] = [];
  const templatesRoot = join(engineRoot, 'templates');
  if (existsSync(templatesRoot)) {
    for (const entry of readdirSync(templatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      copyTree(join(templatesRoot, entry.name), join(output, 'templates', entry.name));
      templates.push(entry.name);
    }
  }
  for (const required of ['game-default', 'game-empty']) {
    if (!templates.includes(required)) throw new Error(`no ${required} template found under ${templatesRoot}`);
  }
  return templates.sort();
}

function snapshotSkills(engineRoot: string, output: string): string[] {
  const skills: string[] = [];
  const skillsRoot = join(engineRoot, 'skills');
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory()
        || !entry.name.startsWith('forgeax-engine-')
        || !existsSync(join(skillsRoot, entry.name, 'SKILL.md'))
      ) continue;
      copyTree(join(skillsRoot, entry.name), join(output, 'skills', entry.name));
      skills.push(entry.name);
    }
  }
  if (skills.length === 0) throw new Error(`no Engine authoring skills found under ${skillsRoot}`);
  return skills.sort();
}

function snapshotSource(engineRoot: string, output: string): string[] {
  const sourcePackages: string[] = [];
  for (const entry of readdirSync(join(engineRoot, 'packages'), { withFileTypes: true })) {
    const source = join(engineRoot, 'packages', entry.name, 'src');
    if (!entry.isDirectory() || !existsSync(source)) continue;
    copyTree(source, join(output, 'source', entry.name, 'src'), NON_AUTHORING_SOURCE);
    sourcePackages.push(entry.name);
  }
  return sourcePackages.sort();
}

function validateGeneratedVersion(output: string, version: {
  packageCount: number;
  packages: string[];
  packageDirectories: string[];
  templates: string[];
  skills: string[];
  sourcePackages: string[];
}): void {
  if (version.packageCount !== version.packages.length) {
    throw new Error(`Engine package count mismatch: ${version.packageCount} != ${version.packages.length}`);
  }
  const directories = topLevelDirectories(join(output, 'packages'));
  const names = directories.map((directory) => {
    const manifest = JSON.parse(readFileSync(join(output, 'packages', directory, 'package.json'), 'utf8')) as {
      name?: string;
    };
    if (!manifest.name) throw new Error(`Generated Engine package has no name: ${directory}`);
    return manifest.name;
  }).sort();
  assertExactList('packages', version.packages, names);
  assertExactList('package directories', version.packageDirectories, directories);
  assertExactList('templates', version.templates, topLevelDirectories(join(output, 'templates')));
  assertExactList('skills', version.skills, topLevelDirectories(join(output, 'skills')));
  assertExactList('source packages', version.sourcePackages, topLevelDirectories(join(output, 'source')));
}

export function buildGameRuntimeSdk(options: BuildRuntimeSdkOptions = {}): string {
  const root = resolve(options.root ?? repositoryRoot);
  const engineRoot = join(root, 'packages', 'editor', 'packages', 'engine');
  const output = resolve(options.output ?? join(root, 'packages', 'game-runtime', 'common', 'assets', 'engine-sdk'));
  if (!existsSync(join(engineRoot, 'packages'))) throw new Error(`Engine checkout is missing: ${engineRoot}`);
  const enginePackageEntries = enginePackages(engineRoot);
  if (enginePackageEntries.some(({ root: packageRoot, metadata }) => !packageHasPublicDeclarations(packageRoot, metadata))) {
    (options.buildDeclarations ?? buildMissingDeclarations)(engineRoot);
  }
  const missing = enginePackageEntries
    .filter(({ root: packageRoot, metadata }) => !packageHasPublicDeclarations(packageRoot, metadata))
    .map(({ metadata }) => metadata.name ?? '<unnamed>');
  if (missing.length > 0) {
    throw new Error(`Engine declaration build left packages without declarations: ${missing.join(', ')}`);
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, 'packages'), { recursive: true });
  const { packages, packageDirectories, packageDirectoryByName } = snapshotPackages(output, enginePackageEntries);
  const templates = snapshotTemplates(engineRoot, output);
  const skills = snapshotSkills(engineRoot, output);
  const sourcePackages = snapshotSource(engineRoot, output);

  const git = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const engineCommit = git.status === 0 ? git.stdout.trim() : 'unknown';
  const engineVersion = {
    engineCommit,
    packageCount: packages.length,
    packages,
    packageDirectories,
    templates,
    skills,
    sourcePackages,
  };
  writeFileSync(join(output, 'engine-version.json'), `${JSON.stringify(engineVersion, null, 2)}\n`);
  const generatedVersion = JSON.parse(readFileSync(join(output, 'engine-version.json'), 'utf8')) as typeof engineVersion;
  validateGeneratedVersion(output, generatedVersion);
  writeFileSync(join(output, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      baseUrl: '.',
      paths: Object.fromEntries(packages.flatMap((name) => {
        const directory = packageDirectoryByName.get(name);
        if (!directory) throw new Error(`Engine package directory mapping is missing: ${name}`);
        return [[name, [`packages/${directory}/dist/index.d.ts`]], [`${name}/*`, [`packages/${directory}/dist/*`]]];
      })),
    },
    include: ['templates/**/*.ts'],
  }, null, 2)}\n`);
  writeFileSync(join(output, 'README.md'), `# ForgeaX Engine SDK snapshot\n\nEngine commit: ${engineCommit}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Engine SDK snapshot: ${buildGameRuntimeSdk()}`);
}
