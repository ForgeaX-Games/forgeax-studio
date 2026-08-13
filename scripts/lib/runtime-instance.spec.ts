import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveRuntimeInstancePorts,
  readRuntimeInstanceConfig,
  resolveRuntimeInstance,
  runtimeInstanceConfigPath,
  runtimeInstanceProcessEnv,
  validateRuntimeInstanceConfig,
  writeRuntimeInstanceConfig,
} from './runtime-instance.ts';

const roots: string[] = [];
function root(name: string): string {
  const value = join(tmpdir(), `forgeax-runtime-instance-${name}-${crypto.randomUUID()}`);
  mkdirSync(value, { recursive: true });
  const canonical = realpathSync(value);
  roots.push(canonical);
  return canonical;
}
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('RuntimeInstance', () => {
  test('keeps a checkout with no config on the compatible slot zero contract', () => {
    const instance = resolveRuntimeInstance({ root: root('default') });
    expect(instance.config).toBeNull();
    expect(instance.slot).toBe(0);
    expect(instance.ports).toEqual({
      server: 18900, interface: 18920, engine: 15173, reel: 15175,
      rhiReviewer: 15274, bridge: 15295, narrative: 8900, faceMask: 18930,
    });
    expect(instance.pluginPortOffset).toBe(0);
    expect(instance.reelUrl).toBe('http://127.0.0.1:15175');
    expect(instance.agentHostSocket).toBe(join(homedir(), '.forgeax', 'agent-host-18900.sock'));
    expect(instance.agentHostSocket.length).toBeLessThanOrEqual(103);
    expect(instance.assetCorsOrigins).toEqual([
      'http://localhost:18920', 'http://127.0.0.1:18920',
      'https://localhost:18920', 'https://127.0.0.1:18920',
    ]);
  });

  test('derives all instance resources from root and slot without persisting ports', () => {
    const checkout = root('slot-one');
    writeRuntimeInstanceConfig({ root: checkout, slot: 1, isolateUser: true, envFile: '/private/credentials.env' });
    const instance = resolveRuntimeInstance({ root: checkout });
    expect(instance).toMatchObject({
      slot: 1,
      projectRoot: checkout,
      stateFile: join(checkout, '.forgeax/runtime/web-dev.json'),
      logFile: join(checkout, '.forgeax/runtime/stack.log'),
      agentHostSocket: join(homedir(), '.forgeax', 'agent-host-28900.sock'),
      userDir: join(checkout, '.forgeax/user'),
      ports: { server: 28900, interface: 28920, engine: 25173, reel: 25175, rhiReviewer: 25274, bridge: 25295, narrative: 28930, faceMask: 28931 },
      pluginPortOffset: 10000,
      reelUrl: 'http://127.0.0.1:25175',
      assetCorsOrigins: [
        'http://localhost:28920', 'http://127.0.0.1:28920',
        'https://localhost:28920', 'https://127.0.0.1:28920',
      ],
    });
    expect(instance.agentHostSocket).not.toContain(checkout);
    const persisted = readFileSync(runtimeInstanceConfigPath(checkout), 'utf8');
    expect(persisted).not.toContain('port');
    expect(persisted).not.toContain('FORGEAX_API_KEY');
    expect(instance.envFile).toBe('/private/credentials.env');
  });

  test('projects every managed source-runtime value to child environment', () => {
    const checkout = root('environment');
    writeRuntimeInstanceConfig({ root: checkout, slot: 2, isolateUser: true });
    const env = runtimeInstanceProcessEnv(resolveRuntimeInstance({ root: checkout }));
    expect(env).toMatchObject({
      FORGEAX_SERVER_PORT: '38900', FORGEAX_INTERFACE_PORT: '38920', FORGEAX_ENGINE_PORT: '35173',
      FORGEAX_REEL_URL: 'http://127.0.0.1:35175', FORGEAX_RHI_REVIEWER_PORT: '35274',
      FORGEAX_BRIDGE_PORT: '35295', NARRATIVE_PORT: '38930', FACE_MASK_PORT: '38931',
      FORGEAX_PLUGIN_PORT_OFFSET: '20000',
      FORGEAX_ASSET_CORS_ORIGINS: 'http://localhost:38920,http://127.0.0.1:38920,https://localhost:38920,https://127.0.0.1:38920',
      FORGEAX_USER_DIR: join(checkout, '.forgeax/user'),
    });
  });

  test('rejects duplicate writes unless force is explicit', () => {
    const checkout = root('force');
    writeRuntimeInstanceConfig({ root: checkout, slot: 1 });
    expect(() => writeRuntimeInstanceConfig({ root: checkout, slot: 2 })).toThrow(/already exists.*--force/);
    writeRuntimeInstanceConfig({ root: checkout, slot: 2, force: true });
    expect(resolveRuntimeInstance({ root: checkout }).slot).toBe(2);
  });

  test('rejects unknown keys, unsupported schemas, malformed paths, and unsafe slots', () => {
    expect(() => validateRuntimeInstanceConfig({ schemaVersion: 1, id: 'one', slot: 1, isolateUser: false, ports: {} })).toThrow(/unknown key/);
    expect(() => validateRuntimeInstanceConfig({ schemaVersion: 2, id: 'one', slot: 1, isolateUser: false })).toThrow(/unsupported schemaVersion/);
    expect(() => validateRuntimeInstanceConfig({ schemaVersion: 1, id: 'one', slot: 5, isolateUser: false })).toThrow(/slot must be one of/);
    expect(() => validateRuntimeInstanceConfig({ schemaVersion: 1, id: 'one', slot: 1, isolateUser: false, envFile: '.env' })).toThrow(/absolute path/);
    expect(() => deriveRuntimeInstancePorts(5)).toThrow(/slot must be one of/);
  });

  test('fails explicitly when the persisted JSON is malformed', () => {
    const checkout = root('invalid-json');
    const config = runtimeInstanceConfigPath(checkout);
    mkdirSync(join(checkout, '.forgeax/runtime'), { recursive: true });
    writeFileSync(config, '{ nope');
    expect(() => readRuntimeInstanceConfig(config)).toThrow(/invalid runtime instance config/);
  });

  test('rejects a config copied from a worktree with a different root id', () => {
    const checkout = root('id-mismatch');
    writeRuntimeInstanceConfig({ root: checkout, slot: 1 });
    const config = runtimeInstanceConfigPath(checkout);
    const copiedRoot = root('copied');
    mkdirSync(join(copiedRoot, '.forgeax/runtime'), { recursive: true });
    writeFileSync(runtimeInstanceConfigPath(copiedRoot), readFileSync(config));
    expect(() => resolveRuntimeInstance({ root: copiedRoot })).toThrow(/has id .* but this worktree resolves to/);
  });

  test('rejects a copied config when both worktrees share the same basename', () => {
    const firstParent = root('first-parent');
    const secondParent = root('second-parent');
    const first = join(firstParent, 'studio');
    const second = join(secondParent, 'studio');
    mkdirSync(first); mkdirSync(second);
    writeRuntimeInstanceConfig({ root: first, slot: 1 });
    mkdirSync(join(second, '.forgeax/runtime'), { recursive: true });
    writeFileSync(runtimeInstanceConfigPath(second), readFileSync(runtimeInstanceConfigPath(first)));
    expect(() => resolveRuntimeInstance({ root: second })).toThrow(/has id .* but this worktree resolves to/);
  });

  test('always uses the root-local config path rather than an external config seam', () => {
    const checkout = root('fixed-path');
    const external = root('external-config');
    mkdirSync(join(external, '.forgeax/runtime'), { recursive: true });
    writeFileSync(join(external, '.forgeax/runtime/instance.json'), JSON.stringify({
      schemaVersion: 1, id: 'external', slot: 4, isolateUser: false,
    }));
    expect(resolveRuntimeInstance({ root: checkout }).slot).toBe(0);
    writeRuntimeInstanceConfig({ root: checkout, slot: 1 });
    expect(existsSync(runtimeInstanceConfigPath(checkout))).toBe(true);
    expect(resolveRuntimeInstance({ root: checkout }).slot).toBe(1);
  });

  test('writes the config atomically to its intended ignored runtime directory', () => {
    const checkout = root('atomic');
    const config = runtimeInstanceConfigPath(checkout);
    writeRuntimeInstanceConfig({ root: checkout, slot: 4 });
    expect(existsSync(config)).toBe(true);
    expect(readRuntimeInstanceConfig(config)).toMatchObject({ schemaVersion: 1, slot: 4, isolateUser: false });
  });
});
