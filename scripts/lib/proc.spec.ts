import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDefunctProcessState, readPidfilePid } from './proc';

const roots: string[] = [];

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
