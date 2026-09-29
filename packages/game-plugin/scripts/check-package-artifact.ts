#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!tarball || !existsSync(tarball)) {
  throw new Error('usage: bun scripts/check-package-artifact.ts <path-to-npm-tarball>');
}

function tar(args: string[]): string {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`tar ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function tarBytes(member: string): Buffer {
  const result = spawnSync('tar', ['-xOf', tarball!, member], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) throw new Error(`cannot read packed ${member}`);
  return result.stdout;
}

const entries = tar(['-tzf', tarball]).split(/\r?\n/).filter(Boolean);
for (const required of [
  'package/package.json',
  'package/dist/main.js',
  'package/assets/skills/forgeax-game/SKILL.md',
  'package/assets/extensions/asset3d/extension.json',
  'package/assets/extensions/asset3d/cli.mjs',
  'package/assets/extensions/asset3d/skills/art-3d-asset-library/SKILL.md',
  'package/docs/asset3d.md',
  'package/docs/plugin-integration-standard.md',
  'package/docs/engine-0.2.1-to-0.3.3-migration.md',
  'package/assets/licenses/fflate.txt',
  'package/README.md',
]) {
  if (!entries.includes(required)) throw new Error(`package tarball is missing ${required}`);
}

for (const entry of entries) {
  const segments = entry.replaceAll('\\', '/').split('/');
  if (entry.startsWith('/') || segments.includes('..')) throw new Error(`unsafe archive path: ${entry}`);
  if (/^package\/(?:src|test|tests|scripts|node_modules)(?:\/|$)/u.test(entry)) {
    throw new Error(`development payload leaked into package: ${entry}`);
  }
  if (/^package\/assets\/(?:runtime|engine-sdk)(?:\/|$)/u.test(entry)) {
    throw new Error(`Runtime payload leaked into Game: ${entry}`);
  }
  if (/\.map$|(?:^|\/)bun\.lock$/u.test(entry)) throw new Error(`map or lockfile leaked into package: ${entry}`);
}

const manifest = JSON.parse(tar(['-xOf', tarball, 'package/package.json'])) as {
  name?: string;
  version?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  files?: string[];
};
// The repository manifest is the single source of truth for release identity;
// the workflow separately guarantees the tag equals its version.
const repo = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8')) as {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
if (manifest.name !== repo.name || manifest.version !== repo.version) {
  throw new Error(
    `unexpected package identity: ${manifest.name}@${manifest.version} (repository declares ${repo.name}@${repo.version})`,
  );
}
if (JSON.stringify(manifest.dependencies) !== JSON.stringify(repo.dependencies)) {
  throw new Error('packed dependencies must equal the repository manifest exactly');
}
if (JSON.stringify(manifest.bin) !== JSON.stringify({ 'forgeax-game': 'dist/main.js', game: 'dist/main.js' })) {
  throw new Error('packed bin aliases must expose forgeax-game and the scoped game entry');
}
if (JSON.stringify(manifest.peerDependencies) !== JSON.stringify(repo.peerDependencies)) {
  throw new Error('packed peer dependencies must equal the repository manifest exactly');
}
if (JSON.stringify(manifest.peerDependenciesMeta) !== JSON.stringify(repo.peerDependenciesMeta)) {
  throw new Error('packed peer dependency metadata must equal the repository manifest exactly');
}
const enginePin = manifest.peerDependencies?.['@forgeax/engine'];
if (
  JSON.stringify(manifest.dependencies) !==
    JSON.stringify({ '@forgeax/engine-sdk': '0.3.3', pnpm: '11.7.0' }) ||
  enginePin !== undefined ||
  manifest.peerDependenciesMeta !== undefined
) {
  throw new Error('@forgeax/game must exact-pin the approved SDK carrier and pnpm dependencies');
}
if (manifest.optionalDependencies || manifest.os || manifest.cpu) {
  throw new Error('@forgeax/game must remain platform-neutral and use a normal Universal dependency');
}
if (JSON.stringify(manifest.files) !== JSON.stringify(['dist', 'assets', 'docs/asset3d.md', 'docs/plugin-integration-standard.md', 'docs/engine-0.2.1-to-0.3.3-migration.md', 'README.md'])) {
  throw new Error('@forgeax/game publish files are broader than the approved surface');
}

if (entries.some(e => /assets\/extensions\/.*(legacy|\.tgz|\.tar\.gz|\.DS_Store)/.test(e))) {
  throw new Error('Asset3D legacy payload leaked into package');
}
const bundle = tar(['-xOf', tarball, 'package/dist/main.js']);
for (const forbidden of ['@forgeax/game-runtime', 'static-preview', 'FORGEAX_START_COMMAND', 'FORGEAX_STUDIO_ROOT', 'FORGEAX_RUNTIME_DEV_FALLBACK', 'FBX2GLTF_BIN', 'asset3d mcp']) {
  if (bundle.includes(forbidden)) throw new Error(`Game bundle retains forbidden legacy path: ${forbidden}`);
}
if (!bundle.includes('4ad48ef03d8f8f1bb74f5bf7cde71c4799d51060')) {
  throw new Error('Game bundle does not bind the approved Engine commit');
}

console.log(`Package artifact gate passed: ${basename(tarball)} (exact-Engine connector with Skill + HTTP CLI)`);
