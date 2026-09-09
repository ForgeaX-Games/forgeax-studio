import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRuntimePortStartupLocks,
  RuntimePortStartupLock,
  RuntimePortStartupLockBusyError,
  RuntimePortStartupLockStaleError,
  runtimePortStartupLockPath,
} from './runtime-port-lock.ts';

const roots: string[] = [];

function lockRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-port-lock-'));
  roots.push(root);
  return root;
}

describe('runtime port startup lease', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('serializes overlapping startup attempts and releases only its own lease', async () => {
    const root = lockRoot();
    const first = await RuntimePortStartupLock.acquire(58_900, { lockRoot: root, waitMs: 0, root: '/checkout-a' });
    try {
      await expect(
        RuntimePortStartupLock.acquire(58_900, { lockRoot: root, waitMs: 0, root: '/checkout-b' }),
      ).rejects.toBeInstanceOf(RuntimePortStartupLockBusyError);
      first.release();
      expect(existsSync(runtimePortStartupLockPath(58_900, root))).toBe(false);
    } finally {
      first.release();
    }
  });

  test('reclaims a lease only after the recorded owner is dead', async () => {
    const root = lockRoot();
    const path = runtimePortStartupLockPath(58_920, root);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_999,
      token: 'dead-owner-token-123456',
      root: '/dead/checkout',
    }));

    const lease = await RuntimePortStartupLock.acquire(58_920, { lockRoot: root, waitMs: 0, root: '/checkout-c', isAlive: () => false });
    lease.release();
    expect(existsSync(path)).toBe(false);
  });

  test('fails closed on a malformed lease instead of deleting unknown state', async () => {
    const root = lockRoot();
    const path = runtimePortStartupLockPath(55_173, root);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'unexpected'), 'unknown owner\n');

    await expect(
      RuntimePortStartupLock.acquire(55_173, { lockRoot: root, waitMs: 0, root: '/checkout-d' }),
    ).rejects.toBeInstanceOf(RuntimePortStartupLockStaleError);
    expect(existsSync(path)).toBe(true);
  });

  test('acquires an entire tuple in deterministic order and releases it as one lease', async () => {
    const root = lockRoot();
    const lease = await acquireRuntimePortStartupLocks([58_920, 55_173, 58_900], { lockRoot: root, waitMs: 0, root: '/checkout-e' });
    expect(lease.ports).toEqual([55_173, 58_900, 58_920]);
    expect(lease.ports.every((port) => existsSync(runtimePortStartupLockPath(port, root)))).toBe(true);
    lease.release();
    expect(lease.ports.some((port) => existsSync(runtimePortStartupLockPath(port, root)))).toBe(false);
  });
});
