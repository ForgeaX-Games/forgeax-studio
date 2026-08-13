import { expect, test } from 'bun:test';
import {
  extensionBuildCommands,
  extensionPackageManager,
  extensionPackageManagerFallback,
} from './extension-build';

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
