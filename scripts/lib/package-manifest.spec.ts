import { describe, expect, test } from 'bun:test';

import {
  buildPackagesLocalConfig,
  focusPackagePaths,
  mergePackagesLocalConfig,
  resolvePackageConfig,
  selectPackageEntries,
  type PackageEntry,
} from './package-manifest.ts';

const base: PackageEntry[] = [
  { path: 'packages/a', url: 'https://example.com/a.git', branch: 'main' },
  { path: 'packages/b', url: 'https://example.com/b.git', branch: 'main' },
];

describe('.packages manifest resolution', () => {
  test('treats a legacy local array as assign-by-path', () => {
    expect(resolvePackageConfig(base, [
      { path: 'packages/a', url: 'https://example.com/a.git', branch: 'feat/a' },
      { path: 'packages/c', url: 'https://example.com/c.git', branch: 'main' },
    ])).toEqual([
      { path: 'packages/a', url: 'https://example.com/a.git', branch: 'feat/a' },
      { path: 'packages/b', url: 'https://example.com/b.git', branch: 'main' },
      { path: 'packages/c', url: 'https://example.com/c.git', branch: 'main' },
    ]);
  });

  test('applies replace before assign and keeps last path position stable', () => {
    expect(resolvePackageConfig(base, {
      replace: [
        { path: 'packages/x', url: 'https://example.com/x.git', branch: 'main' },
        { path: 'packages/y', url: 'https://example.com/y.git', branch: 'main' },
      ],
      assign: [
        { path: 'packages/x', url: 'https://example.com/x.git', branch: 'feat/x' },
        { path: 'packages/z', url: 'https://example.com/z.git', branch: 'main' },
      ],
    })).toEqual([
      { path: 'packages/x', url: 'https://example.com/x.git', branch: 'feat/x' },
      { path: 'packages/y', url: 'https://example.com/y.git', branch: 'main' },
      { path: 'packages/z', url: 'https://example.com/z.git', branch: 'main' },
    ]);
  });

  test('rejects deprecated append and unsafe checkout or link paths', () => {
    expect(() => resolvePackageConfig(base, { append: [] } as never)).toThrow('deprecated');
    expect(() => resolvePackageConfig([
      { path: '../escape', url: 'https://example.com/a.git', branch: 'main' },
    ], null)).toThrow('safe project-relative path');
    expect(() => resolvePackageConfig([
      {
        path: 'packages/a',
        url: 'https://example.com/a.git',
        branch: 'main',
        links: { '../escape': '.agents/skills/a' },
      },
    ], null)).toThrow('safe package-relative path');
  });

  test('derives focus from explicitly local replace and assign entries', () => {
    expect(focusPackagePaths({
      replace: [{ path: 'packages/b', url: 'u', branch: 'main' }],
      assign: [
        { path: 'packages/a', url: 'u', branch: 'main' },
        { path: 'packages/b', url: 'u', branch: 'other' },
      ],
    })).toEqual(['packages/b', 'packages/a']);
    expect(() => focusPackagePaths({ assign: [] })).toThrow('focus scope is empty');
  });

  test('selects entries by path or basename and reports missing selectors', () => {
    expect(selectPackageEntries(base, ['a'])).toEqual([base[0]]);
    expect(selectPackageEntries(base, ['packages/b'])).toEqual([base[1]]);
    expect(() => selectPackageEntries(base, ['missing'])).toThrow('missing');
  });
});

describe('package branch local overrides', () => {
  test('builds and merges assign entries without losing unrelated overrides', () => {
    expect(buildPackagesLocalConfig(base, { branch: 'feat/all' })).toEqual({
      assign: base.map((entry) => ({ ...entry, branch: 'feat/all' })),
    });

    expect(mergePackagesLocalConfig({
      assign: [{ path: 'packages/b', url: 'https://override.example/b.git', branch: 'keep' }],
      note: 'preserved',
    }, base, { branch: 'feat/a', selectors: ['a'] })).toEqual({
      assign: [
        { path: 'packages/b', url: 'https://override.example/b.git', branch: 'keep' },
        { path: 'packages/a', url: 'https://example.com/a.git', branch: 'feat/a' },
      ],
      note: 'preserved',
    });
  });
});
