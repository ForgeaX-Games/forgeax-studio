import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArtifact } from './artifact-downloader.ts';

describe('artifact downloader checksum contract', () => {
  test('keeps the pre-install syntax gate independent of workspace links', () => {
    const source = readFileSync(join(import.meta.dir, 'artifact-downloader.ts'), 'utf8');
    expect(source).toContain("from '../../packages/recursive-input-contract/src/artifact-manifest.ts'");
    expect(source).not.toContain("from '@forgeax/recursive-input-contract/artifact-manifest'");
  });

  test('materializes a digest-addressed artifact atomically and reuses the verified cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-artifact-'));
    const bytes = new TextEncoder().encode('artifact bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let requests = 0;
    const manifest = {
      schemaVersion: 1 as const,
      name: 'fixture-assets',
      version: '1.0.0',
      url: 'https://artifacts.example.invalid/fixture-assets-1.0.0.bin',
      sha256,
      compressedBytes: bytes.byteLength,
      unpackedBytes: bytes.byteLength,
      licenseInventory: 'licenses.spdx.json',
    };
    try {
      const fetchImpl = async () => {
        requests += 1;
        return new Response(bytes, { status: 200 });
      };
      const first = await downloadArtifact(manifest, { cacheRoot: root, fetchImpl });
      const second = await downloadArtifact(manifest, { cacheRoot: root, fetchImpl });
      expect(first).toBe(second);
      expect(readFileSync(first).toString()).toBe('artifact bytes');
      expect(requests).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects checksum mismatch without promoting a partial file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-artifact-'));
    try {
      await expect(downloadArtifact({
        schemaVersion: 1,
        name: 'fixture-assets',
        version: '1.0.0',
        url: 'https://artifacts.example.invalid/fixture-assets-1.0.0.bin',
        sha256: 'a'.repeat(64),
        compressedBytes: 3,
        unpackedBytes: 3,
        licenseInventory: 'licenses.spdx.json',
      }, {
        cacheRoot: root,
        fetchImpl: async () => new Response('bad', { status: 200 }),
      })).rejects.toThrow('checksum mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
