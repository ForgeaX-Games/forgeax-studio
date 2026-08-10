#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!tarball || !existsSync(tarball)) {
  throw new Error('usage: bun scripts/check-package-artifact.ts <path-to-npm-tarball>');
}

const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error(`cannot list package tarball: ${listed.stderr}`);
const entries = new Set(listed.stdout.split(/\r?\n/).filter(Boolean));
const required = [
  'package/assets/runtime-manifest.json',
  'package/assets/engine-sdk/engine-version.json',
  'package/assets/engine-sdk/README.md',
  'package/assets/engine-sdk/examples/game-default/main.ts',
  'package/assets/skills/forgeax-game/SKILL.md',
];
for (const entry of required) {
  if (!entries.has(entry)) throw new Error(`package tarball is missing ${entry}`);
}

/**
 * A Runtime the plugin cannot teach a model to target is not shippable, so the
 * knowledge ladder is gated by shape rather than by an enumerated skill list.
 */
const bundledEngineSkills = new Set(
  [...entries]
    .map((entry) => /^package\/assets\/engine-sdk\/skills\/([^/]+)\/SKILL\.md$/.exec(entry)?.[1])
    .filter((id): id is string => Boolean(id)),
);
if (bundledEngineSkills.size === 0) {
  throw new Error('package tarball carries no Engine authoring skills under assets/engine-sdk/skills');
}
const sourceTrees = new Set(
  [...entries]
    .map((entry) => /^package\/assets\/engine-sdk\/source\/([^/]+)\/src\//.exec(entry)?.[1])
    .filter((id): id is string => Boolean(id)),
);
if (sourceTrees.size === 0) {
  throw new Error('package tarball is missing the Engine source escalation tree (assets/engine-sdk/source)');
}

const declaredSkills = new Set(
  (JSON.parse(readFileSync(join(packageRoot, 'assets/engine-sdk/engine-version.json'), 'utf8')) as {
    skills?: string[];
  }).skills ?? [],
);
for (const id of declaredSkills) {
  if (!bundledEngineSkills.has(id)) {
    throw new Error(`engine-version.json declares Engine skill ${id} but the tarball does not carry it`);
  }
}

const manifestPath = join(packageRoot, 'assets/runtime-manifest.json');
if (!existsSync(manifestPath)) throw new Error(`missing local manifest: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  artifacts?: Array<{ source?: string; sha256?: string; format?: string }>;
};
const artifact = manifest.artifacts?.[0];
if (!artifact?.source || artifact.format !== 'archive' || !artifact.sha256) {
  throw new Error('runtime manifest does not describe a verified archive artifact');
}
const archivePath = join(packageRoot, 'assets', artifact.source.replace(/^\.\/assets\//, '').replace(/^\.\//, ''));
if (!existsSync(archivePath)) throw new Error(`manifest artifact is missing: ${archivePath}`);
const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
if (digest !== artifact.sha256.toLowerCase()) {
  throw new Error(`manifest checksum mismatch for ${basename(archivePath)}: ${digest}`);
}
if (statSync(archivePath).size === 0) throw new Error('runtime archive is empty');
console.log(
  `Package artifact gate passed: ${tarball} (${bundledEngineSkills.size} Engine skills, ${sourceTrees.size} source trees)`,
);
