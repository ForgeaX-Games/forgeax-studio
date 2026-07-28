import { expect, test } from 'bun:test';
import { extensionBuildCommands } from './extension-build';

test('uses Bun for a Bun-owned extension', () => {
  expect(extensionBuildCommands({ packageManager: 'bun@1.3.13' })).toEqual([
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

test('rejects a missing package manager with a structured error', () => {
  expect(() => extensionBuildCommands({})).toThrow(
    expect.objectContaining({
      name: 'UnsupportedExtensionPackageManagerError',
      packageManager: undefined,
    }),
  );
});

test('rejects an unsupported package manager with a structured error', () => {
  expect(() => extensionBuildCommands({ packageManager: 'npm@11.0.0' })).toThrow(
    expect.objectContaining({
      name: 'UnsupportedExtensionPackageManagerError',
      packageManager: 'npm@11.0.0',
    }),
  );
});
