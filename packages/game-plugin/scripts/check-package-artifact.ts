#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
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

const entries = tar(['-tzf', tarball]).split(/\r?\n/).filter(Boolean);
for (const required of [
  'package/package.json',
  'package/dist/main.js',
  'package/assets/skills/forgeax-game/SKILL.md',
  'package/assets/skills/forgeax-game/references/engine-skills.md',
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
  dependencies?: Record<string, string>;
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
};
if (manifest.name !== repo.name || manifest.version !== repo.version) {
  throw new Error(
    `unexpected package identity: ${manifest.name}@${manifest.version} (repository declares ${repo.name}@${repo.version})`,
  );
}
if (JSON.stringify(manifest.dependencies) !== JSON.stringify(repo.dependencies)) {
  throw new Error('packed dependencies must equal the repository manifest exactly');
}
const runtimePin = manifest.dependencies?.['@forgeax/game-runtime'];
if (Object.keys(manifest.dependencies ?? {}).length !== 1 || !runtimePin || !/^\d+\.\d+\.\d+$/u.test(runtimePin)) {
  throw new Error('@forgeax/game must depend exactly on a pinned @forgeax/game-runtime version');
}
if (manifest.optionalDependencies || manifest.os || manifest.cpu) {
  throw new Error('@forgeax/game must remain platform-neutral and use a normal Universal dependency');
}
if (JSON.stringify(manifest.files) !== JSON.stringify(['dist', 'assets/skills', 'README.md'])) {
  throw new Error('@forgeax/game publish files are broader than the approved surface');
}

const bundle = tar(['-xOf', tarball, 'package/dist/main.js']);
if (!bundle.includes('@forgeax/game-runtime')) throw new Error('Game bundle does not retain its external Runtime import');
if (bundle.includes('FORGEAX_STUDIO_ROOT') || bundle.includes('FORGEAX_RUNTIME_DEV_FALLBACK')) {
  throw new Error('Game bundle retains a Studio checkout fallback');
}

console.log(`Package artifact gate passed: ${basename(tarball)} (thin Universal consumer)`);
