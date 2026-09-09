import { expect, test } from 'bun:test';
import {
  extensionBuildCommands,
  extensionFrontendArtifact,
  extensionPackageManager,
  extensionPackageManagerFallback,
  extensionPreparationCommands,
  isExtensionSourceDirectory,
  matchesExtensionSelector,
} from './extension-build';

test('maps source frontend entries to the server-owned runtime artifact', () => {
  expect(extensionFrontendArtifact({
    entry: {
      frontend: './src/panel.tsx',
      standalone: { embeddedAlso: true },
    },
  })).toBe('./dist/index.html');
});

test('keeps an explicitly declared HTML frontend artifact', () => {
  expect(extensionFrontendArtifact({
    entry: { frontend: './viz/dist/index.html' },
  })).toBe('./viz/dist/index.html');
});

test('does not invent a frontend artifact for a backend-only extension', () => {
  expect(extensionFrontendArtifact({
    entry: { standalone: { embeddedAlso: false } },
  })).toBeUndefined();
});

test('always installs dependencies even when the runtime artifact is ready', () => {
  expect(extensionPreparationCommands(
    { packageManager: 'bun@1.3.13', scripts: { build: 'vite build' } },
    undefined,
    { hasFrontend: true, artifactBroken: false, force: false },
  )).toEqual([
    ['bun', ['install', '--frozen-lockfile']],
  ]);
});

test('installs backend-only extensions without running their backend build', () => {
  expect(extensionPreparationCommands(
    { packageManager: 'pnpm@10.0.0', scripts: { build: 'tsc', start: 'tsx server.ts' } },
    undefined,
    { hasFrontend: false, artifactBroken: false, force: true },
  )).toEqual([
    ['pnpm', ['install', '--no-frozen-lockfile']],
  ]);
});

test('builds after install when the runtime artifact is missing', () => {
  expect(extensionPreparationCommands(
    { packageManager: 'bun@1.3.13', scripts: { build: 'vite build' } },
    undefined,
    { hasFrontend: true, artifactBroken: true, force: false },
  )).toEqual([
    ['bun', ['install', '--frozen-lockfile']],
    ['bun', ['run', 'build']],
  ]);
});

test('discovers manifest-owned extensions after the wb-* directory era', () => {
  expect(isExtensionSourceDirectory('narrative', {
    symbolicLink: false,
    hasManifest: true,
    hasPackage: true,
  })).toBe(true);
  expect(isExtensionSourceDirectory('_template', {
    symbolicLink: false,
    hasManifest: true,
    hasPackage: true,
  })).toBe(false);
  expect(isExtensionSourceDirectory('narrative', {
    symbolicLink: true,
    hasManifest: true,
    hasPackage: true,
  })).toBe(false);
  expect(isExtensionSourceDirectory('narrative', {
    symbolicLink: false,
    hasManifest: false,
    hasPackage: true,
  })).toBe(false);
});

test('matches an extension by directory, package name, or manifest id', () => {
  const pkg = { name: '@forgeax-extension/narrative' };
  const manifest = { id: '@forgeax-extension/narrative' };
  expect(matchesExtensionSelector('narrative', 'narrative', pkg, manifest)).toBe(true);
  expect(matchesExtensionSelector('@forgeax-extension/narrative', 'narrative', pkg, manifest)).toBe(true);
  expect(matchesExtensionSelector('character', 'narrative', pkg, manifest)).toBe(false);
});

test('honors a declared package manager without requiring a workspace marker', () => {
  expect(extensionPackageManager({ packageManager: 'pnpm@9.0.0' }, 'bun')).toBe('pnpm');
  expect(extensionPackageManager({ packageManager: 'bun@1.3.13' }, 'pnpm')).toBe('bun');
});

test('uses the legacy fallback only when packageManager is absent', () => {
  expect(extensionPackageManager({}, 'pnpm')).toBe('pnpm');
  expect(extensionPackageManager({}, 'bun')).toBe('bun');
});

test('prefers a Bun lockfile over a stale pnpm workspace marker', () => {
  expect(
    extensionPackageManagerFallback({
      bunLock: true,
      pnpmLock: false,
      pnpmWorkspace: true,
    }),
  ).toBe('bun');
});

test('uses pnpm lockfiles and legacy workspaces when no Bun lock exists', () => {
  expect(
    extensionPackageManagerFallback({
      bunLock: false,
      pnpmLock: true,
      pnpmWorkspace: false,
    }),
  ).toBe('pnpm');
  expect(
    extensionPackageManagerFallback({
      bunLock: false,
      pnpmLock: false,
      pnpmWorkspace: true,
    }),
  ).toBe('pnpm');
});

test('uses Bun for a Bun-owned extension', () => {
  expect(extensionBuildCommands({ packageManager: 'bun@1.3.13' })).toEqual([
    ['bun', ['install', '--frozen-lockfile']],
    ['bun', ['run', 'build']],
  ]);
});

test('uses a non-frozen Bun install for a legacy extension without a declared manager', () => {
  expect(extensionBuildCommands({}, 'bun')).toEqual([
    ['bun', ['install']],
    ['bun', ['run', 'build']],
  ]);
});

test('accepts a different Bun version without narrowing the selector', () => {
  expect(extensionBuildCommands({ packageManager: 'bun@1.2.4' })).toEqual([
    ['bun', ['install', '--frozen-lockfile']],
    ['bun', ['run', 'build']],
  ]);
});

test('keeps pnpm for existing pnpm extensions', () => {
  expect(extensionBuildCommands({ packageManager: 'pnpm@10.0.0' })).toEqual([
    ['pnpm', ['install', '--no-frozen-lockfile']],
    ['pnpm', ['build']],
  ]);
});

test('accepts a different pnpm version without narrowing the selector', () => {
  expect(extensionBuildCommands({ packageManager: 'pnpm@9.15.5' })).toEqual([
    ['pnpm', ['install', '--no-frozen-lockfile']],
    ['pnpm', ['build']],
  ]);
});

test('rejects a missing package manager with a structured error', () => {
  expect(() => extensionBuildCommands({})).toThrow(
    expect.objectContaining({
      name: 'UnsupportedExtensionPackageManagerError',
      packageManager: undefined,
    }),
  );
});

test.each(['bun', 'bunx@1.3.13', 'pnpm', 'pnpmx@10.0.0'])(
  'rejects the near-match package manager %s with a structured error',
  (packageManager) => {
    expect(() => extensionBuildCommands({ packageManager })).toThrow(
      expect.objectContaining({
        name: 'UnsupportedExtensionPackageManagerError',
        packageManager,
      }),
    );
  },
);

test('rejects an unsupported package manager with a structured error', () => {
  expect(() => extensionBuildCommands({ packageManager: 'npm@11.0.0' })).toThrow(
    expect.objectContaining({
      name: 'UnsupportedExtensionPackageManagerError',
      packageManager: 'npm@11.0.0',
    }),
  );
});
