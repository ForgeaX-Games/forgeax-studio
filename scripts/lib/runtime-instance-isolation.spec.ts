import { describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPidfiles, isAlive, isPortBusy, listenPids } from './proc.ts';
import {
  deriveRuntimeInstancePorts,
  resolveRuntimeInstance,
  RUNTIME_INSTANCE_SLOTS,
  runtimeInstanceProcessEnv,
  writeRuntimeInstanceConfig,
} from './runtime-instance.ts';
import { readRuntimeProcessSnapshot, runtimeProcessBelongsToInstance } from './runtime-process-owner.ts';
import { readRuntimeState, RuntimeStateStore } from './runtime-state.ts';
import { canFinalizeStop, discoverStopTargets } from './stop-execution.ts';
import { cleanupStopArtifacts, resolveInstanceStopScope, type PluginOwner } from './stop-scope.ts';
import { resolveStartupEnvironment } from './startup-environment.ts';


const fixtureProgram = `
  import { createServer } from 'node:http';
  const port = Number(process.argv[2]);
  const server = createServer((_request, response) => response.end('runtime-instance-fixture'));
  server.listen(port, '127.0.0.1');
  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close); process.on('SIGINT', close);
`;

type Instance = ReturnType<typeof resolveRuntimeInstance>;
type ServiceName = 'launcher' | 'server' | 'interface' | 'engine' | 'plugin-frontend' | 'plugin-backend';

interface FixtureProcess {
  readonly name: ServiceName;
  readonly port: number;
  readonly child: ChildProcess;
}

/**
 * This is an integration test, so it must not steal a slot from a developer's
 * already-running worktree. Reserve two completely unused derived port sets
 * for the temporary fixture roots instead of assuming slots 1 and 2 are free.
 */
async function fixtureSlots(): Promise<readonly [number, number]> {
  const available: number[] = [];
  for (const slot of RUNTIME_INSTANCE_SLOTS) {
    const ports = deriveRuntimeInstancePorts(slot);
    const fixturePorts = [
      ...Object.values(ports),
      ports.server + 701,
      ports.server + 702,
      ports.server + 703,
    ];
    if ((await Promise.all(fixturePorts.map((port) => isFixturePortBusy(port)))).every((busy) => !busy)) {
      available.push(slot);
    }
  }
  if (available.length < 2) {
    throw new Error('runtime instance isolation fixture requires two unused runtime slots');
  }
  return [available[0]!, available[1]!];
}

/** Probe the bind address directly: Bun's macOS test worker cannot reliably see lsof output. */
async function isFixturePortBusy(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (busy: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(250, () => finish(true));
  });
}

function makeRoot(parent: string): string {
  const root = join(parent, 'same-checkout-name');
  mkdirSync(root, { recursive: true });
  return root;
}

function writeFixtureLayout(root: string): PluginOwner {
  root = realpathSync(root);
  const files = [
    join(root, 'scripts/local-runtime.ts'),
    join(root, 'packages/server/src/main.ts'),
    join(root, 'packages/studio/vite.ts'),
    join(root, 'packages/editor/packages/play-runtime/vite.ts'),
    join(root, 'packages/marketplace/extensions/wb-lowpoly-obj/dev.ts'),
  ];
  for (const file of files) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, fixtureProgram);
  }
  writeFileSync(join(root, 'packages/server/package.json'), JSON.stringify({ name: '@forgeax/server' }));
  const pluginDir = join(root, 'packages/marketplace/extensions/wb-lowpoly-obj');
  writeFileSync(join(pluginDir, 'forgeax-extension.json'), JSON.stringify({
    id: '@forgeax/lowpoly', entry: { standalone: { embeddedAlso: false, start: 'dev' } },
  }));
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  return { shortId: 'lowpoly', dir: pluginDir, commands: ['dev'] };
}

function spawnFixture(root: string, name: ServiceName, port: number, plugin: PluginOwner): FixtureProcess {
  const file = name === 'launcher' ? join(root, 'scripts/local-runtime.ts')
    : name === 'server' ? join(root, 'packages/server/src/main.ts')
      : name === 'interface' ? join(root, 'packages/studio/vite.ts')
        : name === 'engine' ? join(root, 'packages/editor/packages/play-runtime/vite.ts')
          : join(plugin.dir, 'dev.ts');
  const cwd = name === 'launcher' ? root
    : name === 'server' ? join(root, 'packages/server')
      : name === 'interface' ? join(root, 'packages/studio')
        : name === 'engine' ? join(root, 'packages/editor/packages/play-runtime')
          : name === 'plugin-frontend' ? join(plugin.dir, 'frontend') : join(plugin.dir, 'backend');
  mkdirSync(cwd, { recursive: true });
  // The argument words are deliberate: runtime ownership checks command-line
  // signatures, while the tiny fixture still serves HTTP from its source file.
  const signature = name === 'interface' || name === 'engine' ? 'vite'
    : name === 'plugin-frontend' ? 'dev vite' : name === 'plugin-backend' ? 'dev tsx' : 'fixture';
  const child = spawn(process.execPath, [file, String(port), ...signature.split(' ')], {
    cwd, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true,
  });
  if (!child.pid) throw new Error(`failed to spawn ${name}`);
  return { name, port, child };
}

async function waitForListener(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) });
      if (response.ok && await response.text() === 'runtime-instance-fixture') return;
    } catch { /* fixture has not bound yet */ }
    await Bun.sleep(25);
  }
  throw new Error(`fixture never listened on ${port}`);
}

async function stopFixture(processes: readonly FixtureProcess[]): Promise<void> {
  for (const fixture of processes) {
    if (fixture.child.pid) try { globalThis.process.kill(fixture.child.pid, 'SIGTERM'); } catch { /* process exited between checks */ }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processes.some(({ child }) => child.pid && isAlive(child.pid))) await Bun.sleep(20);
  for (const fixture of processes) {
    if (fixture.child.pid) try { globalThis.process.kill(fixture.child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function options(instance: Instance, plugin: PluginOwner) {
  return {
    activeServer: { packageDir: join(instance.root, 'packages/server'), entry: 'src/main.ts' },
    interfaceDir: join(instance.root, 'packages/studio'),
    plugins: new Map([[plugin.shortId, plugin]]),
  };
}

function writeRecovery(instance: Instance, processes: readonly FixtureProcess[]): void {
  mkdirSync(join(instance.root, '.forgeax'), { recursive: true });
  const frontend = processes.find((item) => item.name === 'plugin-frontend')!;
  const backend = processes.find((item) => item.name === 'plugin-backend')!;
  writeFileSync(join(instance.root, '.forgeax/extension-dev-ports.json'), JSON.stringify({
    generatedBy: 'scripts/local-runtime.ts', plugins: { '@forgeax/lowpoly': { frontendPort: frontend.port, backendPort: backend.port } },
  }));
  writeFileSync(join(instance.root, '.forgeax/dev-stack.env'), `FORGEAX_RUN_PIDS="${processes.map(({ child }) => child.pid).join(' ')}"\n`);
}

function writeState(instance: Instance, processes: readonly FixtureProcess[]) {
  const byName = new Map(processes.map((item) => [item.name, item]));
  const startup = resolveStartupEnvironment({
    root: instance.root, profile: 'web-dev', env: { ...runtimeInstanceProcessEnv(instance), FORGEAX_BRIDGE: '0' },
  });
  const store = new RuntimeStateStore(startup, byName.get('launcher')!.child.pid!, {
    server: instance.ports.server,
    interface: instance.ports.interface,
    engine: instance.ports.engine,
    'plugin-lowpoly-frontend': byName.get('plugin-frontend')!.port,
    'plugin-lowpoly-backend': byName.get('plugin-backend')!.port,
  });
  store.setServicePid('server', byName.get('server')!.child.pid!);
  store.setServicePid('interface', byName.get('interface')!.child.pid!);
  store.setServicePid('engine', byName.get('engine')!.child.pid!);
  return store.setServicePid('plugin-lowpoly', byName.get('plugin-frontend')!.child.pid!);
}

function captureB(instance: Instance): Map<string, string> {
  const files = [instance.stateFile, instance.logFile, join(instance.root, '.forgeax/run.lock/owner.json'), join(instance.root, '.forgeax/dev-stack.env'), join(instance.root, '.forgeax/extension-dev-ports.json')];
  return new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
}

function assertBUntouched(instance: Instance, before: ReadonlyMap<string, string>, processes: readonly FixtureProcess[]): void {
  for (const [file, contents] of before) expect(readFileSync(file, 'utf8')).toBe(contents);
  for (const { child } of processes) expect(child.pid && isAlive(child.pid)).toBe(true);
}

function fixtureSnapshot(instance: Instance, process: FixtureProcess, plugin: PluginOwner) {
  const file = process.name === 'launcher' ? join(instance.root, 'scripts/local-runtime.ts')
    : process.name === 'server' ? join(instance.root, 'packages/server/src/main.ts')
      : process.name === 'interface' ? join(instance.root, 'packages/studio/vite.ts')
        : process.name === 'engine' ? join(instance.root, 'packages/editor/packages/play-runtime/vite.ts')
          : join(plugin.dir, 'dev.ts');
  const cwd = process.name === 'launcher' ? instance.root
    : process.name === 'server' ? join(instance.root, 'packages/server')
      : process.name === 'interface' ? join(instance.root, 'packages/studio')
        : process.name === 'engine' ? join(instance.root, 'packages/editor/packages/play-runtime')
          : process.name === 'plugin-frontend' ? join(plugin.dir, 'frontend') : join(plugin.dir, 'backend');
  const signature = process.name === 'interface' || process.name === 'engine' ? 'vite'
    : process.name === 'plugin-frontend' ? 'dev vite' : process.name === 'plugin-backend' ? 'dev tsx' : 'fixture';
  if (process.name === 'plugin-frontend') return { pid: process.child.pid!, commandLine: 'bun dev vite --host 127.0.0.1', cwd: plugin.dir };
  if (process.name === 'plugin-backend') return { pid: process.child.pid!, commandLine: 'bun dev tsx --watch backend/src/main.ts', cwd: plugin.dir };
  return { pid: process.child.pid!, commandLine: `${process.execPath} ${file} ${process.port} ${signature}`, cwd };
}

async function spawnStack(instance: Instance, plugin: PluginOwner): Promise<FixtureProcess[]> {
  const processes = [
    // Keep the launcher listener off any fallback-owned service port: it is
    // proved by its PID/command contract, not mislabelled as narrative.
    spawnFixture(instance.root, 'launcher', instance.ports.server + 703, plugin),
    spawnFixture(instance.root, 'server', instance.ports.server, plugin),
    spawnFixture(instance.root, 'interface', instance.ports.interface, plugin),
    spawnFixture(instance.root, 'engine', instance.ports.engine, plugin),
    spawnFixture(instance.root, 'plugin-frontend', instance.ports.server + 701, plugin),
    spawnFixture(instance.root, 'plugin-backend', instance.ports.server + 702, plugin),
  ];
  try {
    await Promise.all(processes.map(({ port }) => waitForListener(port)));
    return processes;
  } catch (error) {
    await stopFixture(processes);
    throw error;
  }
}

describe('runtime instance ownership boundary (real processes)', () => {
  test('isolates same-basename canonical roots through state stop and missing/corrupt-state recovery', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'forgeax-runtime-instance-isolation-'));
    const rootA = makeRoot(join(temp, 'parent-a'));
    const rootB = makeRoot(join(temp, 'parent-b'));
    const pluginA = writeFixtureLayout(rootA);
    const pluginB = writeFixtureLayout(rootB);
    const [slotA, slotB] = await fixtureSlots();
    writeRuntimeInstanceConfig({ root: rootA, slot: slotA, isolateUser: true });
    writeRuntimeInstanceConfig({ root: rootB, slot: slotB, isolateUser: true });
    const a = resolveRuntimeInstance({ root: rootA });
    const b = resolveRuntimeInstance({ root: rootB });
    const all: FixtureProcess[] = [];
    try {
      expect(a.id).not.toBe(b.id);
      expect(a.root).not.toBe(b.root);
      expect(a.ports).not.toEqual(b.ports);
      expect(new Set([a.stateFile, a.logFile, a.agentHostSocket, a.userDir, a.interfaceOrigin, a.reelUrl]).size).toBe(6);
      expect([a.stateFile, a.logFile, a.agentHostSocket, a.userDir, a.interfaceOrigin, a.reelUrl]).toEqual(expect.not.arrayContaining([b.stateFile, b.logFile, b.agentHostSocket, b.userDir, b.interfaceOrigin, b.reelUrl]));

      const bProcesses = await spawnStack(b, pluginB); all.push(...bProcesses);
      writeState(b, bProcesses); writeRecovery(b, bProcesses);
      mkdirSync(join(b.root, '.forgeax/run.lock'), { recursive: true });
      writeFileSync(join(b.root, '.forgeax/run.lock/owner.json'), JSON.stringify({ schemaVersion: 1, pid: process.pid, token: '01234567-89ab-cdef-0123-456789abcdef' }));
      writeFileSync(b.logFile, 'B log must survive\n');
      const bBefore = captureB(b);
      expect((await fetch(`${b.interfaceOrigin}/`)).text()).resolves.toBe('runtime-instance-fixture');

      for (const recovery of ['valid', 'missing', 'corrupt'] as const) {
        const aProcesses = await spawnStack(a, pluginA); all.push(...aProcesses);
        writeRecovery(a, aProcesses);
        writeFileSync(a.logFile, `A ${recovery}\n`);
        if (recovery === 'valid') writeState(a, aProcesses);
        else if (recovery === 'corrupt') writeFileSync(a.stateFile, '{not json');
        else rmSync(a.stateFile, { force: true });

        const scope = resolveInstanceStopScope(a, readRuntimeState(a.stateFile), options(a, pluginA));
        const fixturePids = new Map(aProcesses.map(({ port, child }) => [port, [child.pid!]]));
        // `listenPids` is invoked for every target. Bun's macOS test worker
        // cannot inspect its own children through lsof, so only that known
        // runner limitation falls back to the already HTTP-proved fixture PID.
        const listenerPids = (port: number) => listenPids(port).length > 0 ? listenPids(port) : (fixturePids.get(port) ?? []);
        const snapshots = new Map(aProcesses.map((process) => [
          process.child.pid!, process.name.startsWith('plugin-')
            ? fixtureSnapshot(a, process, pluginA)
            : readRuntimeProcessSnapshot(process.child.pid!) ?? fixtureSnapshot(a, process, pluginA),
        ]));
        const discovery = discoverStopTargets(scope, {
          listenPids: listenerPids, readSnapshot: (pid) => snapshots.get(pid) ?? null, owns: runtimeProcessBelongsToInstance, isAlive, isPortBusy,
        });
        const expected = new Set(aProcesses.map(({ child }) => child.pid!));
        expect([...discovery.found.keys()].every((pid) => expected.has(pid))).toBe(true);
        expect([...discovery.found.keys()].sort((left, right) => left - right)).toEqual([...expected].sort((left, right) => left - right));
        for (const process of aProcesses) {
          const snapshot = snapshots.get(process.child.pid!) ?? null;
          expect(snapshot).not.toBeNull();
          const target = scope.pids.find((item) => item.pid === process.child.pid);
          if (target && ['launcher', 'server', 'interface', 'engine'].includes(process.name)) {
            expect(target.owners.some((owner) => runtimeProcessBelongsToInstance(snapshot, owner))).toBe(true);
          }
        }
        // The main stop path signals exactly production-discovered PIDs. The
        // `finally` block is intentionally separate emergency test cleanup.
        await stopFixture(aProcesses.filter(({ child }) => discovery.found.has(child.pid!)));
        await Bun.sleep(250);
        expect(canFinalizeStop(scope, discovery, { isAlive, isPortBusy })).toBe(true);
        const cleaned = await cleanupStopArtifacts(a, { canFinalize: () => canFinalizeStop(scope, discovery, { isAlive, isPortBusy }), clearPidfiles });
        expect(cleaned.ok).toBe(true);
        expect(existsSync(a.stateFile)).toBe(false);
        assertBUntouched(b, bBefore, bProcesses);
        expect(await (await fetch(`${b.interfaceOrigin}/`)).text()).toBe('runtime-instance-fixture');
      }

      expect(() => writeRuntimeInstanceConfig({ root: rootA, slot: 5, force: true })).toThrow(/slot must be one of/);
      const copied = readRuntimeState(b.stateFile)!;
      expect(resolveInstanceStopScope(a, copied, options(a, pluginA)).state).toBeNull();
      const drifted = { ...copied, managedPorts: { ...copied.managedPorts, server: a.ports.server } };
      expect(resolveInstanceStopScope(b, drifted, options(b, pluginB)).state).toBeNull();
    } finally {
      await stopFixture(all);
      rmSync(temp, { recursive: true, force: true });
    }
  }, 45_000);
});
