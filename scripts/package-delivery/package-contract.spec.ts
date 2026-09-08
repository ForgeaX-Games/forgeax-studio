import { describe, expect, test } from 'bun:test';
import { assessPackageSize, validatePackageManifest } from './package-contract.ts';

const library = {
  name: '@forgeax/example',
  version: '1.2.3',
  type: 'module',
  files: ['dist', 'README.md'],
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
};

describe('shared npm package contract', () => {
  test('accepts compiled library, bin, and extension profiles', () => {
    expect(validatePackageManifest(library, { profile: 'library', expectedTag: 'v1.2.3' })).toEqual([]);
    expect(validatePackageManifest({
      ...library,
      name: '@forgeax/example-cli',
      bin: { example: './dist/cli.js' },
    }, { profile: 'bin' })).toEqual([]);
    expect(validatePackageManifest({
      ...library,
      name: '@forgeax-extension/example',
      files: ['dist', 'forgeax-extension.json'],
      exports: { './runtime': './dist/runtime.js' },
    }, { profile: 'extension', extensionManifestPresent: true })).toEqual([]);
  });

  test('rejects source exports, broad files, mutable source dependencies, and tag drift', () => {
    const issues = validatePackageManifest({
      ...library,
      files: ['.'],
      exports: { '.': './src/index.ts' },
      dependencies: {
        '@forgeax/local': 'workspace:*',
        remote: 'git+https://example.invalid/repo.git',
      },
    }, { profile: 'library', expectedTag: 'v9.9.9' });
    expect(issues.map((issue) => issue.code)).toEqual([
      'tag-version-mismatch',
      'files-not-whitelisted',
      'source-entrypoint',
      'source-dependency',
      'source-dependency',
    ]);
  });

  test('requires each profile-specific delivery surface', () => {
    expect(validatePackageManifest({ ...library, bin: undefined }, { profile: 'bin' }))
      .toContainEqual(expect.objectContaining({ code: 'bin-missing' }));
    expect(validatePackageManifest({ ...library, name: '@forgeax/example' }, {
      profile: 'extension',
      extensionManifestPresent: false,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'extension-name-invalid' }),
      expect.objectContaining({ code: 'extension-manifest-missing' }),
    ]));
  });

  test('blocks unexplained package growth while preserving a machine-readable report', () => {
    expect(assessPackageSize(
      { packedBytes: 121, unpackedBytes: 220 },
      { packedBytes: 100, unpackedBytes: 200, maxGrowthPercent: 20 },
    )).toEqual({
      ok: false,
      packedGrowthPercent: 21,
      unpackedGrowthPercent: 10,
      exceeded: ['packedBytes'],
    });
  });
});
