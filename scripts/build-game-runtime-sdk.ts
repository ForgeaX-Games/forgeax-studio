#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALL_ENGINE_PACKAGES_FILTER, buildEngineDeclarations } from './ci/build-engine-packages';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function copyTree(source: string, destination: string, excluded = new Set(['node_modules', '.git', 'target', 'test', 'tests', '__tests__', '__snapshots__'])): void {
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

function copyDeclarations(source: string, destination: string): number {
  let copied = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', 'target', 'test', 'tests', 'src'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.d.ts')) {
        const output = join(destination, relative(source, path));
        mkdirSync(dirname(output), { recursive: true });
        cpSync(path, output);
        copied += 1;
      }
    }
  };
  walk(source);
  return copied;
}

export interface BuildRuntimeSdkOptions {
  readonly root?: string;
  readonly output?: string;
  readonly buildDeclarations?: (engineRoot: string) => void;
}

function packageHasDeclarations(packageRoot: string): boolean {
  let found = false;
  const walk = (directory: string): void => {
    if (found) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', 'target', 'test', 'tests', 'src'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.d.ts')) {
        found = true;
        return;
      }
    }
  };
  walk(packageRoot);
  return found;
}

function enginePackageRoots(engineRoot: string): string[] {
  return readdirSync(join(engineRoot, 'packages'), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const packageRoot = join(engineRoot, 'packages', entry.name);
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
    return manifest.name?.startsWith('@forgeax/engine-') ? [packageRoot] : [];
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

export function buildGameRuntimeSdk(options: BuildRuntimeSdkOptions = {}): string {
  const root = resolve(options.root ?? repositoryRoot);
  const engineRoot = join(root, 'packages', 'editor', 'packages', 'engine');
  const output = resolve(options.output ?? join(root, 'packages', 'game-runtime', 'common', 'assets', 'engine-sdk'));
  if (!existsSync(join(engineRoot, 'packages'))) throw new Error(`Engine checkout is missing: ${engineRoot}`);
  const packageRoots = enginePackageRoots(engineRoot);
  if (packageRoots.some((packageRoot) => !packageHasDeclarations(packageRoot))) {
    (options.buildDeclarations ?? buildMissingDeclarations)(engineRoot);
  }
  const missing = packageRoots.filter((packageRoot) => !packageHasDeclarations(packageRoot));
  if (missing.length > 0) {
    throw new Error(`Engine declaration build left packages without declarations: ${missing.join(', ')}`);
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, 'packages'), { recursive: true });

  const packages: string[] = [];
  for (const entry of readdirSync(join(engineRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(engineRoot, 'packages', entry.name);
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
    if (!manifest.name?.startsWith('@forgeax/engine-')) continue;
    const destination = join(output, 'packages', entry.name);
    mkdirSync(destination, { recursive: true });
    cpSync(manifestPath, join(destination, 'package.json'));
    if (copyDeclarations(packageRoot, destination) === 0) {
      throw new Error(`Engine package has no built declarations: ${manifest.name}`);
    }
    packages.push(manifest.name);
  }

  copyTree(join(engineRoot, 'templates', 'game-default'), join(output, 'examples', 'game-default'));
  const skills: string[] = [];
  const skillsRoot = join(engineRoot, 'skills');
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(skillsRoot, entry.name, 'SKILL.md'))) continue;
      copyTree(join(skillsRoot, entry.name), join(output, 'skills', entry.name));
      skills.push(entry.name);
    }
  }
  if (skills.length === 0) throw new Error(`no Engine authoring skills found under ${skillsRoot}`);

  const sourcePackages: string[] = [];
  for (const entry of readdirSync(join(engineRoot, 'packages'), { withFileTypes: true })) {
    const source = join(engineRoot, 'packages', entry.name, 'src');
    if (!entry.isDirectory() || !existsSync(source)) continue;
    copyTree(source, join(output, 'source', entry.name, 'src'));
    sourcePackages.push(entry.name);
  }

  const git = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const engineCommit = git.status === 0 ? git.stdout.trim() : 'unknown';
  writeFileSync(join(output, 'engine-version.json'), `${JSON.stringify({
    engineCommit,
    packageCount: packages.length,
    packages: packages.sort(),
    skills: skills.sort(),
    sourcePackages: sourcePackages.sort(),
  }, null, 2)}\n`);
  writeFileSync(join(output, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      baseUrl: '.',
      paths: Object.fromEntries(packages.flatMap((name) => {
        const directory = name.slice('@forgeax/engine-'.length);
        return [[name, [`packages/${directory}/dist/index.d.ts`]], [`${name}/*`, [`packages/${directory}/dist/*`]]];
      })),
    },
    include: ['examples/**/*.ts'],
  }, null, 2)}\n`);
  writeFileSync(join(output, 'README.md'), `# ForgeaX Engine SDK snapshot\n\nEngine commit: ${engineCommit}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Engine SDK snapshot: ${buildGameRuntimeSdk()}`);
}
