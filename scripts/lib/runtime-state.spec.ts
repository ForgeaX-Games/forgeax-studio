import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRuntimeState,
  RuntimeStateStore,
  runtimePathRelation,
  runtimeStateBelongsToInstance,
} from './runtime-state.ts';
import {
  resolveRuntimeInstance,
  runtimeInstanceProcessEnv,
  writeRuntimeInstanceConfig,
} from './runtime-instance.ts';
import { resolveStartupEnvironment } from './startup-environment.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RuntimeState contract', () => {
  test('records all actual Studio-managed listeners and accepts a remote AnyDev public origin', () => {
    const { instance, startup } = fixture(1, 'https://studio.example.test');
    const state = new RuntimeStateStore(startup, 123, {
      server: startup.server.port,
      interface: startup.interface.port,
      engine: startup.engine.port,
      'extension-demo': 40_001,
    }).writeStarting();

    expect(state.managedPorts).toEqual({
      server: 28_900,
      interface: 28_920,
      engine: 25_173,
      'extension-demo': 40_001,
    });
    expect(readRuntimeState(startup.stateFile)).not.toBeNull();
    expect(runtimeStateBelongsToInstance(instance, readRuntimeState(startup.stateFile))).toBe(true);
  });

  test('rejects state from another root and every instance-owned path drift', () => {
    const owner = fixture(1);
    const other = fixture(2);
    new RuntimeStateStore(owner.startup, 123).writeStarting();

    expect(runtimeStateBelongsToInstance(other.instance, readRuntimeState(owner.startup.stateFile))).toBe(false);
    for (const field of ['projectRoot', 'stateFile', 'envFile', 'logFile'] as const) {
      const state = readRuntimeState(owner.startup.stateFile);
      if (!state) throw new Error('expected state fixture');
      const drifted = {
        ...state,
        startup: { ...state.startup, [field]: join(owner.instance.root, `drifted-${field}`) },
      };
      expect(runtimeStateBelongsToInstance(owner.instance, drifted)).toBe(false);
    }
  });

  test('rejects core-port drift but does not constrain a valid external public origin', () => {
    const { instance, startup } = fixture(1, 'https://public.anydev.example');
    new RuntimeStateStore(startup, 123).writeStarting();
    const state = readRuntimeState(startup.stateFile);
    if (!state) throw new Error('expected state fixture');

    expect(runtimeStateBelongsToInstance(instance, state)).toBe(true);
    expect(runtimeStateBelongsToInstance(instance, {
      ...state,
      startup: { ...state.startup, server: { ...state.startup.server, port: 28_901 } },
    })).toBe(false);
  });

  test('accepts an explicit reverse-proxy HMR port with an external AnyDev origin, but not another root', () => {
    const owner = fixture(1, 'https://public.anydev.example', { FORGEAX_HMR_CLIENT_PORT: '443' });
    const other = fixture(2, 'https://public.anydev.example', { FORGEAX_HMR_CLIENT_PORT: '443' });
    new RuntimeStateStore(owner.startup, 123).writeStarting();
    const state = readRuntimeState(owner.startup.stateFile);
    if (!state) throw new Error('expected state fixture');

    expect(state.startup.hmrClientPort).toBe(443);
    expect(runtimeStateBelongsToInstance(owner.instance, state)).toBe(true);
    expect(runtimeStateBelongsToInstance(other.instance, state)).toBe(false);
  });

  test('requires the complete projected optional and CORS contract, while allowing absent optional listeners', () => {
    const { instance, startup } = fixture(1, 'https://public.anydev.example');
    new RuntimeStateStore(startup, 123).writeStarting();
    const state = readRuntimeState(startup.stateFile);
    if (!state) throw new Error('expected state fixture');

    expect(runtimeStateBelongsToInstance(instance, state)).toBe(true);
    for (const startupDrift of [
      { optional: { ...state.startup.optional, narrativePort: 28_932 } },
      { optional: { ...state.startup.optional, faceMaskPort: 28_933 } },
      { optional: { ...state.startup.optional, rhiReviewerPort: 25_275 } },
      { optional: { ...state.startup.optional, reelUrl: 'http://127.0.0.1:25176' } },
      { optional: { ...state.startup.optional, pluginPortOffset: 10_001 } },
      { assetCorsOrigins: [...state.startup.assetCorsOrigins, 'https://unexpected.example'] },
      { resourceRoot: join(instance.root, 'not-the-source-root') },
      { resourceRoot: join(instance.root, 'missing-resource-parent', 'packages') },
    ]) {
      expect(runtimeStateBelongsToInstance(instance, {
        ...state,
        startup: { ...state.startup, ...startupDrift },
      })).toBe(false);
    }
  });

  test('accepts absent optional listeners but rejects mislabeled narrative and RHI managed ports', () => {
    const { instance, startup } = fixture(1);
    const state = new RuntimeStateStore(startup, 123).writeStarting();

    expect(runtimeStateBelongsToInstance(instance, state)).toBe(true);
    expect(runtimeStateBelongsToInstance(instance, {
      ...state,
      managedPorts: { ...state.managedPorts, narrative: 40_001 },
    })).toBe(false);
    expect(runtimeStateBelongsToInstance(instance, {
      ...state,
      managedPorts: { ...state.managedPorts, 'rhi-reviewer': 40_002 },
    })).toBe(false);
  });

  test('fails closed for illegal, duplicate, or bridge managed ports', () => {
    const { startup } = fixture(1);
    new RuntimeStateStore(startup, 123).writeStarting();
    const document = JSON.parse(readFileSync(startup.stateFile, 'utf8')) as Record<string, unknown>;

    for (const managedPorts of [
      { server: 28_900, interface: 28_920, engine: 0 },
      { server: 28_900, interface: 28_900, engine: 25_173 },
      { server: 28_900, interface: 28_920, engine: 25_173, bridge: 25_295 },
    ]) {
      writeFileSync(startup.stateFile, JSON.stringify({ ...document, managedPorts }));
      expect(readRuntimeState(startup.stateFile)).toBeNull();
    }
  });

  test('uses an explicit no-fallback version policy', () => {
    const { startup } = fixture(1);
    new RuntimeStateStore(startup, 123).writeStarting();
    const document = JSON.parse(readFileSync(startup.stateFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(startup.stateFile, JSON.stringify({ ...document, schemaVersion: 2 }));

    expect(readRuntimeState(startup.stateFile)).toBeNull();
  });

  test('requires an exact persisted server and interface owner identity', () => {
    const { instance, startup } = fixture(1);
    const owners = {
      server: { packageDir: join(instance.root, 'packages/server-override'), entry: 'src/override-main.ts' },
      interface: { dir: join(instance.root, 'packages/interface') },
    };
    new RuntimeStateStore(startup, 123, {
      server: startup.server.port,
      interface: startup.interface.port,
      engine: startup.engine.port,
    }, owners).writeStarting();
    const document = JSON.parse(readFileSync(startup.stateFile, 'utf8')) as Record<string, unknown>;

    expect(readRuntimeState(startup.stateFile)?.owners).toEqual(owners);
    for (const malformed of [
      { ...document, owners: { server: owners.server } },
      { ...document, owners: { ...owners, interface: { ...owners.interface, extra: true } } },
      { ...document, owners: { ...owners, server: { ...owners.server, entry: '../main.ts' } } },
    ]) {
      writeFileSync(startup.stateFile, JSON.stringify(malformed));
      expect(readRuntimeState(startup.stateFile)).toBeNull();
    }
  });

  test('rejects an owner identity copied from another root or outside this packages directory', () => {
    const owner = fixture(1);
    const other = fixture(2);
    const state = new RuntimeStateStore(owner.startup, 123).writeStarting();

    expect(runtimeStateBelongsToInstance(other.instance, state)).toBe(false);
    expect(runtimeStateBelongsToInstance(owner.instance, {
      ...state,
      owners: { ...state.owners, server: { ...state.owners.server, packageDir: join(owner.instance.root, 'outside') } },
    })).toBe(false);
  });

  test('authorizes only the base role or exact declared override metadata', () => {
    const { instance, startup } = fixture(1);
    writeServerRole(instance.root, 'server-override', 'src/override-main.ts', {
      runtimeRole: 'server', entry: 'src/override-main.ts', priority: 10,
    });
    writeServerRole(instance.root, 'unrelated', 'src/main.ts');
    writeServerRole(instance.root, 'server-mismatch', 'src/actual.ts', {
      runtimeRole: 'server', entry: 'src/declared.ts', priority: 10,
    });
    const ports = { server: startup.server.port, interface: startup.interface.port, engine: startup.engine.port };
    const overrideState = new RuntimeStateStore(startup, 123, ports, {
      server: { packageDir: join(instance.root, 'packages/server-override'), entry: 'src/override-main.ts' },
      interface: { dir: join(instance.root, 'packages/interface') },
    }).writeStarting();
    expect(runtimeStateBelongsToInstance(instance, overrideState)).toBe(true);
    for (const owners of [
      { ...overrideState.owners, server: { packageDir: join(instance.root, 'packages/unrelated'), entry: 'src/main.ts' } },
      { ...overrideState.owners, server: { packageDir: join(instance.root, 'packages/server-mismatch'), entry: 'src/actual.ts' } },
    ]) {
      expect(runtimeStateBelongsToInstance(instance, { ...overrideState, owners })).toBe(false);
    }
  });

  test('compares Windows owner paths by canonical components, not prefixes', () => {
    const server = 'C:\\Studio\\packages\\server';
    expect(runtimePathRelation('C:\\Studio\\packages', server)).toBe('within');
    expect(runtimePathRelation(server, 'C:\\Studio\\packages\\server\\src\\main.ts')).toBe('within');
    expect(runtimePathRelation(server, 'C:\\Studio\\packages\\server')).toBe('same');
    expect(runtimePathRelation(server, 'C:\\Studio\\packages\\server-other\\src\\main.ts')).toBe('outside');
    expect(runtimePathRelation(server, 'C:\\Studio\\packages\\server\\..\\outside\\main.ts')).toBe('outside');
    expect(runtimePathRelation(server, 'D:\\Studio\\packages\\server\\src\\main.ts')).toBe('outside');
    expect(runtimePathRelation(server, '/tmp/forgeax/packages/server/src/main.ts')).toBe('outside');
  });
});

function fixture(slot: number, publicOrigin?: string, overrides: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), `forgeax-runtime-state-slot-${slot}-`));
  roots.push(root);
  writeServerRole(root, 'server', 'src/main.ts');
  writeRuntimeInstanceConfig({ root, slot });
  const instance = resolveRuntimeInstance({ root });
  const startup = resolveStartupEnvironment({
    root,
    profile: 'anydev-web',
    env: {
      ...runtimeInstanceProcessEnv(instance),
      FORGEAX_BRIDGE: '0',
      ...(publicOrigin === undefined ? {} : { FORGEAX_PUBLIC_ORIGIN: publicOrigin }),
      ...overrides,
    },
  });
  return { instance, startup };
}

function writeServerRole(root: string, directory: string, entry: string, metadata?: unknown): void {
  const packageDir = join(root, 'packages', directory);
  const entryPath = join(packageDir, entry);
  mkdirSync(join(entryPath, '..'), { recursive: true });
  writeFileSync(entryPath, '');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: `@forgeax/${directory}`,
    ...(metadata === undefined ? {} : { forgeaxStudio: metadata }),
  }));
}
