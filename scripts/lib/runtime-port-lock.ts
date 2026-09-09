// Host-level startup lease for one RuntimeInstance port set.
//
// RuntimeInstance configuration is checkout-local, but its TCP ports are
// host-global. This lease closes the gap between a clean port probe and the
// first child bind. It is deliberately a startup lease only: once the
// launcher has published ready state, occupied ports themselves are the
// runtime ownership proof.

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isAlive, sleep } from './proc.ts';

const OWNER_FILE = 'owner.json';
const OWNER_SCHEMA_VERSION = 1;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 50;

export interface RuntimePortStartupLockOwner {
  readonly schemaVersion: typeof OWNER_SCHEMA_VERSION;
  readonly pid: number;
  readonly token: string;
  readonly root: string;
}

export interface RuntimePortStartupLockOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** Test seam; production uses the OS temporary directory. */
  readonly lockRoot?: string;
  readonly root?: string;
  /** Test seam; production proves owner liveness through the process table. */
  readonly isAlive?: (pid: number) => boolean;
}

export class RuntimePortStartupLockBusyError extends Error {
  constructor(
    readonly lockDir: string,
    readonly owner: RuntimePortStartupLockOwner,
  ) {
    super(`runtime port startup lease is busy at ${lockDir} (pid ${owner.pid}, root ${owner.root})`);
    this.name = 'RuntimePortStartupLockBusyError';
  }
}

export class RuntimePortStartupLockStaleError extends Error {
  constructor(readonly lockDir: string) {
    super(`runtime port startup lease at ${lockDir} has no trustworthy live owner; recover it explicitly`);
    this.name = 'RuntimePortStartupLockStaleError';
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`runtime port startup lease requires a port between 1 and 65535, got '${port}'`);
  }
}

function ownerFile(lockDir: string): string {
  return join(lockDir, OWNER_FILE);
}

function parseOwner(value: unknown): RuntimePortStartupLockOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const owner = value as Partial<RuntimePortStartupLockOwner>;
  if (
    owner.schemaVersion !== OWNER_SCHEMA_VERSION
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.token !== 'string'
    || owner.token.length < 16
    || typeof owner.root !== 'string'
    || owner.root.length === 0
  ) return null;
  return owner as RuntimePortStartupLockOwner;
}

function readOwnerFile(file: string): RuntimePortStartupLockOwner | null {
  try {
    return parseOwner(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function readOwner(lockDir: string): RuntimePortStartupLockOwner | null {
  return readOwnerFile(ownerFile(lockDir));
}

function sameOwner(left: RuntimePortStartupLockOwner | null, right: RuntimePortStartupLockOwner): boolean {
  return left?.schemaVersion === right.schemaVersion
    && left.pid === right.pid
    && left.token === right.token
    && left.root === right.root;
}

function lockPath(port: number, lockRoot = tmpdir()): string {
  validatePort(port);
  return join(resolve(lockRoot), `forgeax-runtime-port-${port}.lock`);
}

export function runtimePortStartupLockPath(port: number, lockRoot = tmpdir()): string {
  return lockPath(port, lockRoot);
}

function publish(lockDir: string, owner: RuntimePortStartupLockOwner): boolean {
  mkdirSync(dirname(lockDir), { recursive: true });
  const temporary = `${lockDir}.publish-${process.pid}-${owner.token}`;
  try {
    mkdirSync(temporary);
    writeFileSync(ownerFile(temporary), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    renameSync(temporary, lockDir);
    return true;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (existsSync(lockDir)) return false;
    throw error;
  }
}

/** Reclaims only the exact owner record that was proven dead. */
function reclaimDeadOwner(lockDir: string, expected: RuntimePortStartupLockOwner): boolean {
  const claim = join(lockDir, `.${OWNER_FILE}.reclaim-${process.pid}-${randomUUID()}`);
  const quarantine = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(ownerFile(lockDir), claim);
    if (!sameOwner(readOwnerFile(claim), expected)) {
      if (!existsSync(ownerFile(lockDir))) renameSync(claim, ownerFile(lockDir));
      return false;
    }
    renameSync(lockDir, quarantine);
  } catch {
    // Another publisher/reclaimer won the ownership race, or the lock is
    // malformed. Never remove a directory that no longer proves our claim.
    if (existsSync(claim) && !existsSync(ownerFile(lockDir))) {
      try { renameSync(claim, ownerFile(lockDir)); } catch { /* preserve fail-closed state */ }
    }
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

export class RuntimePortStartupLock {
  readonly lockDir: string;
  private readonly owner: RuntimePortStartupLockOwner;
  private held = false;

  private constructor(lockDir: string, owner: RuntimePortStartupLockOwner) {
    this.lockDir = lockDir;
    this.owner = owner;
  }

  static async acquire(port: number, options: RuntimePortStartupLockOptions = {}): Promise<RuntimePortStartupLock> {
    const lockDir = lockPath(port, options.lockRoot);
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error(`runtime port startup lease waitMs must be a non-negative integer, got '${waitMs}'`);
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error(`runtime port startup lease pollMs must be a positive integer, got '${pollMs}'`);
    const owner: RuntimePortStartupLockOwner = {
      schemaVersion: OWNER_SCHEMA_VERSION,
      pid: process.pid,
      token: randomUUID(),
      root: resolve(options.root ?? process.cwd()),
    };
    const lease = new RuntimePortStartupLock(lockDir, owner);
    const deadline = Date.now() + waitMs;
    while (true) {
      if (publish(lockDir, owner)) {
        lease.held = true;
        return lease;
      }
      const current = readOwner(lockDir);
      if (!current) throw new RuntimePortStartupLockStaleError(lockDir);
      if (!(options.isAlive ?? isAlive)(current.pid)) {
        if (reclaimDeadOwner(lockDir, current)) continue;
      }
      if (Date.now() >= deadline) throw new RuntimePortStartupLockBusyError(lockDir, current);
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  release(): void {
    if (!this.held || !sameOwner(readOwner(this.lockDir), this.owner)) return;
    rmSync(this.lockDir, { recursive: true, force: true });
    this.held = false;
  }
}

export interface RuntimePortStartupLocks {
  readonly ports: readonly number[];
  release(): void;
}

/** Acquire a port tuple in sorted order so overlapping starts cannot deadlock. */
export async function acquireRuntimePortStartupLocks(
  ports: readonly number[],
  options: RuntimePortStartupLockOptions = {},
): Promise<RuntimePortStartupLocks> {
  const uniquePorts = [...new Set(ports)].sort((left, right) => left - right);
  if (uniquePorts.length === 0) throw new Error('runtime port startup lease requires at least one port');
  const leases: RuntimePortStartupLock[] = [];
  try {
    for (const port of uniquePorts) leases.push(await RuntimePortStartupLock.acquire(port, options));
  } catch (error) {
    for (const lease of leases.reverse()) lease.release();
    throw error;
  }
  return {
    ports: uniquePorts,
    release: () => {
      for (const lease of [...leases].reverse()) lease.release();
    },
  };
}
