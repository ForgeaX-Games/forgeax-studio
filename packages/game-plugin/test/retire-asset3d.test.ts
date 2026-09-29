import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClient, type LaunchSpec } from '../src/install/clients';
import { applyConfig, inspectConfig, retireAsset3dConfig } from '../src/install/write-config';

for (const host of ['codex', 'cursor', 'opencode']) {
  test(`retires package launcher safely for ${host}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'retire-asset3d-'));
    try {
      const spec = { ...findClient(host)!, path: () => join(root, 'config') };
      const main = { command: 'node', args: ['main.js', 'mcp'] };
      const old = { command: 'npx', args: ['-y', '-p', '@forgeax/game@0.3.7', 'forgeax-game', 'asset3d', 'mcp'] };
      applyConfig(spec, root, main);
      applyConfig(spec, root, main, 'unrelated');
      applyConfig(spec, root, old, 'asset3d-search');
      const before = readFileSync(spec.path(), 'utf8');
      expect(retireAsset3dConfig(spec, root)).toBe('removed');
      expect(readFileSync(`${spec.path()}.asset3d-retired.bak`, 'utf8')).toBe(before);
      expect(inspectConfig(spec, root, main).state).toBe('current');
      expect(inspectConfig(spec, root, main, 'unrelated').state).toBe('current');
      expect(retireAsset3dConfig(spec, root)).toBe('absent');
      applyConfig(spec, root, { command: 'custom-server', args: [] }, 'asset3d-search');
      const custom = readFileSync(spec.path(), 'utf8');
      expect(retireAsset3dConfig(spec, root)).toBe('preserved');
      expect(readFileSync(spec.path(), 'utf8')).toBe(custom);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('recognizes local package identity and preserves modified or missing launchers', () => {
  const root = mkdtempSync(join(tmpdir(), 'retire-asset3d-local-'));
  try {
    const spec = { ...findClient('codex')!, path: () => join(root, 'config') };
    expect(retireAsset3dConfig(spec, root)).toBe('absent');
    expect(existsSync(spec.path())).toBeFalse();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@forgeax/game' }));
    // Ownership inspection never executes this launcher; do not infer Node from Bun's filename.
    const launch: LaunchSpec = { command: join(root, process.platform === 'win32' ? 'node.exe' : 'node'), args: [join(root, 'dist/main.js'), 'asset3d', 'mcp'] };
    applyConfig(spec, root, launch, 'asset3d-search');
    expect(retireAsset3dConfig(spec, root)).toBe('removed');
    applyConfig(spec, root, launch, 'asset3d-search');
    writeFileSync(spec.path(), readFileSync(spec.path(), 'utf8') + '\n[mcp_servers.asset3d-search.env]\nCUSTOM = "yes"\n');
    expect(retireAsset3dConfig(spec, root)).toBe('preserved');
    rmSync(spec.path());
    applyConfig(spec, root, launch, 'asset3d-search');
    rmSync(join(root, 'package.json'));
    expect(retireAsset3dConfig(spec, root)).toBe('preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
