#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { RUNTIME_PACKAGES, RUNTIME_VERSION, validateReleaseTrain, type PackedManifest } from './check-release-train';

function runTar(args: string[]): string {
  const result = spawnSync('tar', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`tar ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function expectedTarballName(packageName: string): string {
  return `forgeax-${packageName.slice('@forgeax/'.length)}-${RUNTIME_VERSION}.tgz`;
}

export function acceptPackedRuntime(directory: string): Map<string, string> {
  const root = resolve(directory);
  const tarballs = readdirSync(root).filter((entry) => entry.endsWith('.tgz')).sort();
  const expectedTarballs = RUNTIME_PACKAGES.map((name) => expectedTarballName(name)).sort();
  if (JSON.stringify(tarballs) !== JSON.stringify(expectedTarballs)) {
    throw new Error(`expected exactly five Runtime tarballs: ${tarballs.join(', ')}`);
  }

  const manifests = new Map<string, PackedManifest>();
  const paths = new Map<string, string>();
  const unpackRoot = mkdtempSync(join(tmpdir(), 'forgeax-runtime-release-train-'));
  try {
    for (const filename of tarballs) {
      const tarball = join(root, filename);
      const checksumFile = `${tarball}.sha256`;
      if (!existsSync(checksumFile)) throw new Error(`missing SHA-256 sidecar: ${basename(checksumFile)}`);
      const expectedSha = readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0];
      if (sha256(tarball) !== expectedSha) throw new Error(`tarball SHA-256 mismatch: ${filename}`);

      const manifest = JSON.parse(runTar(['-xOf', tarball, 'package/package.json'])) as PackedManifest;
      if (!manifest.name || manifests.has(manifest.name)) throw new Error(`duplicate or unnamed package: ${filename}`);
      manifests.set(manifest.name, manifest);
      paths.set(manifest.name, tarball);

      const entries = runTar(['-tzf', tarball]).split(/\r?\n/).filter(Boolean);
      if (entries.some((entry) => entry.startsWith('/') || entry.replaceAll('\\', '/').split('/').includes('..'))) {
        throw new Error(`unsafe archive path in ${filename}`);
      }
      if (entries.some((entry) => /(?:^|\/)(?:src|test|tests)(?:\/|$)|\.map$|(?:^|\/)bun\.lock$/u.test(entry))) {
        throw new Error(`source, test, map, or lockfile leaked into ${filename}`);
      }
      const destination = join(unpackRoot, manifest.name.replace(/[^a-z0-9.-]/gi, '_'));
      mkdirSync(destination);
      runTar(['-xzf', tarball, '-C', destination]);
    }
    validateReleaseTrain(manifests);

    const universal = paths.get('@forgeax/game-runtime')!;
    const universalJs = runTar(['-xOf', universal, 'package/dist/index.js']);
    if (universalJs.includes('@forgeax/game-runtime-common')) throw new Error('Universal runtime code imports common');
    const platformIdentity = {
      '@forgeax/game-runtime-darwin-arm64': { platform: 'darwin', arch: 'arm64' },
      '@forgeax/game-runtime-win32-x64': { platform: 'win32', arch: 'x64' },
      '@forgeax/game-runtime-linux-x64': { platform: 'linux', arch: 'x64' },
    } as const;
    for (const name of RUNTIME_PACKAGES.slice(1, 4)) {
      const tarball = paths.get(name)!;
      const entries = runTar(['-tzf', tarball]);
      if (!entries.includes('package/assets/runtime-manifest.json')) throw new Error(`${name} has no Runtime manifest`);
      if (!entries.includes('package/dist/index.js')) throw new Error(`${name} has no generated platform entry`);
      const packageRoot = join(unpackRoot, name.replace(/[^a-z0-9.-]/gi, '_'), 'package');
      const runtimeManifest = JSON.parse(readFileSync(join(packageRoot, 'assets', 'runtime-manifest.json'), 'utf8')) as {
        artifacts?: Array<{ version?: string; source?: string; sha256?: string; platform?: string; arch?: string; command?: string }>;
      };
      if (runtimeManifest.artifacts?.length !== 1) throw new Error(`${name} must contain exactly one Runtime artifact`);
      const artifact = runtimeManifest.artifacts[0];
      if (!artifact.source || isAbsolute(artifact.source)) throw new Error(`${name} Runtime source is unsafe`);
      const assetRoot = join(packageRoot, 'assets');
      const archive = resolve(assetRoot, artifact.source);
      const path = relative(assetRoot, archive);
      if (path.startsWith('..') || isAbsolute(path) || !existsSync(archive)) throw new Error(`${name} Runtime archive is missing or outside assets`);
      if (!artifact.sha256 || sha256(archive) !== artifact.sha256) throw new Error(`${name} inner Runtime SHA-256 mismatch`);
      if (artifact.version !== RUNTIME_VERSION || !artifact.command?.startsWith('bin/bun-')) throw new Error(`${name} Runtime identity is invalid`);
      const expectedIdentity = platformIdentity[name];
      if (artifact.platform !== expectedIdentity.platform || artifact.arch !== expectedIdentity.arch) {
        throw new Error(`${name} inner Runtime platform identity is invalid`);
      }
    }
    const commonEntries = runTar(['-tzf', paths.get('@forgeax/game-runtime-common')!]);
    if (!commonEntries.includes('package/assets/engine-sdk/engine-version.json')) {
      throw new Error('common package has no Engine SDK snapshot');
    }
    return paths;
  } finally {
    rmSync(unpackRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const index = process.argv.indexOf('--directory');
  const directory = index >= 0 ? process.argv[index + 1] : undefined;
  if (!directory) throw new Error('--directory is required');
  const paths = acceptPackedRuntime(directory);
  for (const [name, path] of paths) console.log(`${name}: ${path}`);
}
