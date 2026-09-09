import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION,
  previewPayloadDigest,
  readPreviewManifest,
  validatePreviewOutput,
  validatePreviewPack,
} from './preview-contract';

const roots: string[] = [];
const GUID = '01890000-0000-7000-8000-ffffffffffff';

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function authoredGame(): string {
  const root = fixture('forgeax-preview-game-');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ forgeax: { assets: { roots: ['assets'] } } }));
  writeFileSync(join(root, 'assets', 'scene.glb'), 'source');
  writeFileSync(join(root, 'assets', 'scene.glb.meta.json'), JSON.stringify({
    importer: 'gltf',
    subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'mesh' }],
  }));
  return root;
}

function validOutput(gameRoot: string): string {
  const outputRoot = fixture('forgeax-preview-output-');
  mkdirSync(join(outputRoot, 'assets', GUID), { recursive: true });
  writeFileSync(join(outputRoot, 'index.html'), '<!doctype html>');
  writeFileSync(join(outputRoot, 'assets', GUID, 'mesh.bin'), 'payload');
  writeFileSync(join(outputRoot, 'assets', `${GUID}.pack.json`), JSON.stringify({
    assets: [{ guid: GUID, artifacts: { mesh: { path: `${GUID}/mesh.bin` } } }],
  }));
  writeFileSync(join(outputRoot, 'pack-index.json'), JSON.stringify([{
    guid: GUID,
    packageUrl: `/preview/assets/${GUID}.pack.json`,
  }]));
  const payloadDigest = previewPayloadDigest(outputRoot);
  writeFileSync(join(outputRoot, 'preview-manifest.json'), JSON.stringify({
    schemaVersion: PREVIEW_BUILD_MANIFEST_SCHEMA_VERSION,
    gameId: 'demo',
    buildHash: 'a'.repeat(64),
    runtimeVersion: '0.3.33',
    engineCommit: '0123456789abcdef0123456789abcdef01234567',
    projectRoot: '/workspace/project',
    gameRoot,
    outputRoot,
    payloadDigest,
  }));
  return outputRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('build-once preview pack closure', () => {
  test('accepts a catalog whose authored GUID and pack artifacts are present', () => {
    const gameRoot = authoredGame();
    const outputRoot = validOutput(gameRoot);
    expect(validatePreviewPack(outputRoot, gameRoot)).toEqual({
      entryCount: 1,
      packageFiles: [`assets/${GUID}.pack.json`],
    });
    expect(readPreviewManifest(outputRoot).payloadDigest).toBe(previewPayloadDigest(outputRoot));
    expect(validatePreviewOutput(outputRoot, gameRoot).entryCount).toBe(1);
  });

  test('fails closed when the authored GUID is absent from pack-index', () => {
    const gameRoot = authoredGame();
    const outputRoot = fixture('forgeax-preview-empty-output-');
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, 'pack-index.json'), '[]');
    expect(() => validatePreviewPack(outputRoot, gameRoot)).toThrow('missing authored asset GUIDs');
  });

  test('fails closed when a catalog package or its artifact is missing', () => {
    const gameRoot = authoredGame();
    const outputRoot = fixture('forgeax-preview-broken-output-');
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, 'pack-index.json'), JSON.stringify([{
      guid: GUID,
      packageUrl: `/preview/assets/${GUID}.pack.json`,
    }]));
    expect(() => validatePreviewPack(outputRoot, gameRoot)).toThrow('payload is missing');
  });

  test('rejects catalog URLs that escape the static preview output', () => {
    const gameRoot = authoredGame();
    const outputRoot = fixture('forgeax-preview-escaped-output-');
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, 'pack-index.json'), JSON.stringify([{
      guid: GUID,
      packageUrl: 'https://attacker.invalid/asset.pack.json',
    }]));
    expect(() => validatePreviewPack(outputRoot, gameRoot)).toThrow('preview origin');
  });

  test('rejects pack artifacts that escape the static preview output', () => {
    const gameRoot = authoredGame();
    const outputRoot = fixture('forgeax-preview-escaped-artifact-output-');
    mkdirSync(join(outputRoot, 'assets'), { recursive: true });
    writeFileSync(join(outputRoot, 'assets', `${GUID}.pack.json`), JSON.stringify({
      assets: [{ guid: GUID, artifacts: { mesh: { path: '../../escape.bin' } } }],
    }));
    writeFileSync(join(outputRoot, 'pack-index.json'), JSON.stringify([{
      guid: GUID,
      packageUrl: `/preview/assets/${GUID}.pack.json`,
    }]));
    expect(() => validatePreviewPack(outputRoot, gameRoot)).toThrow('artifact escapes');
  });

  test('detects a mutated cached payload through the manifest digest', () => {
    const gameRoot = authoredGame();
    const outputRoot = validOutput(gameRoot);
    writeFileSync(join(outputRoot, 'assets', GUID, 'mesh.bin'), 'tampered');
    expect(() => validatePreviewOutput(outputRoot, gameRoot)).toThrow('digest mismatch');
  });
});
