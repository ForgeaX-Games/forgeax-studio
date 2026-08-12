import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { resolveRuntimeInstance, runtimeInstanceProcessEnv, writeRuntimeInstanceConfig } from './lib/runtime-instance.ts';
import { cleanupStopArtifacts, instanceStopCleanupPaths, resolveInstanceStopScope } from './lib/stop-scope.ts';
import { RuntimeStateStore } from './lib/runtime-state.ts';
import { resolveStartupEnvironment } from './lib/startup-environment.ts';
import { canFinalizeStop, discoverStopTargets } from './lib/stop-execution.ts';
import { runtimeProcessBelongsToInstance } from './lib/runtime-process-owner.ts';
import { readStartLockOwner, StartLock } from './lib/startlock.ts';

function instance(slot: number) {
  const root = mkdtempSync(join(tmpdir(), `forgeax-stop-slot-${slot}-`));
  writeServerRole(root, 'server', 'src/main.ts');
  if (slot !== 0) writeRuntimeInstanceConfig({ root, slot });
  return resolveRuntimeInstance({ root });
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

function stateFor(target: ReturnType<typeof resolveRuntimeInstance>) {
  const startup = resolveStartupEnvironment({ root: target.root, profile: 'web-dev', env: { ...runtimeInstanceProcessEnv(target), FORGEAX_BRIDGE: '0' } });
  const state = new RuntimeStateStore(startup, 101, {
    server: target.ports.server,
    interface: target.ports.interface,
    engine: target.ports.engine,
    narrative: target.ports.narrative,
    'plugin-lowpoly-frontend': 41_001,
    'plugin-lowpoly-backend': 41_002,
  }).writeStarting();
  return { ...state, servicePids: { server: 102, interface: 103 } };
}

function scope(target: ReturnType<typeof resolveRuntimeInstance>, state: ReturnType<typeof stateFor> | null) {
  return resolveInstanceStopScope(target, state, {
    activeServer: { packageDir: join(target.root, 'packages/server'), entry: 'src/main.ts' },
    interfaceDir: join(target.root, 'packages/studio'),
    plugins: new Map([['lowpoly', { shortId: 'lowpoly', dir: join(target.root, 'packages/marketplace/extensions/wb-lowpoly-obj'), commands: ['dev', 'serve'] }]]),
  });
}

function recoveryScope(target: ReturnType<typeof resolveRuntimeInstance>) {
  return resolveInstanceStopScope(target, null, {
    activeServer: { packageDir: join(target.root, 'packages/server'), entry: 'src/main.ts' },
    interfaceDir: join(target.root, 'packages/studio'),
  });
}

function pluginFixture(target: ReturnType<typeof resolveRuntimeInstance>, id = '@forgeax/lowpoly') {
  const dir = join(target.root, 'packages/marketplace/extensions/wb-lowpoly-obj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'forgeax-extension.json'), JSON.stringify({ id, entry: { standalone: { embeddedAlso: false, start: 'dev' } } }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  return dir;
}

function writeRecovery(target: ReturnType<typeof resolveRuntimeInstance>, map: unknown, stack = '') {
  mkdirSync(join(target.root, '.forgeax'), { recursive: true });
  writeFileSync(join(target.root, '.forgeax/extension-dev-ports.json'), typeof map === 'string' ? map : JSON.stringify(map));
  if (stack !== '') writeFileSync(join(target.root, '.forgeax/dev-stack.env'), stack);
}

function writeLock(target: ReturnType<typeof resolveRuntimeInstance>, pid: number, token = '01234567-89ab-cdef-0123-456789abcdef') {
  const lock = join(target.root, '.forgeax/run.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid, token }));
}

describe('instance-scoped stop discovery', () => {
  test('slot 1 without state scans only slot 1 derived ports, never slot 0', () => {
    const slot1 = instance(1);
    const slot0 = instance(0);
    const result = scope(slot1, null);

    expect(result.pids).toEqual([]);
    expect(result.ports.map(({ port }) => port)).toContain(slot1.ports.server);
    expect(result.ports.map(({ port }) => port)).not.toContain(slot0.ports.server);
    expect(result.ports.map(({ port }) => port)).not.toContain(slot0.ports.interface);
    expect(result.ports.map(({ port }) => port)).not.toContain(slot1.ports.bridge);
  });

  test('rejects a valid-looking state copied from another canonical root', () => {
    const owner = instance(1);
    const target = instance(2);
    const copied = stateFor(owner);
    const result = scope(target, copied);

    expect(result.state).toBeNull();
    expect(result.pids).toEqual([]);
    expect(result.ports.map(({ port }) => port)).toContain(target.ports.server);
    expect(result.ports.map(({ port }) => port)).not.toContain(owner.ports.server);
  });

  test('accepts only matching current-instance state and retains its PID set', () => {
    const target = instance(1);
    const result = scope(target, stateFor(target));

    expect(result.state).not.toBeNull();
    expect(result.pids.map(({ pid }) => pid)).toEqual([101, 102, 103]);
    expect(result.ports.map(({ port }) => port)).toContain(target.ports.server);
    expect(result.ports.map(({ port }) => port)).toContain(41_001);
  });

  test('uses persisted orphan owners instead of a later empty-shell base/studio guess', () => {
    const target = instance(1);
    writeServerRole(target.root, 'server-override', 'src/override-main.ts', {
      runtimeRole: 'server', entry: 'src/override-main.ts', priority: 10,
    });
    const startup = resolveStartupEnvironment({ root: target.root, profile: 'web-dev', env: { ...runtimeInstanceProcessEnv(target), FORGEAX_BRIDGE: '0' } });
    const state = new RuntimeStateStore(startup, 101, {
      server: target.ports.server,
      interface: target.ports.interface,
      engine: target.ports.engine,
    }, {
      server: { packageDir: join(target.root, 'packages/server-override'), entry: 'src/override-main.ts' },
      interface: { dir: join(target.root, 'packages/interface') },
    });
    state.setServicePid('server', 102);
    const persisted = state.setServicePid('interface', 103);

    // These options represent the normal stop shell after its STUDIO/profile
    // variables have disappeared. The state identity must win for both PIDs
    // and listener contracts.
    const result = scope(target, persisted);
    const server = result.pids.find((item) => item.key === 'server')!.owners[0]!;
    const interfaceOwner = result.pids.find((item) => item.key === 'interface')!.owners[0]!;
    expect(server.activeServer).toEqual({ packageDir: join(target.root, 'packages/server-override'), entry: 'src/override-main.ts' });
    expect(interfaceOwner.interfaceDir).toBe(join(target.root, 'packages/interface'));
    expect(result.ports.find((item) => item.key === 'server')!.owner.activeServer).toEqual(server.activeServer);
    expect(result.ports.find((item) => item.key === 'interface')!.owner.interfaceDir).toBe(interfaceOwner.interfaceDir);
  });

  test('missing state recovers the persisted base server and interface owners without shell guesses', () => {
    const target = instance(1);
    writeServerRole(target.root, 'server-override', 'src/override-main.ts', {
      runtimeRole: 'server', entry: 'src/override-main.ts', priority: 10,
    });
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, [
      `FORGEAX_RUN_SERVER_PACKAGE_DIR="${join(target.root, 'packages/server')}"`,
      'FORGEAX_RUN_SERVER_ENTRY="src/main.ts"',
      `FORGEAX_RUN_INTERFACE_DIR="${join(target.root, 'packages/interface')}"`,
      'FORGEAX_RUN_PIDS="702 703"',
    ].join('\n'));
    const result = scope(target, null);
    const server = result.ports.find((item) => item.key === 'server')!.owner;
    const interfaceOwner = result.ports.find((item) => item.key === 'interface')!.owner;
    expect(server.activeServer).toEqual({ packageDir: join(target.root, 'packages/server'), entry: 'src/main.ts' });
    expect(interfaceOwner.interfaceDir).toBe(join(target.root, 'packages/interface'));
    expect(result.pids.every((pidTarget) => pidTarget.owners.some((owner) => owner.activeServer?.packageDir === join(target.root, 'packages/server') || owner.interfaceDir === join(target.root, 'packages/interface')))).toBe(true);
  });

  test('partial or forged recovery owner evidence blocks cleanup and never falls back to shell owners', () => {
    const target = instance(1);
    const forged = join(target.root, 'packages/unrelated');
    writeServerRole(target.root, 'unrelated', 'src/main.ts');
    for (const stack of [
      `FORGEAX_RUN_SERVER_PACKAGE_DIR="${join(target.root, 'packages/server')}"\n`,
      [
        `FORGEAX_RUN_SERVER_PACKAGE_DIR="${forged}"`,
        'FORGEAX_RUN_SERVER_ENTRY="src/main.ts"',
        `FORGEAX_RUN_INTERFACE_DIR="${join(target.root, 'packages/interface')}"`,
        'FORGEAX_RUN_PIDS="702"',
      ].join('\n'),
    ]) {
      writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, stack);
      const result = scope(target, null);
      expect(result.untrusted).toBe(true);
      expect(result.ports.map((item) => item.key)).not.toContain('server');
      expect(result.pids).toEqual([]);
    }
  });

  test('recovery discovery accepts real Node-local Vite interface and engine listeners', () => {
    const target = instance(1);
    const interfaceDir = join(target.root, 'packages/interface');
    const engineDir = join(target.root, 'packages/editor/packages/play-runtime');
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, [
      `FORGEAX_RUN_SERVER_PACKAGE_DIR="${join(target.root, 'packages/server')}"`,
      'FORGEAX_RUN_SERVER_ENTRY="src/main.ts"',
      `FORGEAX_RUN_INTERFACE_DIR="${interfaceDir}"`,
    ].join('\n'));
    const result = scope(target, null);
    const snapshots = new Map([
      [811, { pid: 811, commandLine: `node ${interfaceDir}/node_modules/.bin/vite`, cwd: interfaceDir }],
      [812, { pid: 812, commandLine: `node ${engineDir}/node_modules/.bin/vite`, cwd: engineDir }],
    ]);
    const discovery = discoverStopTargets(result, {
      listenPids: (port) => port === target.ports.interface ? [811] : port === target.ports.engine ? [812] : [],
      readSnapshot: (pid) => snapshots.get(pid) ?? null,
      owns: runtimeProcessBelongsToInstance,
      isAlive: () => false,
      isPortBusy: () => false,
    });
    expect(discovery.found.get(811)).toBe('interface');
    expect(discovery.found.get(812)).toBe('engine');
  });

  test('missing-state recovery classifies a persisted headless renderer PID by its exact plugin contract', () => {
    const target = instance(1);
    const pluginDir = pluginFixture(target);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="913"\n');
    const result = recoveryScope(target);
    const headless = result.pids.find((target) => target.pid === 913)!;
    expect(headless.owners.some((owner) => owner.service === 'plugin-headless')).toBe(true);
    const exact = { pid: 913, commandLine: 'node scripts/headless-renderer.mjs', cwd: pluginDir };
    const foreign = { pid: 913, commandLine: 'node scripts/headless-renderer.mjs', cwd: `${pluginDir}-copy` };
    expect(headless.owners.some((owner) => runtimeProcessBelongsToInstance(exact, owner))).toBe(true);
    expect(headless.owners.some((owner) => runtimeProcessBelongsToInstance(foreign, owner))).toBe(false);
  });

  test('run persists non-zero headless renderer PIDs into dev-stack recovery evidence', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/run.ts'), 'utf8');
    expect(source).toContain('const headlessPids: number[] = [];');
    expect(source).toContain('if (headlessPid > 0) headlessPids.push(headlessPid);');
    expect(source).toContain('...extensionPids, ...headlessPids');
  });

  test('cleanup paths are confined to the current project root', () => {
    const a = instance(1);
    const b = instance(2);
    const paths = Object.values(instanceStopCleanupPaths(a));

    expect(paths.every((path) => path === a.projectRoot || path.startsWith(`${a.projectRoot}/`))).toBe(true);
    expect(paths.some((path) => path === b.projectRoot || path.startsWith(`${b.projectRoot}/`))).toBe(false);
    expect(paths).toContain(a.stateFile);
  });

  test('production discovery explains and refuses an unrelated listener by default', () => {
    const target = instance(1);
    const result = scope(target, stateFor(target));
    const port = result.ports[0]!;
    const foreign = discoverStopTargets(result, {
      listenPids: (candidate) => candidate === port.port ? [77] : [],
      readSnapshot: () => ({ pid: 77, commandLine: 'vite --port 28900', cwd: '/other/worktree' }),
      owns: () => false,
      isAlive: () => false,
      isPortBusy: (candidate) => candidate === port.port,
    });
    expect(foreign.found.size).toBe(0);
    expect(foreign.refusedPorts).toContain(port.port);
    expect(foreign.refusals).toEqual([{
      pid: 77,
      source: `:${port.port} server`,
      reason: 'ownership-unproven',
      cwd: '/other/worktree',
    }]);
    expect(foreign.blocked).toBe(true);

    const forced = discoverStopTargets(result, {
      listenPids: (candidate) => candidate === port.port ? [77] : [],
      readSnapshot: () => null,
      owns: () => false,
      isAlive: () => false,
      isPortBusy: () => false,
      forceUnowned: true,
    });
    expect(forced.found.get(77)).toBe('server');
    expect(forced.blocked).toBe(false);

    const protectedListener = discoverStopTargets(result, {
      listenPids: (candidate) => candidate === port.port ? [79] : [],
      readSnapshot: () => null,
      owns: () => false,
      isAlive: () => false,
      isPortBusy: () => true,
      protectedPids: new Set([79]),
      forceUnowned: true,
    });
    expect(protectedListener.found.size).toBe(0);
    expect(protectedListener.refusedPorts).toContain(port.port);
    expect(protectedListener.blocked).toBe(true);

    const owned = discoverStopTargets(result, {
      listenPids: (candidate) => candidate === port.port ? [78] : [],
      readSnapshot: () => ({ pid: 78, commandLine: 'x', cwd: 'x' }),
      owns: () => true,
      isAlive: () => false,
      isPortBusy: () => false,
    });
    expect(owned.found.get(78)).toBe('server');
  });

  test('unknown live declared resources and post-force non-listener survivors block final cleanup', () => {
    const target = instance(1);
    const result = scope(target, stateFor(target));
    const unknown = { ...result, unprovenPorts: [49_001], unprovenPids: [901] };
    const emptyDiscovery = { found: new Map<number, string>(), refusedPorts: new Set<number>(), refusedPids: new Set<number>() };
    expect(canFinalizeStop(unknown, emptyDiscovery, {
      isAlive: (pid) => pid === 901,
      isPortBusy: (port) => port === 49_001,
    })).toBe(false);
    expect(canFinalizeStop(result, {
      ...emptyDiscovery,
      found: new Map([[902, 'launcher']]),
    }, {
      isAlive: (pid) => pid === 902,
      isPortBusy: () => false,
    })).toBe(false);
  });

  test('known live unowned and protected owned state PIDs block cleanup', () => {
    const target = instance(1);
    const result = scope(target, stateFor(target));
    const pid = result.pids[0]!.pid;
    const base = {
      listenPids: () => [],
      readSnapshot: () => null,
      isAlive: (candidate: number) => candidate === pid,
      isPortBusy: () => false,
    };
    const unowned = discoverStopTargets(result, { ...base, owns: () => false });
    expect(unowned.refusedPids).toContain(pid);
    expect(canFinalizeStop(result, unowned, base)).toBe(false);
    const protectedOwned = discoverStopTargets(result, {
      ...base,
      owns: () => true,
      protectedPids: new Set([pid]),
    });
    expect(protectedOwned.blocked).toBe(true);
    expect(canFinalizeStop(result, protectedOwned, base)).toBe(false);

    const forced = discoverStopTargets(result, { ...base, owns: () => false, forceUnowned: true });
    expect(forced.found.get(pid)).toBe('launcher');
    expect(forced.refusedPids.size).toBe(0);
  });

  test('missing state consumes current-root extension map as typed recovery evidence', () => {
    const a = instance(1); pluginFixture(a);
    writeRecovery(a, { generatedBy: 'scripts/local-runtime.ts', plugins: { '@forgeax/lowpoly': { frontendPort: 41_001, backendPort: 41_002 } } }, 'FORGEAX_RUN_PORTS="41001 41002"\nFORGEAX_RUN_PIDS="777"\n');
    const result = recoveryScope(a);
    expect(result.ports.map((target) => target.key)).toContain('plugin-lowpoly-frontend');
    expect(result.ports.map((target) => target.key)).toContain('plugin-lowpoly-backend');
    const discovery = discoverStopTargets(result, { listenPids: (port) => port === 41_001 ? [71] : [], readSnapshot: () => ({ pid: 71, commandLine: 'vite', cwd: join(a.root, 'packages/marketplace/extensions/wb-lowpoly-obj') }), owns: () => true, isAlive: (pid) => pid === 777, isPortBusy: (port) => port === 41_001 });
    expect(discovery.found.get(71)).toBe('plugin-lowpoly-frontend');
    expect(discovery.blocked).toBe(false);
  });

  test('copied map never authorizes a B plugin snapshot and malformed recovery blocks cleanup', () => {
    const a = instance(1); const b = instance(2); pluginFixture(a); pluginFixture(b);
    writeRecovery(a, { generatedBy: 'scripts/local-runtime.ts', plugins: { '@forgeax/lowpoly': { frontendPort: 41_011, backendPort: 41_012 } } });
    const target = recoveryScope(a).ports.find((port) => port.key === 'plugin-lowpoly-frontend')!;
    expect(runtimeProcessBelongsToInstance({ pid: 88, commandLine: 'vite', cwd: join(b.root, 'packages/marketplace/extensions/wb-lowpoly-obj') }, target.owner)).toBe(false);
    writeRecovery(a, '{broken'); const malformed = recoveryScope(a);
    const empty = { found: new Map<number, string>(), refusedPorts: new Set<number>(), refusedPids: new Set<number>() };
    expect(malformed.untrusted).toBe(true); expect(canFinalizeStop(malformed, empty, { isAlive: () => false, isPortBusy: () => false })).toBe(false);
  });

  test('well-formed stale recovery files permit cleanup only when all records are inactive', () => {
    const a = instance(1); pluginFixture(a);
    writeRecovery(a, { generatedBy: 'scripts/local-runtime.ts', plugins: { '@forgeax/lowpoly': { frontendPort: 41_021, backendPort: 41_022 } } }, 'FORGEAX_RUN_PORTS="41021 41022"\nFORGEAX_RUN_PIDS="901"\n');
    const result = recoveryScope(a); const empty = { found: new Map<number, string>(), refusedPorts: new Set<number>(), refusedPids: new Set<number>() };
    expect(canFinalizeStop(result, empty, { isAlive: () => false, isPortBusy: () => false })).toBe(true);
    const live = discoverStopTargets(result, {
      listenPids: () => [],
      readSnapshot: () => ({ pid: 901, commandLine: 'x', cwd: a.root }),
      owns: () => true,
      isAlive: (pid) => pid === 901,
      isPortBusy: () => false,
    });
    expect(live.found.get(901)).toBe('dev-stack.env');
    expect(canFinalizeStop(result, live, { isAlive: (pid) => pid === 901, isPortBusy: () => false })).toBe(false);
  });

  test('early live run.lock owner is an exact launcher target and foreign owner blocks', () => {
    const target = instance(1);
    writeLock(target, 700);
    const result = recoveryScope(target);
    expect(result.pids.find((item) => item.pid === 700)?.key).toBe('launcher (run.lock)');
    const owned = discoverStopTargets(result, {
      listenPids: () => [],
      readSnapshot: () => ({ pid: 700, commandLine: join(target.root, 'scripts/local-runtime.ts'), cwd: target.root }),
      owns: (_snapshot, owner) => owner.service === 'launcher',
      isAlive: (pid) => pid === 700,
      isPortBusy: () => false,
    });
    expect(owned.found.get(700)).toBe('launcher (run.lock)');
    const foreign = discoverStopTargets(result, {
      listenPids: () => [],
      readSnapshot: () => ({ pid: 700, commandLine: 'bun unrelated', cwd: target.root }),
      owns: () => false,
      isAlive: (pid) => pid === 700,
      isPortBusy: () => false,
    });
    expect(foreign.refusedPids).toContain(700);
    expect(foreign.blocked).toBe(true);
  });

  test('recovery classifies dev-stack PIDs against all exact current-instance contracts', () => {
    const target = instance(1);
    pluginFixture(target);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="701 702 703 704 705"\n');
    const result = recoveryScope(target);
    expect(result.unprovenPids).toEqual([]);
    const serviceByPid = new Map([[701, 'launcher'], [702, 'server'], [703, 'interface'], [704, 'engine'], [705, 'plugin-frontend']]);
    const discovery = discoverStopTargets(result, {
      listenPids: () => [],
      readSnapshot: (pid) => ({ pid, commandLine: 'x', cwd: target.root }),
      owns: (snapshot, owner) => owner.service === serviceByPid.get(snapshot!.pid),
      isAlive: (pid) => serviceByPid.has(pid),
      isPortBusy: () => false,
    });
    expect([...discovery.found.keys()]).toEqual([701, 702, 703, 704, 705]);
    expect(discovery.blocked).toBe(false);
    expect(canFinalizeStop(result, discovery, {
      isAlive: () => false,
      isPortBusy: () => false,
    })).toBe(true);
  });

  test('plugin wrapper recovery accepts a declared serve command even when stop would prefer dev', () => {
    const target = instance(1);
    const dir = pluginFixture(target);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', serve: 'node scripts/serve.mjs' } }));
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="706"\n');
    const result = recoveryScope(target);
    const pluginTarget = result.pids.find((item) => item.pid === 706)!;
    expect(pluginTarget.owners.filter((owner) => owner.service === 'plugin-frontend').map((owner) => owner.pluginCommand)).toEqual(['dev', 'serve']);
    const serveSnapshot = { pid: 706, commandLine: 'bun run serve', cwd: dir };
    expect(pluginTarget.owners.some((owner) => runtimeProcessBelongsToInstance(serveSnapshot, owner))).toBe(true);
    const undeclaredSnapshot = { pid: 706, commandLine: 'bun run preview', cwd: dir };
    expect(pluginTarget.owners.some((owner) => runtimeProcessBelongsToInstance(undeclaredSnapshot, owner))).toBe(false);
  });

  test('a live dev-stack PID from another root remains refused, not merely ignored', () => {
    const a = instance(1);
    const b = instance(2);
    writeRecovery(a, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="801"\n');
    const result = recoveryScope(a);
    const discovery = discoverStopTargets(result, {
      listenPids: () => [],
      readSnapshot: () => ({ pid: 801, commandLine: join(b.root, 'scripts/local-runtime.ts'), cwd: b.root }),
      owns: () => false,
      isAlive: (pid) => pid === 801,
      isPortBusy: () => false,
    });
    expect(discovery.refusedPids).toContain(801);
    expect(discovery.blocked).toBe(true);
  });

  test('a new start that publishes before cleanup acquisition retains every artifact', async () => {
    const target = instance(1);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="901"\n');
    mkdirSync(join(target.root, '.forgeax/runtime'), { recursive: true });
    writeFileSync(target.stateFile, '{}');
    let start: StartLock | null = null;
    const result = await cleanupStopArtifacts(target, {
      canFinalize: () => true,
      clearPidfiles: () => {},
      beforeAcquire: () => { start = StartLock.acquireForRuntime(target.root); },
    });
    expect(result.ok).toBe(false);
    expect(readStartLockOwner(target.root)?.token).toBe(start!.handoffToken());
    expect(existsSync(join(target.root, '.forgeax/dev-stack.env'))).toBe(true);
    expect(existsSync(join(target.root, '.forgeax/extension-dev-ports.json'))).toBe(true);
    expect(existsSync(target.stateFile)).toBe(true);
    start!.release();
  });

  test('cleanup lease excludes start, clears artifacts, releases, and permits a later start', async () => {
    const target = instance(1);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="902"\n');
    mkdirSync(join(target.root, '.forgeax/runtime'), { recursive: true });
    writeFileSync(target.stateFile, '{}');
    let startWasBlocked = false;
    const result = await cleanupStopArtifacts(target, {
      canFinalize: () => true,
      clearPidfiles: () => {},
      onLeaseAcquired: () => {
        expect(() => StartLock.acquireForRuntime(target.root)).toThrow();
        startWasBlocked = true;
      },
    });
    expect(result.ok).toBe(true);
    expect(startWasBlocked).toBe(true);
    expect(existsSync(join(target.root, '.forgeax/dev-stack.env'))).toBe(false);
    expect(existsSync(join(target.root, '.forgeax/extension-dev-ports.json'))).toBe(false);
    expect(existsSync(target.stateFile)).toBe(false);
    const reusableGuardPort = createServer();
    await new Promise<void>((resolve, reject) => {
      reusableGuardPort.once('error', reject);
      reusableGuardPort.listen(target.ports.server, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => reusableGuardPort.close((error) => error ? reject(error) : resolve()));
    const laterStart = StartLock.acquireForRuntime(target.root);
    laterStart.release();
  });

  test('dead and malformed stale locks recover through the cleanup lease', async () => {
    const target = instance(1);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="903"\n');
    writeLock(target, 9_999_991);
    expect((await cleanupStopArtifacts(target, { canFinalize: () => true, clearPidfiles: () => {} })).ok).toBe(true);
    expect(existsSync(join(target.root, '.forgeax/run.lock'))).toBe(false);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} });
    writeLock(target, 9_999_992);
    writeFileSync(join(target.root, '.forgeax/run.lock/owner.json'), '{malformed');
    expect((await cleanupStopArtifacts(target, { canFinalize: () => true, clearPidfiles: () => {} })).ok).toBe(true);
    expect(existsSync(join(target.root, '.forgeax/run.lock'))).toBe(false);
  });

  test('a concurrent cleanup contender cannot delete artifacts owned by the lease holder', async () => {
    const target = instance(1);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} });
    let contender: Awaited<ReturnType<typeof cleanupStopArtifacts>> | null = null;
    const owner = await cleanupStopArtifacts(target, {
      canFinalize: () => true,
      clearPidfiles: () => {},
      onLeaseAcquired: async () => {
        contender = await cleanupStopArtifacts(target, { canFinalize: () => true, clearPidfiles: () => {} });
        expect(existsSync(join(target.root, '.forgeax/extension-dev-ports.json'))).toBe(true);
      },
    });
    expect(contender?.ok).toBe(false);
    expect(owner.ok).toBe(true);
    expect(existsSync(join(target.root, '.forgeax/extension-dev-ports.json'))).toBe(false);
  });

  test('another cleanup guard on this instance server port leaves artifacts untouched', async () => {
    const target = instance(1);
    writeRecovery(target, { generatedBy: 'scripts/local-runtime.ts', plugins: {} }, 'FORGEAX_RUN_PIDS="904"\n');
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(target.ports.server, '127.0.0.1', resolve);
    });
    try {
      const result = await cleanupStopArtifacts(target, { canFinalize: () => true, clearPidfiles: () => {} });
      expect(result.ok).toBe(false);
      expect(existsSync(join(target.root, '.forgeax/dev-stack.env'))).toBe(true);
      expect(existsSync(join(target.root, '.forgeax/extension-dev-ports.json'))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  test('a valid state whose launcher conflicts with run.lock fails closed', () => {
    const target = instance(1);
    writeLock(target, 999);
    const result = scope(target, stateFor(target));
    expect(result.untrusted).toBe(true);
  });
});
