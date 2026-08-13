#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildGameRuntimeSdk } from './build-game-runtime-sdk';
import {
  assembleRuntimeResources,
  assertNativeRuntimeTarget,
  runtimeArtifactName,
  runtimePackageRoot,
  runtimeTarget,
  type RuntimeTarget,
} from './lib/runtime-resource-assembler';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command: string, args: string[], cwd = repositoryRoot, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`command failed: ${command} ${args.join(' ')}`);
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

/**
 * Runtime archives are compared across PR and main builds. Normalize the
 * staging tree before archiving so checkout/build wall-clock times cannot
 * change the package bytes. The explicit sorted file list keeps the contract
 * portable across the low-frequency macOS/Windows native builds as well.
 */
function normalizeArchiveTree(root: string): void {
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o755);
      for (const entry of readdirSync(path)) {
        const childRelativePath = relativePath ? `${relativePath}/${entry}` : entry;
        visit(join(path, entry), childRelativePath);
      }
      utimesSync(path, 0, 0);
      return;
    }
    if (!stat.isSymbolicLink()) {
      chmodSync(path, relativePath.startsWith('bin/') ? 0o755 : 0o644);
      utimesSync(path, 0, 0);
    }
  };
  visit(root, '');
}

function archiveEntries(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const path = join(directory, name);
      entries.push(relative);
      if (lstatSync(path).isDirectory()) visit(path, relative);
    }
  };
  visit(root, '');
  return entries;
}

function createRuntimeArchive(archive: string, staging: string, root: string): void {
  normalizeArchiveTree(staging);
  const listPath = join(dirname(staging), 'runtime-archive-inputs.txt');
  const rawTarPath = join(dirname(staging), 'runtime-archive-inputs.tar');
  writeFileSync(listPath, archiveEntries(staging).map((entry) => `${entry}\0`).join(''));
  try {
    run('tar', [
      '--no-recursion',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-cf',
      rawTarPath,
      '-C',
      staging,
      '--null',
      '-T',
      listPath,
    ], root);
    // Keep the gzip header timestamp-free. `tar -czf` delegates compression
    // to the host gzip and therefore embeds wall-clock metadata on some
    // runners even when the tar members themselves are normalized.
    writeFileSync(archive, gzipSync(readFileSync(rawTarPath)));
  } finally {
    rmSync(listPath, { force: true });
    rmSync(rawTarPath, { force: true });
  }
}

export function platformEntrySource(): string {
  return `import { createRuntimeDistribution } from '@forgeax/game-runtime-common';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commonEntry = createRequire(import.meta.url).resolve('@forgeax/game-runtime-common');
const commonRoot = resolve(dirname(commonEntry), '..');

export const runtimeDistribution = createRuntimeDistribution({ platformRoot: packageRoot, commonRoot });
export const ensureRuntime = runtimeDistribution.ensureRuntime;
export const resolveInstalledRuntime = runtimeDistribution.resolveInstalledRuntime;
export const runtimeCacheRoot = runtimeDistribution.runtimeCacheRoot;
export const launcherForRuntime = runtimeDistribution.launcherForRuntime;
export const runtimeEnvironment = runtimeDistribution.runtimeEnvironment;
export const allocatePort = runtimeDistribution.allocatePort;
export const allocateRuntimePorts = runtimeDistribution.allocateRuntimePorts;
export const loadRuntimeManifest = runtimeDistribution.loadRuntimeManifest;
export const engineSdkRoot = runtimeDistribution.engineSdkRoot;
export const installEngineSdk = runtimeDistribution.installEngineSdk;
export default runtimeDistribution;
`;
}

export function platformDeclarationSource(): string {
  return `import type { GameRuntimeDistribution } from '@forgeax/game-runtime-common';
export type * from '@forgeax/game-runtime-common';
export declare const runtimeDistribution: GameRuntimeDistribution;
export declare const ensureRuntime: GameRuntimeDistribution['ensureRuntime'];
export declare const resolveInstalledRuntime: GameRuntimeDistribution['resolveInstalledRuntime'];
export declare const runtimeCacheRoot: GameRuntimeDistribution['runtimeCacheRoot'];
export declare const launcherForRuntime: GameRuntimeDistribution['launcherForRuntime'];
export declare const runtimeEnvironment: GameRuntimeDistribution['runtimeEnvironment'];
export declare const allocatePort: GameRuntimeDistribution['allocatePort'];
export declare const allocateRuntimePorts: GameRuntimeDistribution['allocateRuntimePorts'];
export declare const loadRuntimeManifest: GameRuntimeDistribution['loadRuntimeManifest'];
export declare const engineSdkRoot: GameRuntimeDistribution['engineSdkRoot'];
export declare const installEngineSdk: GameRuntimeDistribution['installEngineSdk'];
export default runtimeDistribution;
`;
}

export function writePlatformEntry(packageRoot: string): void {
  const dist = join(packageRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), platformEntrySource());
  writeFileSync(join(dist, 'index.d.ts'), platformDeclarationSource());
}

function injectRuntimeIdentity(resourceRoot: string, version: string, engineCommit: string): void {
  const config = join(resourceRoot, 'engine', 'vite.config.ts');
  const source = readFileSync(config, 'utf8');
  const marker = '          instanceRootAbs,\n';
  if (!source.includes(marker)) throw new Error(`bundled Engine health route has no identity marker: ${config}`);
  writeFileSync(config, source.replace(
    marker,
    `${marker}          runtimeVersion: ${JSON.stringify(version)},\n          engineVersion: ${JSON.stringify(engineCommit)},\n`,
  ));
}

export interface BuildRuntimeTargetOptions {
  readonly target: RuntimeTarget;
  readonly root?: string;
  readonly resourceRoot?: string;
  readonly sidecarPath?: string;
  readonly version?: string;
  readonly fromResources?: boolean;
  readonly skipInstall?: boolean;
  readonly skipFrontend?: boolean;
  readonly skipSdk?: boolean;
}

export function buildRuntimeTarget(options: BuildRuntimeTargetOptions): { archive: string; manifest: string; packageRoot: string } {
  assertNativeRuntimeTarget(options.target);
  const root = resolve(options.root ?? repositoryRoot);
  const packageRoot = runtimePackageRoot(root, options.target);
  const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  const version = options.version ?? packageManifest.version;
  if (version !== packageManifest.version) throw new Error(`Runtime version ${version} does not match ${packageManifest.version}`);

  if (!options.skipSdk) buildGameRuntimeSdk({ root });
  if (!options.fromResources) {
    const args = ['scripts/build-desktop.ts', '--triple', options.target.triple];
    if (options.skipInstall) args.push('--skip-install');
    if (options.skipFrontend) args.push('--skip-frontend');
    run(process.execPath, args, root, {
      ...process.env,
      FORGEAX_PLUGIN_RUNTIME: '1',
      FORGEAX_RUNTIME_PACKAGE_VERSION: version,
    });
  }

  const resourceRoot = resolve(options.resourceRoot ?? join(root, 'packages', 'interface', 'src-tauri', 'resources'));
  const sidecarPath = resolve(options.sidecarPath ?? join(root, 'packages', 'interface', 'src-tauri', 'binaries', options.target.sidecar));
  if (!existsSync(sidecarPath)) throw new Error(`Runtime sidecar is missing: ${sidecarPath}`);
  const stagingParent = mkdtempSync(join(tmpdir(), `forgeax-runtime-${options.target.id}-`));
  const staging = join(stagingParent, 'resources');
  try {
    assembleRuntimeResources({ sourceRoot: resourceRoot, destinationRoot: staging });
    mkdirSync(join(staging, 'bin'), { recursive: true });
    copyFileSync(sidecarPath, join(staging, 'bin', options.target.sidecar));

    const sdkVersionPath = join(root, 'packages', 'game-runtime', 'common', 'assets', 'engine-sdk', 'engine-version.json');
    let engineCommit = existsSync(sdkVersionPath)
      ? (JSON.parse(readFileSync(sdkVersionPath, 'utf8')) as { engineCommit?: string }).engineCommit ?? 'unknown'
      : 'unknown';
    if (engineCommit === 'unknown') {
      const engineRoot = join(root, 'packages', 'editor', 'packages', 'engine');
      const git = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (git.status === 0) engineCommit = git.stdout.trim();
    }
    injectRuntimeIdentity(staging, version, engineCommit);

    const assetDirectory = join(packageRoot, 'assets', 'runtime', options.target.id);
    rmSync(join(packageRoot, 'assets'), { recursive: true, force: true });
    rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });
    mkdirSync(assetDirectory, { recursive: true });
    const archive = join(assetDirectory, runtimeArtifactName(options.target));
    createRuntimeArchive(archive, staging, root);
    const digest = sha256File(archive);
    const manifest = join(packageRoot, 'assets', 'runtime-manifest.json');
    writeFileSync(manifest, `${JSON.stringify({
      schemaVersion: 1,
      runtimeId: 'forgeax-game-runtime',
      artifacts: [{
        version,
        platform: options.target.platform,
        arch: options.target.arch,
        source: `./runtime/${options.target.id}/${basename(archive)}`,
        sha256: digest,
        format: 'archive',
        command: `bin/${options.target.sidecar}`,
        args: ['runtime/local-runtime.mjs', '--profile', 'desktop-prod'],
      }],
    }, null, 2)}\n`);
    writePlatformEntry(packageRoot);
    return { archive, manifest, packageRoot };
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = runtimeTarget(option('--target') ?? '');
  const result = buildRuntimeTarget({
    target,
    version: option('--version'),
    resourceRoot: option('--resource-root'),
    sidecarPath: option('--sidecar'),
    fromResources: process.argv.includes('--from-resources'),
    skipInstall: process.argv.includes('--skip-install'),
    skipFrontend: process.argv.includes('--skip-frontend'),
    skipSdk: process.argv.includes('--skip-sdk'),
  });
  console.log(`Runtime package: ${result.packageRoot}`);
  console.log(`Runtime archive: ${result.archive}`);
  console.log(`Runtime manifest: ${result.manifest}`);
}
