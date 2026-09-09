import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assessPackageSize,
  validatePackageManifest,
  type PackageProfile,
  type PackageSizeBaseline,
  type PackageManifest,
} from './package-contract.ts';

export interface PackSmokeOptions {
  readonly packageDirectory: string;
  readonly profile: PackageProfile;
  readonly expectedTag?: string;
  readonly smokeCommand?: string;
  readonly sizeBaseline?: PackageSizeBaseline;
}

export interface PackSmokeReport {
  readonly schemaVersion: 1;
  readonly profile: PackageProfile;
  readonly name: string;
  readonly version: string;
  readonly packedBytes: number;
  readonly unpackedBytes: number;
  readonly fileCount: number;
  readonly consumerSmoke: 'passed';
  readonly size?: ReturnType<typeof assessPackageSize>;
}

function run(command: string, args: string[], cwd: string, cache: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const stdoutPath = join(cache, 'command.stdout');
  const stderrPath = join(cache, 'command.stderr');
  mkdirSync(cache, { recursive: true });
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
    env: {
      ...process.env,
      ...extraEnv,
      TMPDIR: cache,
      TMP: cache,
      TEMP: cache,
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
    },
  });
  const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, 'utf8') : '';
  const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : '';
  rmSync(stdoutPath, { force: true });
  rmSync(stderrPath, { force: true });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${stdout}${stderr}`);
  }
  return stdout.trim();
}

function binNames(manifest: PackageManifest): string[] {
  if (typeof manifest.bin === 'string') return [String(manifest.name).replace(/^@[^/]+\//u, '')];
  return Object.keys(manifest.bin ?? {});
}

function directorySize(root: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySize(path);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += statSync(path).size;
      files += 1;
    }
  }
  return { bytes, files };
}

export function runPackSmoke(options: PackSmokeOptions): PackSmokeReport {
  const packageDirectory = resolve(options.packageDirectory);
  const sandbox = mkdtempSync(join(tmpdir(), 'forgeax-pack-smoke-'));
  const cache = join(sandbox, 'npm-cache');
  const candidate = join(sandbox, 'candidate');
  const consumer = join(sandbox, 'consumer');
  mkdirSync(candidate);
  mkdirSync(consumer);
  try {
    const sourceManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')) as PackageManifest;
    const extensionManifestPresent = existsSync(join(packageDirectory, 'forgeax-extension.json'));
    const health = validatePackageManifest(sourceManifest, {
      profile: options.profile,
      expectedTag: options.expectedTag,
      extensionManifestPresent,
    });
    if (health.length > 0) throw new Error(`package health failed:\n${health.map((item) => `- ${item.code}: ${item.message}`).join('\n')}`);

    run(process.execPath, ['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', candidate], packageDirectory, cache);
    const reportedPack: {
      filename: string;
      size: number;
      unpackedSize: number;
      entryCount: number;
    } | undefined = undefined;
    const candidates = readdirSync(candidate).filter((name) => name.endsWith('.tgz'));
    const filename = reportedPack?.filename ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!filename) throw new Error('npm pack did not return one candidate');
    const tarball = join(candidate, filename);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(process.execPath, ['add', '--ignore-scripts', '--no-save', tarball], consumer, cache);
    const installedRoot = join(consumer, 'node_modules', ...String(sourceManifest.name).split('/'));
    const packedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')) as PackageManifest;
    if (packedManifest.name !== sourceManifest.name || packedManifest.version !== sourceManifest.version) {
      throw new Error('installed tarball identity differs from source manifest');
    }
    const installedSize = directorySize(installedRoot);
    const packedBytes = reportedPack?.size ?? statSync(tarball).size;
    const unpackedBytes = reportedPack?.unpackedSize ?? installedSize.bytes;
    const fileCount = reportedPack?.entryCount ?? installedSize.files;

    if (options.profile === 'library') {
      run('node', ['--input-type=module', '--eval', `await import(${JSON.stringify(sourceManifest.name)})`], consumer, cache);
    } else if (options.profile === 'bin') {
      for (const name of binNames(packedManifest)) {
        if (!existsSync(join(consumer, 'node_modules', '.bin', name))) throw new Error(`installed bin is missing: ${name}`);
      }
    } else {
      const manifestPath = join(installedRoot, 'forgeax-extension.json');
      if (!existsSync(manifestPath)) throw new Error('installed extension manifest is missing');
      JSON.parse(readFileSync(manifestPath, 'utf8'));
    }

    if (options.smokeCommand) {
      const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', options.smokeCommand] : ['-lc', options.smokeCommand];
      run(shell, args, consumer, cache, {
        FORGEAX_PACK_SMOKE_PACKAGE: String(sourceManifest.name),
        FORGEAX_PACK_SMOKE_ROOT: installedRoot,
        FORGEAX_PACK_SMOKE_TARBALL: tarball,
      });
    }

    const size = options.sizeBaseline
      ? assessPackageSize({ packedBytes, unpackedBytes }, options.sizeBaseline)
      : undefined;
    if (size && !size.ok) throw new Error(`package size regression: ${size.exceeded.join(', ')}`);
    return {
      schemaVersion: 1,
      profile: options.profile,
      name: String(sourceManifest.name),
      version: String(sourceManifest.version),
      packedBytes,
      unpackedBytes,
      fileCount,
      consumerSmoke: 'passed',
      ...(size ? { size } : {}),
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

export function packageTarballBasename(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
}

export function describePackSmoke(report: PackSmokeReport): string {
  return `${report.name}@${report.version} ${report.profile}: ${report.packedBytes} packed bytes, ${report.unpackedBytes} unpacked bytes, ${report.fileCount} files`;
}
