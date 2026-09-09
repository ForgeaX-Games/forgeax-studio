#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewBuildEnvironment } from './preview-build-context';
import {
  PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION,
  previewPayloadDigest,
  readPreviewManifest,
  validatePreviewPack,
  validatePreviewOutput,
} from './preview-contract';

const HASH_SCHEMA_VERSION = 2;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.forgeax', 'dist', 'node_modules']);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`missing required option ${name}`);
  return value;
}

function absoluteOption(name: string): string {
  const value = resolve(requiredOption(name));
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
}

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name))) return [];
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function buildHash(gameRoot: string, gameId: string, runtimeVersion: string, engineCommit: string): string {
  const files = filesUnder(gameRoot)
    .map((path) => ({ path: relative(gameRoot, path).split(sep).join('/'), sha256: sha256File(path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) throw new Error(`game has no build inputs: ${gameRoot}`);
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: HASH_SCHEMA_VERSION,
    gameId,
    runtimeVersion,
    engineCommit,
    files,
  })).digest('hex');
}

function gameEntry(gameRoot: string): string {
  const explicit = option('--entry');
  const candidates = explicit
    ? [resolve(gameRoot, explicit)]
    : [join(gameRoot, 'src', 'main.ts'), join(gameRoot, 'main.ts')];
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (!entry) throw new Error(`game entry is missing (expected src/main.ts or main.ts): ${gameRoot}`);
  return entry;
}

const runtimeRoot = resolve(import.meta.dir, '..');
const engineRoot = join(runtimeRoot, 'engine');
const projectRoot = absoluteOption('--project-root');
const gameRoot = absoluteOption('--game-root');
const gameId = option('--game-id')?.trim() || basename(gameRoot);
const runtimeVersion = requiredOption('--runtime-version');
const engineCommit = requiredOption('--engine-commit');
const cacheRoot = resolve(option('--cache-root')?.trim() || join(projectRoot, '.forgeax', 'cache', 'preview'));

if (!existsSync(join(engineRoot, 'vite.config.ts'))) throw new Error(`Runtime Engine build host is missing: ${engineRoot}`);
if (!existsSync(gameRoot) || !statSync(gameRoot).isDirectory()) throw new Error(`game root is missing: ${gameRoot}`);

const hash = buildHash(gameRoot, gameId, runtimeVersion, engineCommit);
const outputRoot = join(cacheRoot, hash);
const manifestPath = join(outputRoot, 'preview-manifest.json');
if (existsSync(manifestPath)) {
  try {
    const manifest = readPreviewManifest(outputRoot);
    if (
      manifest.gameId !== gameId
      || manifest.buildHash !== hash
      || manifest.runtimeVersion !== runtimeVersion
      || manifest.engineCommit !== engineCommit
      || manifest.projectRoot !== projectRoot
      || manifest.gameRoot !== gameRoot
      || manifest.outputRoot !== outputRoot
    ) {
      throw new Error('preview cache identity does not match the requested build');
    }
    validatePreviewOutput(outputRoot, gameRoot);
    console.log(JSON.stringify({ reused: true, manifest }));
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`discarding invalid preview cache ${outputRoot}: ${message}`);
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

mkdirSync(cacheRoot, { recursive: true });
const temporaryOutput = `${outputRoot}.tmp-${process.pid}`;
rmSync(temporaryOutput, { recursive: true, force: true });

const environment = previewBuildEnvironment({
  gameRoot,
  gameId,
  gameEntry: gameEntry(gameRoot),
  projectRoot,
  outputRoot: temporaryOutput,
});
Object.assign(process.env, environment);

try {
  const viteEntry = join(engineRoot, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  if (!existsSync(viteEntry)) throw new Error(`Vite build API is missing from Runtime: ${viteEntry}`);
  const vite = await import(pathToFileURL(viteEntry).href) as {
    build(config: { root: string; configFile: string; mode: string; logLevel: string }): Promise<unknown>;
  };
  await vite.build({
    root: engineRoot,
    configFile: join(engineRoot, 'vite.config.ts'),
    mode: 'production',
    logLevel: 'info',
  });
  if (!existsSync(join(temporaryOutput, 'index.html'))) {
    throw new Error('preview build produced no index.html');
  }
  validatePreviewPack(temporaryOutput, gameRoot);
  const payloadDigest = previewPayloadDigest(temporaryOutput);
  rmSync(outputRoot, { recursive: true, force: true });
  renameSync(temporaryOutput, outputRoot);
  const manifest = {
    schemaVersion: PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION,
    gameId,
    buildHash: hash,
    runtimeVersion,
    engineCommit,
    projectRoot,
    gameRoot,
    outputRoot,
    payloadDigest,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ reused: false, manifest }));
} catch (error) {
  rmSync(temporaryOutput, { recursive: true, force: true });
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`game preview build failed: ${message}`, { cause: error });
}
