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
import { runPackagedRuntime } from './packaged-runtime.ts';
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
  test('materializes writable sources and points runtime-owned trees at their authorities', () => {
    const root = temporaryRoot();
    const resources = join(root, 'resources');
    const work = join(root, 'work');
    const projects = join(root, 'projects');
    mkdirSync(join(resources, 'src'), { recursive: true });
    mkdirSync(join(resources, 'node_modules'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(resources, 'vite.config.ts'), 'export default {};\n');
    writeFileSync(join(resources, 'src', 'main.ts'), 'export {};\n');
    symlinkSync(join(root, 'missing-shared-assets'), join(work, 'shared-assets'), 'junction');

    materializePackagedEngineWorkspace(resources, work, projects);

    expect(readFileSync(join(work, 'src', 'main.ts'), 'utf8')).toBe('export {};\n');
    expect(lstatSync(join(work, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(work, 'node_modules'))).toBe(join(resources, 'node_modules'));
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
