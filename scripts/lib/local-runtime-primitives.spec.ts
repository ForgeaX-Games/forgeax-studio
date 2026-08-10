import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializePackagedEngineWorkspace } from './engine-workspace.ts';
import { packagedRuntimeServiceEnv, runPackagedRuntime } from './packaged-runtime.ts';
import { readRuntimeState } from './runtime-state.ts';
import { seedSharedGames } from './seed-games.ts';
import { ServiceSupervisor, type ServiceEvent } from './service-supervisor.ts';
import { resolveStartupEnvironment } from './startup-environment.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared game seeding', () => {
  test('links by manifest id and preserves a shadowing real directory as a backup', () => {
    const root = temporaryRoot();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    mkdirSync(join(source, 'folder-name'), { recursive: true });
    mkdirSync(join(destination, 'game-id'), { recursive: true });
    writeFileSync(join(source, 'folder-name', 'forge.json'), '{"id":"game-id"}\n');
    writeFileSync(join(destination, 'game-id', 'local.txt'), 'preserve me');

    const result = seedSharedGames({ source, destination });
    const backups = readdirSync(destination).filter((name) => name.startsWith('game-id.bak-'));

    expect(result.refreshed).toBe(1);
    expect(lstatSync(join(destination, 'game-id')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(destination, 'game-id'))).toBe(join(source, 'folder-name'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(destination, backups[0] as string, 'local.txt'), 'utf8')).toBe('preserve me');
  });
});

describe('packaged engine workspace', () => {
  test('projects the StartupEnvironment socket for repeated packaged service launches without touching resources', () => {
    const root = temporaryRoot();
    const resources = join(root, 'read-only-resources');
    const projects = join(root, 'projects');
    mkdirSync(resources, { recursive: true });
    const startup = resolveStartupEnvironment({
      root,
      homeDir: root,
      profile: 'desktop-prod',
      env: {
        FORGEAX_RESOURCE_ROOT: resources,
        FORGEAX_PROJECT_ROOT: projects,
        FORGEAX_AGENT_HOST_SOCK: '/explicit/desktop-agent.sock',
      },
    });
    const before = readdirSync(resources);

    const first = packagedRuntimeServiceEnv(startup, { FORGEAX_AGENT_HOST_SOCK: '/wrong-parent.sock' });
    const second = packagedRuntimeServiceEnv(startup, {});

    expect(first.FORGEAX_AGENT_HOST_SOCK).toBe('/explicit/desktop-agent.sock');
    expect(second.FORGEAX_AGENT_HOST_SOCK).toBe('/explicit/desktop-agent.sock');
    expect(first.FORGEAX_PROJECT_ROOT).toBe(projects);
    expect(readdirSync(resources)).toEqual(before);
  });

  test('keeps source StartLock out of desktop-prod local-runtime control flow', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'local-runtime.ts'), 'utf8');

    expect(source).toContain("profile === 'desktop-prod'\n    ? null");
    expect(source).toContain('lock?.release()');
    expect(source).not.toContain("const lock = handoffToken ? StartLock.adopt");
  });

  test('materializes writable sources and points runtime-owned trees at their authorities', () => {
    const root = temporaryRoot();
    const resources = join(root, 'resources');
    const shared = join(root, 'node_modules');
    const work = join(root, 'work');
    const projects = join(root, 'projects');
    mkdirSync(join(resources, 'src'), { recursive: true });
    mkdirSync(join(resources, 'node_modules', '@forgeax', 'engine-x'), { recursive: true });
    mkdirSync(join(shared, '@forgeax', 'engine-x'), { recursive: true });
    mkdirSync(join(shared, '@forgeax', 'wb-game-video'), { recursive: true });
    mkdirSync(join(shared, 'three'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(resources, 'vite.config.ts'), 'export default {};\n');
    writeFileSync(join(resources, 'src', 'main.ts'), 'export {};\n');
    symlinkSync(join(root, 'missing-shared-assets'), join(work, 'shared-assets'), 'junction');

    materializePackagedEngineWorkspace(resources, work, projects);

    expect(readFileSync(join(work, 'src', 'main.ts'), 'utf8')).toBe('export {};\n');
    // node_modules is a real dir of junctions merging engine-local + shared pools
    const nmStat = lstatSync(join(work, 'node_modules'));
    expect(nmStat.isDirectory() && !nmStat.isSymbolicLink()).toBe(true);
    // engine-local entry wins over the same package in the shared pool
    expect(readlinkSync(join(work, 'node_modules', '@forgeax', 'engine-x'))).toBe(
      join(resources, 'node_modules', '@forgeax', 'engine-x'),
    );
    // shared-only entries are linked through, scopes merged per member
    expect(readlinkSync(join(work, 'node_modules', '@forgeax', 'wb-game-video'))).toBe(
      join(shared, '@forgeax', 'wb-game-video'),
    );
    expect(readlinkSync(join(work, 'node_modules', 'three'))).toBe(join(shared, 'three'));
    expect(lstatSync(join(work, '.forgeax')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(work, '.forgeax'))).toBe(join(projects, '.forgeax'));
    expect(existsSync(join(projects, '.forgeax', 'games'))).toBe(true);
    expect(() => lstatSync(join(work, 'shared-assets'))).toThrow();
  });

  test('publishes a failed state when packaged preparation cannot complete', async () => {
    const root = temporaryRoot();
    const resources = join(root, 'resources');
    const projects = join(root, 'projects');
    mkdirSync(resources, { recursive: true });
    const startup = resolveStartupEnvironment({
      root,
      homeDir: root,
      profile: 'desktop-prod',
      env: {
        FORGEAX_RESOURCE_ROOT: resources,
        FORGEAX_PROJECT_ROOT: projects,
      },
    });

    await expect(runPackagedRuntime(startup)).rejects.toThrow(/packaged engine is missing/);
    expect(readRuntimeState(startup.stateFile)).toMatchObject({
      status: 'failed',
      profile: 'desktop-prod',
      error: expect.stringContaining('packaged engine is missing'),
    });
  });
});

describe('service supervisor', () => {
  test('uses one bounded restart policy and surfaces terminal failure', async () => {
    const events: ServiceEvent[] = [];
    let fatal: Error | undefined;
    const supervisor = new ServiceSupervisor({
      onEvent: (event) => events.push(event),
      onFatal: (error) => {
        fatal = error;
      },
    });

    supervisor.launch({
      name: 'crashing-service',
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      spawn: {},
      required: true,
      restartPolicy: 'bounded',
      maxRestarts: 1,
    });

    const deadline = performance.now() + 3_000;
    while (!fatal && performance.now() < deadline) await Bun.sleep(25);
    supervisor.shutdown(true);

    expect(fatal?.message).toContain("required service 'crashing-service' exited unexpectedly");
    expect(events.some((event) => event.status === 'restarting' && event.attempt === 1)).toBe(true);
    expect(events.at(-2)?.status).toBe('failed');
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-local-runtime-'));
  roots.push(root);
  return root;
}
