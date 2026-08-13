import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_VERSION } from './check-release-train';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const packageRoots = {
  common: 'packages/game-runtime/common',
  universal: 'packages/game-runtime/universal',
  darwinArm64: 'packages/game-runtime/darwin-arm64',
  win32X64: 'packages/game-runtime/win32-x64',
  linuxX64: 'packages/game-runtime/linux-x64',
} as const;

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundledDependencies?: string[] | boolean;
  bundleDependencies?: string[] | boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
};

function readJson<T>(path: string): T {
  expect(
    existsSync(path),
    `Missing required file: ${relative(repoRoot, path)}`,
  ).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readPackage(packageRoot: string): PackageManifest {
  return readJson<PackageManifest>(join(repoRoot, packageRoot, 'package.json'));
}

describe('Game Runtime npm package graph', () => {
  test('registers exactly the five Runtime packages as explicit workspaces', () => {
    const root = readJson<{ workspaces?: string[] }>(join(repoRoot, 'package.json'));
    const expected = Object.values(packageRoots);
    const runtimeWorkspaces = (root.workspaces ?? []).filter((workspace) =>
      workspace.startsWith('packages/game-runtime')
      || expected.some((packageRoot) => new Bun.Glob(workspace).match(packageRoot)),
    );

    expect(runtimeWorkspaces).toEqual(expected);

    const lock = readFileSync(join(repoRoot, 'bun.lock'), 'utf8');
    const importerKeys = [...lock.matchAll(/^    "(packages\/game-runtime\/[^"]+)": \{$/gm)]
      .map((match) => match[1]);
    expect(importerKeys).toEqual([...expected].sort());

    const expectedMappings = [
      ['@forgeax/game-runtime', '@forgeax/game-runtime@workspace:packages/game-runtime/universal'],
      ['@forgeax/game-runtime-common', '@forgeax/game-runtime-common@workspace:packages/game-runtime/common'],
      ['@forgeax/game-runtime-darwin-arm64', '@forgeax/game-runtime-darwin-arm64@workspace:packages/game-runtime/darwin-arm64'],
      ['@forgeax/game-runtime-linux-x64', '@forgeax/game-runtime-linux-x64@workspace:packages/game-runtime/linux-x64'],
      ['@forgeax/game-runtime-win32-x64', '@forgeax/game-runtime-win32-x64@workspace:packages/game-runtime/win32-x64'],
    ].sort(([left], [right]) => left.localeCompare(right));
    const mappings = [...lock.matchAll(/^    "(@forgeax\/game-runtime[^"]*)": \["([^"]+)"\],$/gm)]
      .map((match) => [match[1], match[2]])
      .sort(([left], [right]) => left.localeCompare(right));
    expect(mappings).toEqual(expectedMappings);
  });

  test('publishes only built Runtime artifacts', () => {
    const expected = [
      ['common', '@forgeax/game-runtime-common', ['dist', 'assets', 'README.md']],
      ['universal', '@forgeax/game-runtime', ['dist', 'README.md']],
      ['darwinArm64', '@forgeax/game-runtime-darwin-arm64', ['dist', 'assets', 'README.md']],
      ['win32X64', '@forgeax/game-runtime-win32-x64', ['dist', 'assets', 'README.md']],
      ['linuxX64', '@forgeax/game-runtime-linux-x64', ['dist', 'assets', 'README.md']],
    ] as const;

    for (const [packageKey, name, files] of expected) {
      const manifest = readPackage(packageRoots[packageKey]);
      expect(manifest.name).toBe(name);
      expect(manifest.version).toBe(RUNTIME_VERSION);
      expect(manifest.private).not.toBe(true);
      expect(manifest.type).toBe('module');
      expect(manifest.main).toBe('./dist/index.js');
      expect(manifest.types).toBe('./dist/index.d.ts');
      expect(manifest.exports).toEqual({
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          default: './dist/index.js',
        },
      });
      expect(manifest.files).toEqual(files);
      expect(manifest.publishConfig).toEqual({ access: 'public' });
    }
  });

  test('routes Universal through exactly the three platform packages', () => {
    const universal = readPackage(packageRoots.universal);
    const commonPackage = '@forgeax/game-runtime-common';

    expect(universal.dependencies?.[commonPackage]).toBeUndefined();
    expect(universal.peerDependencies?.[commonPackage]).toBeUndefined();
    for (const bundled of [universal.bundledDependencies, universal.bundleDependencies]) {
      expect(Array.isArray(bundled) ? bundled : []).not.toContain(commonPackage);
    }
    expect(universal.optionalDependencies).toEqual({
      '@forgeax/game-runtime-darwin-arm64': RUNTIME_VERSION,
      '@forgeax/game-runtime-win32-x64': RUNTIME_VERSION,
      '@forgeax/game-runtime-linux-x64': RUNTIME_VERSION,
    });
  });

  test('keeps Common and Universal platform-neutral', () => {
    for (const packageRoot of [packageRoots.common, packageRoots.universal]) {
      const manifest = readPackage(packageRoot);
      expect(manifest.os).toBeUndefined();
      expect(manifest.cpu).toBeUndefined();
      expect(manifest.libc).toBeUndefined();
    }
  });

  test('gives every platform package an exact common edge and selector', () => {
    const common = readPackage(packageRoots.common);
    const platforms = [
      {
        root: packageRoots.darwinArm64,
        os: ['darwin'],
        cpu: ['arm64'],
        libc: undefined,
      },
      {
        root: packageRoots.win32X64,
        os: ['win32'],
        cpu: ['x64'],
        libc: undefined,
      },
      {
        root: packageRoots.linuxX64,
        os: ['linux'],
        cpu: ['x64'],
        libc: ['glibc'],
      },
    ] as const;

    for (const platform of platforms) {
      const manifest = readPackage(platform.root);
      expect(manifest.dependencies).toEqual({
        '@forgeax/game-runtime-common': RUNTIME_VERSION,
      });
      expect(manifest.version).toBe(common.version);
      expect(manifest.os).toEqual(platform.os);
      expect(manifest.cpu).toEqual(platform.cpu);
      expect(manifest.libc).toEqual(platform.libc);
    }
  });

  test('keeps platform packages free of any tracked authored implementation', () => {
    for (const packageRoot of [
      packageRoots.darwinArm64,
      packageRoots.win32X64,
      packageRoots.linuxX64,
    ]) {
      const tracked = execFileSync('git', ['ls-files', '--', packageRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim().split(/\r?\n/).filter(Boolean).sort();
      const allowed = [
        `${packageRoot}/README.md`,
        `${packageRoot}/package.json`,
      ];
      expect(tracked.every((file) => allowed.includes(file)), tracked.join('\n')).toBe(true);
    }
  });
});
