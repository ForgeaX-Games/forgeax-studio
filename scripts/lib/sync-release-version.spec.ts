import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncReleaseVersion } from './sync-release-version.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('Studio release version boundary', () => {
  test('reads Studio metadata without requiring or mutating IDE/interface desktop manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-release-version-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}\n');
    expect(syncReleaseVersion(root)).toBe('1.2.3');
  });

  test('fails closed on a non-semver orchestration version', () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-release-version-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{"version":"latest"}\n');
    expect(() => syncReleaseVersion(root)).toThrow('exact semver');
  });
});
