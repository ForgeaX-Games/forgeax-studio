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
const engineSdkVersion = packageJson.dependencies?.['@forgeax/engine-sdk'];

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

if (!engineSdkVersion) {
  throw new Error('package.json does not exact-pin @forgeax/engine-sdk');
}

const whoami = spawnSync('npm', ['whoami', '--registry', registry], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (whoami.status !== 0) {
  throw new Error(`npm authentication is required. Run: npm login --registry ${registry}`);
}

const engine = spawnSync('npm', [
  'view',
  `@forgeax/engine-sdk@${engineSdkVersion}`,
  'version',
  '--registry',
  registry,
], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (engine.status !== 0 || engine.stdout.trim() !== engineSdkVersion) {
  throw new Error(
    `@forgeax/engine-sdk@${engineSdkVersion} is not published on ${registry}; publish the approved Engine SDK release first`,
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
  const sdkZip = process.env.FORGEAX_ENGINE_SDK_ZIP;
  const sdkCarrier = process.env.FORGEAX_ENGINE_SDK_CARRIER;
  if (!sdkZip || !sdkCarrier) {
    throw new Error('FORGEAX_ENGINE_SDK_ZIP and FORGEAX_ENGINE_SDK_CARRIER must name the approved release artifacts');
  }
  run('bun', ['scripts/accept-packed-consumer.ts', tarball, '--sdk-zip', sdkZip, '--sdk-carrier', sdkCarrier]);
  run('npm', ['publish', tarball, '--access', 'public', '--ignore-scripts']);
} finally {
  rmSync(candidateDirectory, { recursive: true, force: true });
}
