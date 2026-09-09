import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPackSmoke } from './pack-smoke.ts';

describe('generic tarball consumer smoke', () => {
  test('packs and imports a library from an otherwise empty consumer', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pack-smoke-fixture-'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist/index.js'), 'export const ready = true;\n');
    writeFileSync(join(root, 'dist/index.d.ts'), 'export declare const ready: true;\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: '@forgeax/pack-smoke-fixture',
      version: '1.0.0',
      type: 'module',
      files: ['dist'],
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }));
    try {
      const report = runPackSmoke({ packageDirectory: root, profile: 'library' });
      expect(report).toEqual(expect.objectContaining({
        schemaVersion: 1,
        profile: 'library',
        name: '@forgeax/pack-smoke-fixture',
        version: '1.0.0',
        consumerSmoke: 'passed',
      }));
      expect(report.packedBytes).toBeGreaterThan(0);
      expect(report.unpackedBytes).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
