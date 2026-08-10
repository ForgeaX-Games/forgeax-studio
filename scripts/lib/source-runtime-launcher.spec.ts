import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRuntimeAction,
  liveRuntimeStateForInstance,
  openRuntimeLog,
  resolveExpectedRuntimeOwners,
  resolveSourceRuntimeEnvironment,
  runtimeStateMatchesStartup,
  sourceRuntimePorts,
  sourceRuntimeStatusPorts,
} from './source-runtime-launcher.ts';
import { resolveStartupEnvironment } from './startup-environment.ts';
import { resolveRuntimeInstance, runtimeInstanceProcessEnv, writeRuntimeInstanceConfig } from './runtime-instance.ts';
import {
  runtimeStateBelongsToInstance,
  RuntimeStateStore,
  type RuntimeState,
} from './runtime-state.ts';
import { runtimeProcessBelongsToInstance } from './runtime-process-owner.ts';

const fixtureRoots: string[] = [];
const originalAgentHostSocket = process.env.FORGEAX_AGENT_HOST_SOCK;

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalAgentHostSocket === undefined) delete process.env.FORGEAX_AGENT_HOST_SOCK;
  else process.env.FORGEAX_AGENT_HOST_SOCK = originalAgentHostSocket;
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-source-launcher-'));
  fixtureRoots.push(root);
  return root;
}

function materializeRuntimePackages(root: string): void {
  mkdirSync(join(root, 'packages/server/src'), { recursive: true });
  mkdirSync(join(root, 'packages/server-override/src'), { recursive: true });
  mkdirSync(join(root, 'packages/studio'), { recursive: true });
  mkdirSync(join(root, 'packages/interface'), { recursive: true });
  writeFileSync(join(root, 'packages/server/src/main.ts'), 'export {};\n');
  writeFileSync(join(root, 'packages/server/package.json'), JSON.stringify({ name: '@forgeax/server' }));
  writeFileSync(join(root, 'packages/server-override/src/override-main.ts'), 'export {};\n');
  writeFileSync(join(root, 'packages/server-override/package.json'), JSON.stringify({
    name: '@forgeax/server-override',
    forgeaxStudio: { runtimeRole: 'server', entry: 'src/override-main.ts', priority: 10 },
  }));
}

function liveStateFixture(slot = 1): {
  root: string;
  instance: ReturnType<typeof resolveRuntimeInstance>;
  state: RuntimeState;
  childEnv: NodeJS.ProcessEnv;
} {
  const root = fixtureRoot();
  materializeRuntimePackages(root);
  writeRuntimeInstanceConfig({ root, slot });
  const instance = resolveRuntimeInstance({ root });
  const childEnv = {
    ...runtimeInstanceProcessEnv(instance),
    FORGEAX_SERVER_PROFILE: 'auto',
    STUDIO: '1',
  };
  const startup = resolveStartupEnvironment({
    root,
    profile: 'web-dev',
    env: childEnv,
  });
  const state = new RuntimeStateStore(startup, 4242, {
    server: startup.server.port,
    interface: startup.interface.port,
    engine: startup.engine.port,
  }, resolveExpectedRuntimeOwners(root, childEnv)).markReady({
    ready: true,
    checkedAt: '2026-08-09T00:00:00.000Z',
    services: {
      server: {
        ready: true,
        url: 'http://127.0.0.1:28900/api/health',
        status: 200,
      },
      interface: {
        ready: true,
        url: 'http://127.0.0.1:28920/api/health',
        status: 200,
      },
      engine: {
        ready: true,
        url: 'http://127.0.0.1:25173/preview/',
        status: 200,
      },
    },
  });
  return { root, instance, state, childEnv };
}

function ownedLauncher(instance: ReturnType<typeof resolveRuntimeInstance>) {
  return {
    pid: 4242,
    commandLine: `bun ${instance.root}/scripts/local-runtime.ts --profile web-dev`,
    cwd: instance.root,
  };
}

describe('source runtime launcher contract', () => {
  test('creates the derived runtime directory before opening the startup log', () => {
    const root = fixtureRoot();
    const logFile = join(root, '.forgeax', 'runtime', 'stack.log');

    const logFd = openRuntimeLog(logFile);
    closeSync(logFd);

    expect(existsSync(logFile)).toBe(true);
  });

  test('derives every preflight port from StartupEnvironment', () => {
    const startup = resolveStartupEnvironment({
      root: '/tmp/forgeax-source-launcher',
      profile: 'web-dev',
      env: {},
    });

    expect(sourceRuntimePorts(startup)).toEqual([
      ['server', 18900],
      ['interface', 18920],
      ['engine', 15173],
    ]);
  });

  test('keeps the retired bridge out of preflight ports for every profile', () => {
    const startup = resolveStartupEnvironment({
      root: '/tmp/forgeax-source-launcher',
      profile: 'anydev-web',
      env: {
        FORGEAX_INTERFACE_PORT: '80',
        FORGEAX_BRIDGE: '0',
      },
    });

    expect(sourceRuntimePorts(startup)).toEqual([
      ['server', 18900],
      ['interface', 80],
      ['engine', 15173],
    ]);
  });

  test('projects the resolved RuntimeInstance contract into launcher children', async () => {
    const source = await Bun.file(new URL('./source-runtime-launcher.ts', import.meta.url)).text();

    expect(source).toContain('resolveRuntimeInstance({ root })');
    expect(source).toContain('runtimeInstanceProcessEnv(instance)');
    expect(source).toContain('startupProcessEnv(startup, env)');
  });

  test('does not reintroduce a bridge port when startup explicitly disables the bridge', () => {
    const { childEnv } = resolveSourceRuntimeEnvironment('/tmp', 'web-dev', {
      FORGEAX_BRIDGE: '0',
    });

    expect(childEnv.FORGEAX_BRIDGE).toBe('0');
    expect(childEnv.FORGEAX_BRIDGE_PORT).toBeUndefined();
  });

  test('never projects the internal start-lock handoff token into service environments', () => {
    const { childEnv } = resolveSourceRuntimeEnvironment('/tmp', 'web-dev', {
      FORGEAX_START_LOCK_HANDOFF_TOKEN: 'internal-only',
    });
    expect(childEnv.FORGEAX_START_LOCK_HANDOFF_TOKEN).toBeUndefined();
  });

  test('reports optional ports from the startup contract without reserving them at start', () => {
    const startup = resolveStartupEnvironment({
      root: '/tmp/forgeax-source-launcher',
      profile: 'web-dev',
      env: {
        FORGEAX_SERVER_PORT: '28900',
        FORGEAX_INTERFACE_PORT: '28920',
        FORGEAX_ENGINE_PORT: '25173',
        NARRATIVE_PORT: '28930',
        FACE_MASK_PORT: '28931',
        FORGEAX_RHI_REVIEWER_PORT: '25274',
      },
    });

    expect(sourceRuntimePorts(startup)).toEqual([
      ['server', 28900],
      ['interface', 28920],
      ['engine', 25173],
    ]);
    expect(sourceRuntimeStatusPorts(startup)).toEqual([
      ['server', 28900],
      ['interface', 28920],
      ['engine', 25173],
      ['narrative', 28930],
      ['face-mask', 28931],
      ['rhi-reviewer', 25274],
    ]);
  });

  test('retains an explicit parent agent-host socket over the instance env file', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, '.env'), 'FORGEAX_AGENT_HOST_SOCK=/from-env-file.sock\n');

    const { childEnv } = resolveSourceRuntimeEnvironment(root, 'web-dev', {
      FORGEAX_AGENT_HOST_SOCK: '/from-parent.sock',
    });

    expect(childEnv.FORGEAX_AGENT_HOST_SOCK).toBe('/from-parent.sock');
  });

  test('uses the instance-local agent-host socket only without an explicit override', () => {
    const root = fixtureRoot();
    writeRuntimeInstanceConfig({ root, slot: 1 });

    const { childEnv } = resolveSourceRuntimeEnvironment(root, 'web-dev', {});

    expect(childEnv.FORGEAX_AGENT_HOST_SOCK).toBe(resolveRuntimeInstance({ root }).agentHostSocket);
  });

  test('uses the current instance env-file socket without mutating process.env', () => {
    const root = fixtureRoot();
    writeRuntimeInstanceConfig({ root, slot: 2 });
    writeFileSync(join(root, '.env'), 'FORGEAX_AGENT_HOST_SOCK=/from-env-file.sock\nFORGEAX_TEST_SECRET=loaded\n');
    const before = process.env.FORGEAX_TEST_SECRET;

    const { childEnv } = resolveSourceRuntimeEnvironment(root, 'web-dev', {});

    expect(childEnv.FORGEAX_AGENT_HOST_SOCK).toBe('/from-env-file.sock');
    expect(process.env.FORGEAX_TEST_SECRET).toBe(before);
  });

  test('prefers an explicit parent socket over the current instance env-file socket', () => {
    const root = fixtureRoot();
    writeRuntimeInstanceConfig({ root, slot: 2 });
    writeFileSync(join(root, '.env'), 'FORGEAX_AGENT_HOST_SOCK=/from-env-file.sock\n');

    const { childEnv } = resolveSourceRuntimeEnvironment(root, 'web-dev', {
      FORGEAX_AGENT_HOST_SOCK: '/from-parent.sock',
    });

    expect(childEnv.FORGEAX_AGENT_HOST_SOCK).toBe('/from-parent.sock');
  });

  test('re-reading after an instance env-file switch uses only the new config and dotenv socket', () => {
    const root = fixtureRoot();
    const firstEnv = join(root, 'first.env');
    const secondEnv = join(root, 'second.env');
    writeFileSync(firstEnv, 'FORGEAX_AGENT_HOST_SOCK=/first.sock\n');
    writeFileSync(secondEnv, 'FORGEAX_AGENT_HOST_SOCK=/second.sock\n');
    writeRuntimeInstanceConfig({ root, slot: 1, envFile: firstEnv });

    expect(resolveSourceRuntimeEnvironment(root, 'web-dev', {}).childEnv.FORGEAX_AGENT_HOST_SOCK).toBe('/first.sock');
    writeRuntimeInstanceConfig({ root, slot: 2, envFile: secondEnv, force: true });
    const afterSwitch = resolveSourceRuntimeEnvironment(root, 'web-dev', {}).childEnv;

    expect(afterSwitch.FORGEAX_AGENT_HOST_SOCK).toBe('/second.sock');
    expect(afterSwitch.FORGEAX_SERVER_PORT).toBe('38900');
    expect(afterSwitch.FORGEAX_RUNTIME_STATE_FILE).toContain('/runtime/web-dev.json');
  });

  test('freezes parent-over-dotenv precedence into the detached child startup contract', () => {
    const root = fixtureRoot();
    materializeRuntimePackages(root);
    writeRuntimeInstanceConfig({ root, slot: 1 });
    writeFileSync(join(root, '.env'), [
      'FORGEAX_INTERFACE_HTTPS=1',
      'FORGEAX_PUBLIC_ORIGIN=https://from-dotenv.example',
      'NON_MANAGED_VALUE=from-dotenv',
    ].join('\n'));
    const suppliedEnv = {
      FORGEAX_INTERFACE_HTTPS: '0',
      FORGEAX_PUBLIC_ORIGIN: 'http://from-parent.example',
      NON_MANAGED_VALUE: 'from-parent',
      FORGEAX_SERVER_PROFILE: 'base',
      STUDIO: '1',
    };

    const { startup, childEnv } = resolveSourceRuntimeEnvironment(root, 'web-dev', suppliedEnv);
    const detachedStartup = resolveStartupEnvironment({ root, profile: 'web-dev', env: childEnv });
    const owners = resolveExpectedRuntimeOwners(root, childEnv);
    const state = new RuntimeStateStore(startup, 4242, {
      server: startup.server.port,
      interface: startup.interface.port,
      engine: startup.engine.port,
    }, owners).writeStarting();

    expect(startup.interface.protocol).toBe('http');
    expect(startup.interface.publicOrigin).toBe('http://from-parent.example');
    expect(childEnv.FORGEAX_INTERFACE_HTTPS).toBe('0');
    expect(childEnv.NON_MANAGED_VALUE).toBe('from-parent');
    expect(detachedStartup).toEqual(startup);
    expect(ensureRuntimeAction(state, detachedStartup, owners)).toBe('reuse');
  });

  test('accepts only a same-instance live state whose launcher PID is owned by this root', () => {
    const { instance, state } = liveStateFixture();
    const snapshot = ownedLauncher(instance);
    expect(runtimeStateBelongsToInstance(instance, state)).toBe(true);
    expect(runtimeProcessBelongsToInstance(snapshot, {
      root: instance.root,
      service: 'launcher',
    })).toBe(true);
    expect(
      liveRuntimeStateForInstance(instance, {
        readState: () => state,
        isAlive: () => true,
        readProcessSnapshot: () => snapshot,
      }),
    ).toBe(state);
  });

  test('fails closed for copied/core-drifted state, dead PIDs, and reused unrelated PIDs', () => {
    const owner = liveStateFixture();
    const other = liveStateFixture(2);
    const owned = ownedLauncher(owner.instance);
    const liveDeps = {
      isAlive: () => true,
      readProcessSnapshot: () => owned,
    };

    expect(
      liveRuntimeStateForInstance(other.instance, {
        ...liveDeps,
        readState: () => owner.state,
      }),
    ).toBeNull();
    expect(
      liveRuntimeStateForInstance(owner.instance, {
        ...liveDeps,
        readState: () => ({
          ...owner.state,
          startup: {
            ...owner.state.startup,
            server: { ...owner.state.startup.server, port: 28901 },
          },
        }),
      }),
    ).toBeNull();
    expect(
      liveRuntimeStateForInstance(owner.instance, {
        readState: () => owner.state,
        isAlive: () => false,
        readProcessSnapshot: () => owned,
      }),
    ).toBeNull();
    expect(
      liveRuntimeStateForInstance(owner.instance, {
        readState: () => owner.state,
        isAlive: () => true,
        readProcessSnapshot: () => ({
          ...owned,
          commandLine: 'bun scripts/unrelated.ts',
        }),
      }),
    ).toBeNull();
  });

  test('allows ensure reuse only for an exactly matching startup contract', () => {
    const { root, instance, state, childEnv } = liveStateFixture();
    const startup = state.startup;
    const anydevStartup = resolveStartupEnvironment({
      root: instance.root,
      profile: 'anydev-web',
      env: {
        ...runtimeInstanceProcessEnv(instance),
        FORGEAX_PUBLIC_ORIGIN: 'https://current.anydev.example',
        FORGEAX_HMR_CLIENT_PORT: '443',
        FORGEAX_STANDALONE_PROXY: '1',
        FORGEAX_INTERFACE_ALLOWED_HOSTS: '.anydev.example',
      },
    });

    const expectedOwners = resolveExpectedRuntimeOwners(root, childEnv);
    expect(runtimeStateMatchesStartup(state, structuredClone(startup), expectedOwners)).toBe(true);
    expect(ensureRuntimeAction(state, structuredClone(startup), expectedOwners)).toBe('reuse');
    expect(ensureRuntimeAction(state, anydevStartup, expectedOwners)).toBe('restart');
    const incompatible = [
      { ...startup, profile: 'anydev-web' },
      {
        ...startup,
        interface: { ...startup.interface, publicOrigin: 'https://different.example' },
      },
      { ...startup, hmrClientPort: startup.hmrClientPort + 1 },
      { ...startup, standaloneProxy: !startup.standaloneProxy },
      { ...startup, allowedHosts: 'different.example' },
      { ...startup, server: { ...startup.server, host: '127.0.0.2' } },
      { ...startup, projectRoot: join(startup.projectRoot, 'different') },
      { ...startup, resourceRoot: join(startup.resourceRoot, 'different') },
      { ...startup, envFile: `${startup.envFile}.different` },
      { ...startup, stateFile: join(startup.projectRoot, 'different-state.json') },
      { ...startup, logFile: `${startup.logFile}.different` },
      { ...startup, server: { ...startup.server, port: startup.server.port + 1 } },
      { ...startup, interface: { ...startup.interface, port: startup.interface.port + 1 } },
      { ...startup, engine: { ...startup.engine, port: startup.engine.port + 1 } },
      {
        ...startup,
        optional: { ...startup.optional, narrativePort: startup.optional.narrativePort + 1 },
      },
      {
        ...startup,
        optional: { ...startup.optional, faceMaskPort: startup.optional.faceMaskPort + 1 },
      },
      {
        ...startup,
        optional: { ...startup.optional, rhiReviewerPort: startup.optional.rhiReviewerPort + 1 },
      },
      {
        ...startup,
        optional: { ...startup.optional, reelUrl: `${startup.optional.reelUrl}/different` },
      },
      {
        ...startup,
        optional: { ...startup.optional, pluginPortOffset: startup.optional.pluginPortOffset + 1 },
      },
      { ...startup, assetCorsOrigins: [...startup.assetCorsOrigins, 'https://different.example'] },
      { ...startup, agentHostSocket: `${startup.agentHostSocket}.different` },
      {
        ...startup,
        gatewayBridge: { ...startup.gatewayBridge, enabled: !startup.gatewayBridge.enabled },
      },
      {
        ...startup,
        supervision: { ...startup.supervision, maxRestarts: startup.supervision.maxRestarts + 1 },
      },
      { ...startup, startupTimeoutMs: startup.startupTimeoutMs + 1 },
    ] as const;

    for (const candidate of incompatible) {
      expect(runtimeStateMatchesStartup(state, candidate as typeof startup, expectedOwners)).toBe(false);
      expect(ensureRuntimeAction(state, candidate as typeof startup, expectedOwners)).toBe('restart');
    }

    const baseServerOwners = resolveExpectedRuntimeOwners(root, {
      ...childEnv,
      FORGEAX_SERVER_PROFILE: 'base',
    });
    const interfaceOwners = resolveExpectedRuntimeOwners(root, {
      ...childEnv,
      STUDIO: '0',
    });
    expect(ensureRuntimeAction(state, startup, baseServerOwners)).toBe('restart');
    expect(ensureRuntimeAction(state, startup, interfaceOwners)).toBe('restart');
  });
});
