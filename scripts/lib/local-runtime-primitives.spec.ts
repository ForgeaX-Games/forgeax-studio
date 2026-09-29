import { afterEach, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSharedGames } from './seed-games.ts';
import { ServiceSupervisor, type ServiceEvent } from './service-supervisor.ts';

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

  test('copies packaged games into the confined project authority and preserves edits', () => {
    const root = temporaryRoot();
    const source = join(root, 'bundle-games');
    const destination = join(root, 'project', '.forgeax', 'games');
    mkdirSync(join(source, 'spin-cube'), { recursive: true });
    writeFileSync(join(source, 'spin-cube', 'forge.json'), '{"id":"spin-cube"}\n');
    writeFileSync(join(source, 'spin-cube', 'main.ts'), 'export const source = 1;\n');

    const first = seedSharedGames({ source, destination, materialization: 'copy-if-absent' });
    writeFileSync(join(destination, 'spin-cube', 'main.ts'), 'export const userEdit = 2;\n');
    const second = seedSharedGames({ source, destination, materialization: 'copy-if-absent' });

    expect(first.copied).toBe(1);
    expect(lstatSync(join(destination, 'spin-cube')).isSymbolicLink()).toBe(false);
    expect(second.unchanged).toBe(1);
    expect(readFileSync(join(destination, 'spin-cube', 'main.ts'), 'utf8')).toBe('export const userEdit = 2;\n');
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

test('a startup continuation cannot spawn services after supervisor shutdown', () => {
  const events: ServiceEvent[] = [];
  const supervisor = new ServiceSupervisor({ onEvent: event => events.push(event) });
  supervisor.shutdown();
  expect(supervisor.launch({
    name: 'late-start', command: process.execPath, args: ['-e', 'process.exit(0)'],
    spawn: {}, restartPolicy: 'fail-fast',
  })).toBe(0);
  expect(supervisor.pids()).toEqual({});
  expect(events).toEqual([]);
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-local-runtime-'));
  roots.push(root);
  return root;
}
