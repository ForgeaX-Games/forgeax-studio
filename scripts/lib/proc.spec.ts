import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canBindPort, isDefunctProcessState, readPidfilePid } from './proc';

const roots: string[] = [];

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('readPidfilePid', () => {
  test('returns null when a pidfile disappears after directory enumeration', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pidfile-race-'));
    roots.push(root);
    const file = join(root, 'server.pid');
    writeFileSync(file, '4242 4242\n');
    rmSync(file);

    expect(readPidfilePid(file)).toBeNull();
  });

  test('parses the first pid field and does not hide unrelated read errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pidfile-read-'));
    roots.push(root);
    const file = join(root, 'server.pid');
    writeFileSync(file, '4242 4242\n');
    expect(readPidfilePid(file)).toBe(4242);

    const directory = join(root, 'not-a-file.pid');
    mkdirSync(directory);
    expect(() => readPidfilePid(directory)).toThrow();
  });
});

describe('isDefunctProcessState', () => {
  test('classifies POSIX zombie states as no longer live resources', () => {
    expect(isDefunctProcessState('Z')).toBe(true);
    expect(isDefunctProcessState('Z+')).toBe(true);
    expect(isDefunctProcessState('S')).toBe(false);
    expect(isDefunctProcessState('R+')).toBe(false);
  });
});

describe('canBindPort', () => {
  test('checks the next bind rather than relying on listener discovery', async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '0.0.0.0', port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');
    try {
      expect(await canBindPort(address.port)).toBe(false);
    } finally {
      await close(server);
    }
    expect(await canBindPort(address.port)).toBe(true);
  });

  test('releases accepted reconnects before completing the bind probe', async () => {
    let reconnect: ReturnType<typeof createConnection> | null = null;
    let connected = false;
    const probe = canBindPort(0, '127.0.0.1', {
      beforeClose: (port) => new Promise<void>((resolve, reject) => {
        reconnect = createConnection({ host: '127.0.0.1', port });
        reconnect.once('connect', () => {
          connected = true;
          resolve();
        });
        reconnect.once('error', reject);
      }),
    });
    const result = await Promise.race([
      probe,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ]);
    reconnect?.destroy();
    await probe;
    expect(connected).toBe(true);
    expect(result).toBe(true);
  });
});
