#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  publishConfig?: { registry?: string };
  dependencies?: Record<string, string>;
};
const registry = packageJson.publishConfig?.registry ?? 'https://registry.npmjs.org/';
const runtimeVersion = packageJson.dependencies?.['@forgeax/game-runtime'];

function run(command: string, args: string[], options: { capture?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_registry: registry,
      NPM_CONFIG_REGISTRY: registry,
    },
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}`);
  }
  return options.capture ? result.stdout : '';
}

if (!runtimeVersion) {
  throw new Error('package.json does not pin @forgeax/game-runtime');
}

const whoami = spawnSync('npm', ['whoami', '--registry', registry], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (whoami.status !== 0) {
  throw new Error(`npm authentication is required. Run: npm login --registry ${registry}`);
}

const runtime = spawnSync('npm', [
  'view',
  `@forgeax/game-runtime@${runtimeVersion}`,
  'version',
  '--registry',
  registry,
], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (runtime.status !== 0 || runtime.stdout.trim() !== runtimeVersion) {
  throw new Error(
    `@forgeax/game-runtime@${runtimeVersion} is not published on ${registry}; publish the Runtime train first`,
  );
}

const existing = spawnSync('npm', [
  'view',
  `${packageJson.name}@${packageJson.version}`,
  'version',
  '--registry',
  registry,
], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (existing.status === 0 && existing.stdout.trim() === packageJson.version) {
  throw new Error(`${packageJson.name}@${packageJson.version} is already published`);
}

run('bun', ['run', 'build']);
const candidateDirectory = mkdtempSync(join(root, '.npm-candidate-'));
try {
  const packed = JSON.parse(run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    candidateDirectory,
  ], { capture: true })) as Array<{ filename: string }>;
  const tarball = join(candidateDirectory, packed[0]!.filename);
  run('bun', ['scripts/check-package-artifact.ts', tarball]);
  run('bun', ['scripts/accept-packed-consumer.ts', tarball]);
  run('npm', ['publish', tarball, '--access', 'public', '--ignore-scripts']);
} finally {
  rmSync(candidateDirectory, { recursive: true, force: true });
}
