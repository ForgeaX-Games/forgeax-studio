#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function tarOwnershipArgs(): string[] {
  const help = spawnSync('tar', ['--help'], { encoding: 'utf8' });
  const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
  if (text.includes('--owner')) return ['--owner=0', '--group=0', '--numeric-owner'];
  if (text.includes('--uid') && text.includes('--gid')) return ['--uid=0', '--gid=0'];
  return [];
}

export function runtimeTarArgs(
  rawTarPath: string,
  staging: string,
  listPath: string,
  platform: NodeJS.Platform = process.platform,
  ownershipArgs: string[] = tarOwnershipArgs(),
): string[] {
  return [
    '--no-recursion',
    // GNU tar treats the colon in a Windows drive path as remote-archive
    // syntax unless local path handling is forced explicitly.
    ...(platform === 'win32' ? ['--force-local'] : []),
    ...ownershipArgs,
    '-cf',
    rawTarPath,
    '-C',
    staging,
    '--null',
    '-T',
    listPath,
  ];
}

function createRuntimeArchive(archive: string, staging: string, root: string): void {
  normalizeArchiveTree(staging);
  const listPath = join(dirname(staging), 'runtime-archive-inputs.txt');
  const rawTarPath = join(dirname(staging), 'runtime-archive-inputs.tar');
  writeFileSync(listPath, archiveEntries(staging).map((entry) => `${entry}\0`).join(''));
  try {
    run('tar', runtimeTarArgs(rawTarPath, staging, listPath), root);
    /**
     * Keep the gzip header timestamp-free while avoiding a full archive-sized
     * allocation. Runtime resources are large enough that readFileSync here
     * previously failed with ENOMEM on macOS after tar had successfully created
     * the archive.
     */
    // Bun's child_process compatibility layer can pass an invalid descriptor
    // when a numeric fd is used as stdout. Delegate that streaming boundary to
    // Node so the archive remains constant-memory on every native runner.
    const compressor = `
      const { closeSync, openSync } = require('node:fs');
      const { spawnSync } = require('node:child_process');
      const output = openSync(process.argv[2], 'w');
      try {
        const result = spawnSync('gzip', ['-n', '-c', process.argv[1]], {
          stdio: ['ignore', output, 'inherit'],
        });
        if (result.status !== 0) process.exit(result.status ?? 1);
      } finally {
        closeSync(output);
      }
    `;
    const compressed = spawnSync('node', ['-e', compressor, rawTarPath, archive], {
      stdio: 'inherit',
    });
    if (compressed.status !== 0) throw new Error(`gzip failed with status ${compressed.status ?? 'signal'}`);
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
export const parsePreviewBuildManifest = runtimeDistribution.parsePreviewBuildManifest;
export const parsePreviewHealthIdentity = runtimeDistribution.parsePreviewHealthIdentity;
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
export declare const parsePreviewBuildManifest: GameRuntimeDistribution['parsePreviewBuildManifest'];
export declare const parsePreviewHealthIdentity: GameRuntimeDistribution['parsePreviewHealthIdentity'];
export default runtimeDistribution;
`;
}

export function writePlatformEntry(packageRoot: string): void {
  const dist = join(packageRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.js'), platformEntrySource());
  writeFileSync(join(dist, 'index.d.ts'), platformDeclarationSource());
}

function stagePreviewScripts(staging: string, root: string): void {
  const runtimeDirectory = join(staging, 'runtime');
  mkdirSync(runtimeDirectory, { recursive: true });
  for (const [source, output] of [
    ['scripts/game-runtime/preview-build.ts', 'preview-build.mjs'],
    ['scripts/game-runtime/preview-serve.ts', 'preview-serve.mjs'],
  ] as const) {
    run(process.execPath, [
      'build',
      join(root, source),
      '--target=node',
      '--format=esm',
      '--outfile',
      join(runtimeDirectory, output),
    ], root);
  }
}

function preparePreviewEngine(staging: string): void {
  const config = join(staging, 'engine', 'vite.config.ts');
  const source = readFileSync(config, 'utf8');
  const patched = source
    .replace(
      /from\s+['"]\.\.\/core\/src\/asset-roots['"]/g,
      "from '@forgeax/editor-core/asset-roots'",
    )
    .replace(
      /from\s+['"]\.\.\/\.\.\/scripts\/vite\/engine-vite-preset['"]/g,
      "from './engine-vite-preset.mjs'",
    );
  if (patched.includes("../../scripts/vite/engine-vite-preset")) {
    throw new Error(`preview Engine config still references the Studio checkout: ${config}`);
  }
  writeFileSync(config, patched);
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
  readonly engineCommit?: string;
}

export function buildRuntimeTarget(options: BuildRuntimeTargetOptions): { archive: string; manifest: string; packageRoot: string } {
  assertNativeRuntimeTarget(options.target);
  const root = resolve(options.root ?? repositoryRoot);
  const packageRoot = runtimePackageRoot(root, options.target);
  const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
  const version = options.version ?? packageManifest.version;
  if (version !== packageManifest.version) throw new Error(`Runtime version ${version} does not match ${packageManifest.version}`);

  if (!options.fromResources) {
    throw new Error('Desktop runtime assembly belongs to forgeax-ide; use its public build command and pass prepared resources');
  }
  if (!options.skipSdk) buildGameRuntimeSdk({ root });

  if (!options.resourceRoot || !options.sidecarPath) {
    throw new Error('Prepared runtime resources and sidecar path are required; root does not assemble desktop payloads');
  }
  const resourceRoot = resolve(options.resourceRoot);
  const sidecarPath = resolve(options.sidecarPath);
  if (!existsSync(sidecarPath)) throw new Error(`Runtime sidecar is missing: ${sidecarPath}`);
  const stagingParent = mkdtempSync(join(tmpdir(), `forgeax-runtime-${options.target.id}-`));
  const staging = join(stagingParent, 'resources');
  try {
    assembleRuntimeResources({ sourceRoot: resourceRoot, destinationRoot: staging });
    preparePreviewEngine(staging);
    mkdirSync(join(staging, 'bin'), { recursive: true });
    copyFileSync(sidecarPath, join(staging, 'bin', options.target.sidecar));
    stagePreviewScripts(staging, repositoryRoot);

    const sdkVersionPath = join(root, 'packages', 'game-runtime', 'common', 'assets', 'engine-sdk', 'engine-version.json');
    let engineCommit = options.engineCommit ?? (existsSync(sdkVersionPath)
      ? (JSON.parse(readFileSync(sdkVersionPath, 'utf8')) as { engineCommit?: string }).engineCommit ?? 'unknown'
      : 'unknown');
    if (engineCommit === 'unknown') {
      const engineRoot = join(root, 'packages', 'editor', 'packages', 'engine');
      const git = spawnSync('git', ['-C', engineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (git.status === 0) engineCommit = git.stdout.trim();
    }
    if (!/^[a-f0-9]{7,64}$/i.test(engineCommit)) {
      throw new Error(`Runtime requires a concrete Engine commit, received ${JSON.stringify(engineCommit)}`);
    }
    const assetDirectory = join(packageRoot, 'assets', 'runtime', options.target.id);
    rmSync(join(packageRoot, 'assets'), { recursive: true, force: true });
    rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });
    mkdirSync(assetDirectory, { recursive: true });
    const archive = join(assetDirectory, runtimeArtifactName(options.target));
    createRuntimeArchive(archive, staging, root);
    const digest = sha256File(archive);
    const manifest = join(packageRoot, 'assets', 'runtime-manifest.json');
    writeFileSync(manifest, `${JSON.stringify({
      schemaVersion: 2,
      runtimeId: 'forgeax-game-runtime',
      artifacts: [{
        version,
        platform: options.target.platform,
        arch: options.target.arch,
        source: `./runtime/${options.target.id}/${basename(archive)}`,
        sha256: digest,
        engineCommit,
        capabilities: {
          build: { script: 'runtime/preview-build.mjs' },
          serve: { script: 'runtime/preview-serve.mjs' },
        },
        format: 'archive',
        command: `bin/${options.target.sidecar}`,
        args: [],
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
