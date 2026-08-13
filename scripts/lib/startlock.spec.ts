import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { readStartLockOwner, StartLock, StartLockHeldError, StartLockStaleError } from './startlock.ts';

const roots: string[] = [];
function root(): string {
  const value = join(tmpdir(), `forgeax-startlock-${crypto.randomUUID()}`);
  mkdirSync(value, { recursive: true });
  const canonical = realpathSync(value);
  roots.push(canonical);
  return canonical;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate test port');
  await close(server);
  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('StartLock', () => {
  test('throw-based acquisition reports a live holder without exiting', () => {
    const checkout = root();
    const first = new StartLock(checkout);
    first.acquireOrThrow();
    try {
      expect(() => new StartLock(checkout).acquireOrThrow()).toThrow(StartLockHeldError);
    } finally {
      first.release();
    }
  });

  test('publishes a complete owner record atomically and reports stale locks without deleting them', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), '999999999');
    expect(() => new StartLock(checkout).acquireOrThrow()).toThrow(StartLockStaleError);
    expect(readStartLockOwner(checkout)).toBeNull();
    expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe('999999999');
  });

  test('instance-init migration safely reclaims a dead legacy pid lock', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), '999999999');
    const lock = new StartLock(checkout);
    lock.acquireForInstanceInitOrThrow();
    expect(readStartLockOwner(checkout)?.pid).toBe(process.pid);
    lock.release();
  });

  test('instance-init migration rejects a live legacy pid lock', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    expect(() => new StartLock(checkout).acquireForInstanceInitOrThrow()).toThrow(StartLockHeldError);
    expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  test('instance-init migration fails closed for an unrecognized lock', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'partial'), 'unknown publisher');
    expect(() => new StartLock(checkout).acquireForInstanceInitOrThrow()).toThrow(StartLockStaleError);
    expect(readFileSync(join(lockDir, 'partial'), 'utf8')).toBe('unknown publisher');
  });

  test('instance-init migration reclaims a dead strict owner but never removes a competing replacement', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      schemaVersion: 1, pid: 999999999, token: '1234567890abcdef',
    }));
    let replacement: StartLock | undefined;
    expect(() => new StartLock(checkout).acquireForInstanceInitOrThrow({
      onQuarantined: () => { replacement = new StartLock(checkout); replacement.acquireOrThrow(); },
    })).toThrow(StartLockHeldError);
    expect(readStartLockOwner(checkout)?.token).toBe(replacement?.handoffToken());
    replacement?.release();
  });

  test('instance-init identity claim rejects a replacement published before stale-directory migration', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      schemaVersion: 1, pid: 999999999, token: '1234567890abcdef',
    }));
    let replacement: StartLock | undefined;
    expect(() => new StartLock(checkout).acquireForInstanceInitOrThrow({
      onClaimed: () => {
        rmSync(lockDir, { recursive: true, force: true });
        replacement = new StartLock(checkout);
        replacement.acquireOrThrow();
      },
    })).toThrow(StartLockHeldError);
    expect(readStartLockOwner(checkout)?.token).toBe(replacement?.handoffToken());
    replacement?.release();
  });

  test('instance-init restores a live replacement that appears before its owner claim', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      schemaVersion: 1, pid: 999999999, token: '1234567890abcdef',
    }));
    let replacement: StartLock | undefined;
    expect(() => new StartLock(checkout).acquireForInstanceInitOrThrow({
      onBeforeClaim: () => {
        rmSync(lockDir, { recursive: true, force: true });
        replacement = new StartLock(checkout);
        replacement.acquireOrThrow();
      },
    })).toThrow(StartLockHeldError);
    expect(readStartLockOwner(checkout)?.token).toBe(replacement?.handoffToken());
    replacement?.release();
  });

  test('rejects owner records with unknown keys', () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      schemaVersion: 1, pid: process.pid, token: '1234567890abcdef', unexpected: true,
    }));
    expect(readStartLockOwner(checkout)).toBeNull();
    expect(() => new StartLock(checkout).acquireOrThrow()).toThrow(StartLockStaleError);
  });

  test('does not let a lost owner release a replacement lock', () => {
    const checkout = root();
    const first = new StartLock(checkout);
    first.acquireOrThrow();
    rmSync(join(checkout, '.forgeax', 'run.lock'), {
      recursive: true,
      force: true,
    });
    const replacement = new StartLock(checkout);
    replacement.acquireOrThrow();
    first.release();
    expect(readStartLockOwner(checkout)?.token).toBe(replacement.handoffToken());
    replacement.release();
  });

  test('allows handoff adoption only for the exact token and parent PID', () => {
    const checkout = root();
    const parent = new StartLock(checkout);
    parent.acquireOrThrow();
    expect(() => StartLock.adopt(checkout, 'not-the-token', process.pid)).toThrow(/handoff was rejected/);
    expect(() => StartLock.adopt(checkout, parent.handoffToken(), process.pid + 1)).toThrow(/handoff was rejected/);
    const child = StartLock.adopt(checkout, parent.handoffToken(), process.pid);
    expect(readStartLockOwner(checkout)?.pid).toBe(process.pid);
    child.release();
  });

  test('does not clear an adopted handoff owner while that PID is still live', () => {
    const checkout = root();
    const parent = new StartLock(checkout);
    parent.acquireOrThrow();
    parent.releaseHandoffFailure(process.pid);
    expect(readStartLockOwner(checkout)?.token).toBe(parent.handoffToken());
    parent.release();
  });

  test('cleanup lease acquired without a lock blocks a concurrent start', async () => {
    const checkout = root();
    const cleanup = await StartLock.acquireForCleanup(checkout, { guardPort: await freePort() });
    try {
      expect(() => new StartLock(checkout).acquireOrThrow()).toThrow(StartLockHeldError);
    } finally {
      cleanup.release();
    }
  });

  test('cleanup lease rejects a valid live owner', async () => {
    const checkout = root();
    const live = new StartLock(checkout);
    live.acquireOrThrow();
    try {
      await expect(StartLock.acquireForCleanup(checkout, { guardPort: await freePort() })).rejects.toThrow(StartLockHeldError);
    } finally {
      live.release();
    }
  });

  test('cleanup lease claims dead and malformed stale lock directories', async () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: 999999999, token: '1234567890abcdef' }));
    const guardPort = await freePort();
    const dead = await StartLock.acquireForCleanup(checkout, { guardPort });
    dead.release();

    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'partial'), 'not an owner');
    const malformed = await StartLock.acquireForCleanup(checkout, { guardPort });
    malformed.release();
  });

  test('cleanup lease preserves a new owner that publishes after stale quarantine', async () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'partial'), 'stale');
    let replacement: StartLock | undefined;
    await expect(StartLock.acquireForCleanup(checkout, {
      guardPort: await freePort(),
      onQuarantined: () => { replacement = new StartLock(checkout); replacement.acquireOrThrow(); },
    })).rejects.toThrow(StartLockHeldError);
    expect(readStartLockOwner(checkout)?.token).toBe(replacement?.handoffToken());
    replacement?.release();
  });

  test('two cleanup contenders using the same guard port are kernel-serialized', async () => {
    const checkout = root();
    const lockDir = join(checkout, '.forgeax/run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'partial'), 'stale');
    const guardPort = await freePort();
    const first = await StartLock.acquireForCleanup(checkout, {
      guardPort,
      onQuarantined: async () => {
        await expect(StartLock.acquireForCleanup(checkout, { guardPort })).rejects.toThrow(/cleanup recovery guard/);
      },
    });
    first.release();
  });

  test('a lost cleanup lease cannot release a replacement lock', async () => {
    const checkout = root();
    const cleanup = await StartLock.acquireForCleanup(checkout, { guardPort: await freePort() });
    rmSync(join(checkout, '.forgeax/run.lock'), { recursive: true, force: true });
    const replacement = new StartLock(checkout);
    replacement.acquireOrThrow();
    cleanup.release();
    expect(readStartLockOwner(checkout)?.token).toBe(replacement.handoffToken());
    replacement.release();
  });

  test('the OS guard is exclusive, leaves no transition path, and releases its port after publish', async () => {
    const checkout = root();
    const guardPort = await freePort();
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen({ host: '127.0.0.1', port: guardPort }, resolve); });
    await expect(StartLock.acquireForCleanup(checkout, { guardPort })).rejects.toThrow(/cleanup recovery guard/);
    await close(occupied);

    const lease = await StartLock.acquireForCleanup(checkout, { guardPort });
    expect(existsSync(join(checkout, '.forgeax', 'run.lock.cleanup-transition'))).toBe(false);
    const reusable = createServer();
    await new Promise<void>((resolve, reject) => { reusable.once('error', reject); reusable.listen({ host: '127.0.0.1', port: guardPort }, resolve); });
    await close(reusable);
    lease.release();
  });

  test('does not strand a published cleanup lease when guard close rejects before delivery', async () => {
    const checkout = root();
    await expect(StartLock.acquireForCleanup(checkout, {
      guardPort: await freePort(),
      closeGuard: async (guard) => {
        await close(guard);
        throw new Error('simulated guard close failure');
      },
    })).rejects.toThrow('simulated guard close failure');
    expect(readStartLockOwner(checkout)).toBeNull();
  });
});
