// scripts/lib/startlock.ts — owner-safe source-runtime startup lock.
//
// A lock is prepared in a sibling directory and renamed into place only after
// its complete owner record exists.  Never reclaim this lock implicitly: a
// stale lock is evidence that explicit recovery must perform the migration.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { isAlive } from './proc.ts';

export interface StartLockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly token: string;
}

const OWNER_FILE = 'owner.json';
const adopted = new Map<string, StartLock>();
export interface CleanupLockOptions {
  /** Instance-owned core server port used as an OS-released recovery guard. */
  readonly guardPort: number;
  /** Test seam: invoked only after this caller atomically isolated a stale lock. */
  readonly onQuarantined?: () => void | Promise<void>;
  /** Test seam for the guard close boundary. Production callers omit this. */
  readonly closeGuard?: (guard: Server) => Promise<void>;
}

export interface InstanceInitLockOptions {
  /** Test seam called only after the stale directory was atomically detached. */
  readonly onQuarantined?: () => void;
  /** Test seam called after the dead owner identity was atomically claimed. */
  readonly onClaimed?: () => void;
  /** Test seam invoked immediately before the atomic owner identity claim. */
  readonly onBeforeClaim?: () => void;
}

/** Strictly read-only contract for stop/recovery consumers. */
export function readStartLockOwner(root: string): StartLockOwner | null {
  return readStartLockOwnerFile(join(root, '.forgeax', 'run.lock', OWNER_FILE));
}

function readStartLockOwnerFile(file: string): StartLockOwner | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const owner = raw as Partial<StartLockOwner>;
    if (Object.keys(owner).some((key) => key !== 'schemaVersion' && key !== 'pid' && key !== 'token')) return null;
    if (
      owner.schemaVersion !== 1 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== 'string' ||
      owner.token.length < 16
    )
      return null;
    return owner as StartLockOwner;
  } catch {
    return null;
  }
}

export class StartLock {
  readonly lockDir: string;
  private held = false;
  private token = '';
  private pid = 0;

  constructor(readonly root: string) {
    this.lockDir = join(root, '.forgeax', 'run.lock');
  }

  acquire(): void {
    try {
      this.acquireOrThrow();
    } catch (error) {
      console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  acquireOrThrow(): void {
    mkdirSync(join(this.lockDir, '..'), { recursive: true });
    if (existsSync(this.lockDir)) {
      const existing = readStartLockOwner(this.root);
      if (existing && isAlive(existing.pid)) throw new StartLockHeldError(this.lockDir, existing.pid);
      // A malformed lock is stale too. It is never safe for a starter to
      // remove it because another owner may be publishing.
      throw new StartLockStaleError(this.lockDir, existing?.pid ?? 0);
    }
    const token = randomUUID();
    const temporary = `${this.lockDir}.publish-${process.pid}-${token}`;
    try {
      mkdirSync(temporary);
      writeFileSync(join(temporary, OWNER_FILE), `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, this.lockDir);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      const owner = readStartLockOwner(this.root);
      if (owner && isAlive(owner.pid)) throw new StartLockHeldError(this.lockDir, owner.pid);
      if (owner) throw new StartLockStaleError(this.lockDir, owner.pid);
      throw error;
    }
    this.held = true;
    this.token = token;
    this.pid = process.pid;
  }

  /**
   * Explicit bootstrap migration for `instance init` only. A dead strict
   * owner or legacy pid lock is atomically renamed out of the mutex namespace,
   * then this caller must acquire a brand-new lock before changing config.
   * A concurrent publisher that wins that interval stays at run.lock.
   */
  acquireForInstanceInitOrThrow(options: InstanceInitLockOptions = {}): void {
    mkdirSync(join(this.lockDir, '..'), { recursive: true });
    if (!existsSync(this.lockDir)) {
      this.acquireOrThrow();
      return;
    }

    const strictOwner = readStartLockOwner(this.root);
    const legacyPid = strictOwner === null ? readLegacyStartLockPid(this.lockDir) : 0;
    const ownerPid = strictOwner?.pid ?? legacyPid;
    if (ownerPid && isAlive(ownerPid)) throw new StartLockHeldError(this.lockDir, ownerPid);
    if (strictOwner === null && legacyPid === 0) {
      // A partially published or unknown-format lock cannot prove its former
      // owner is dead. Let explicit lifecycle recovery inspect it instead.
      throw new StartLockStaleError(this.lockDir, 0);
    }

    const quarantine = `${this.lockDir}.stale-${process.pid}-${randomUUID()}`;
    const claim = join(
      this.lockDir,
      `.${strictOwner === null ? 'pid' : OWNER_FILE}.instance-init-claim-${process.pid}-${randomUUID()}`,
    );
    try {
      // Claim the exact dead identity before moving its containing directory.
      // If cleanup replaces the directory after this move, `claim` disappears
      // from run.lock and the revalidation below refuses the replacement.
      options.onBeforeClaim?.();
      const ownerFile = join(this.lockDir, strictOwner === null ? 'pid' : OWNER_FILE);
      renameSync(ownerFile, claim);
      const claimMatches = strictOwner !== null
        ? sameOwner(readStartLockOwnerFile(claim), strictOwner)
        : readLegacyStartLockPidFile(claim) === legacyPid;
      if (!claimMatches) {
        // We claimed a replacement published after the initial read. Restore
        // only that exact claim; never overwrite a newer canonical owner.
        if (!existsSync(ownerFile)) renameSync(claim, ownerFile);
        const replacement = readStartLockOwner(this.root);
        if (replacement && isAlive(replacement.pid)) throw new StartLockHeldError(this.lockDir, replacement.pid);
        throw new StartLockStaleError(this.lockDir, ownerPid);
      }
      options.onClaimed?.();
      if (!existsSync(claim)) {
        const replacement = readStartLockOwner(this.root);
        if (replacement && isAlive(replacement.pid)) throw new StartLockHeldError(this.lockDir, replacement.pid);
        throw new StartLockStaleError(this.lockDir, ownerPid);
      }
      // rename is the ownership boundary: only this detached directory may be
      // removed below. A new owner published at run.lock is never deleted.
      renameSync(this.lockDir, quarantine);
    } catch (error) {
      const replacement = readStartLockOwner(this.root);
      if (replacement && isAlive(replacement.pid)) throw new StartLockHeldError(this.lockDir, replacement.pid);
      if (error instanceof StartLockHeldError || error instanceof StartLockStaleError) throw error;
      if (!existsSync(this.lockDir)) throw new StartLockStaleError(this.lockDir, ownerPid);
      throw error;
    }
    try {
      options.onQuarantined?.();
      this.acquireOrThrow();
    } finally {
      rmSync(quarantine, { recursive: true, force: true });
    }
  }

  /** Atomically transfer the parent lock to this detached launcher. */
  static adopt(root: string, token: string, parentPid: number): StartLock {
    const owner = readStartLockOwner(root);
    const lock = new StartLock(root);
    if (!owner || owner.token !== token || owner.pid !== parentPid) {
      throw new Error('start lock handoff was rejected: owner token or parent PID did not match');
    }
    lock.replaceOwner(token, process.pid);
    lock.held = true;
    lock.token = token;
    lock.pid = process.pid;
    adopted.set(lock.lockDir, lock);
    return lock;
  }

  /** Register a directly-invoked launcher as this module's runtime owner. */
  static acquireForRuntime(root: string): StartLock {
    const lock = new StartLock(root);
    lock.acquireOrThrow();
    adopted.set(lock.lockDir, lock);
    return lock;
  }

  /**
   * Acquires the run lock before cleanup removes any runtime artifact.
   *
   * Unlike normal start acquisition, cleanup may recover a stale/malformed
   * lock, but only by atomically moving that exact directory aside first. A
   * concurrent new owner therefore remains at run.lock and is never removed.
   */
  static async acquireForCleanup(root: string, options: CleanupLockOptions): Promise<StartLock> {
    const lock = new StartLock(root);
    mkdirSync(join(lock.lockDir, '..'), { recursive: true });
    const guard = await acquireCleanupGuard(options.guardPort);
    let quarantine = '';
    let published = false;
    let primaryError: unknown;
    try {
      if (!existsSync(lock.lockDir)) {
        lock.acquireOrThrow();
        published = true;
        return lock;
      }

      const owner = readStartLockOwner(root);
      const legacyPid = owner === null ? readLegacyStartLockPid(lock.lockDir) : 0;
      const ownerPid = owner?.pid ?? legacyPid;
      if (ownerPid && isAlive(ownerPid)) throw new StartLockHeldError(lock.lockDir, ownerPid);
      if (owner || legacyPid) {
        const claim = join(
          lock.lockDir,
          `.${owner === null ? 'pid' : OWNER_FILE}.cleanup-claim-${process.pid}-${randomUUID()}`,
        );
        try {
          // Coordinate with instance-init's identical identity claim. Whoever
          // moves owner.json/pid first is the only caller allowed to move the
          // containing stale directory.
          const ownerFile = join(lock.lockDir, owner === null ? 'pid' : OWNER_FILE);
          renameSync(ownerFile, claim);
          const claimMatches = owner !== null
            ? sameOwner(readStartLockOwnerFile(claim), owner)
            : readLegacyStartLockPidFile(claim) === legacyPid;
          if (!claimMatches) {
            if (!existsSync(ownerFile)) renameSync(claim, ownerFile);
            const replacement = readStartLockOwner(root);
            if (replacement && isAlive(replacement.pid)) throw new StartLockHeldError(lock.lockDir, replacement.pid);
            throw new StartLockStaleError(lock.lockDir, ownerPid);
          }
        } catch (error) {
          const replacement = readStartLockOwner(root);
          if (replacement && isAlive(replacement.pid)) throw new StartLockHeldError(lock.lockDir, replacement.pid);
          throw error;
        }
      } else if (hasRecoveryClaim(lock.lockDir)) {
        throw new StartLockStaleError(lock.lockDir, 0);
      }
      quarantine = `${lock.lockDir}.stale-${process.pid}-${randomUUID()}`;
      renameSync(lock.lockDir, quarantine);
      await options.onQuarantined?.();
      lock.acquireOrThrow();
      published = true;
      return lock;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      // This is our uniquely named, already-detached stale directory. It is
      // the only cleanup path permitted to use unconditional removal.
      if (quarantine) rmSync(quarantine, { recursive: true, force: true });
      try {
        await (options.closeGuard ?? closeCleanupGuard)(guard);
      } catch (closeError) {
        // The lease is not observable by the caller until this async method
        // resolves. Do not strand a newly published owner if closing its
        // short-lived recovery guard fails at that delivery boundary.
        if (published) lock.release();
        if (primaryError) {
          throw new AggregateError([primaryError, closeError], 'cleanup acquisition and guard close both failed');
        }
        throw closeError;
      }
    }
  }

  static consumeRuntimeOwner(root: string): StartLock | null {
    const lockDir = join(root, '.forgeax', 'run.lock');
    const lock = adopted.get(lockDir) ?? null;
    adopted.delete(lockDir);
    return lock;
  }

  handoffToken(): string {
    if (!this.held) throw new Error('cannot hand off a start lock that is not held');
    return this.token;
  }

  /** Parent-only cleanup after a failed handoff, guarded by adopted PID/token. */
  releaseHandoffFailure(adoptedPid: number): void {
    const owner = readStartLockOwner(this.root);
    if (!this.held || owner?.token !== this.token || (owner.pid !== this.pid && owner.pid !== adoptedPid)) return;
    if (owner.pid === adoptedPid && isAlive(adoptedPid)) return;
    rmSync(this.lockDir, { recursive: true, force: true });
    this.held = false;
  }

  release(): void {
    if (!this.held || !this.matchesOwner(this.pid)) return;
    rmSync(this.lockDir, { recursive: true, force: true });
    this.held = false;
  }

  private matchesOwner(pid: number): boolean {
    const owner = readStartLockOwner(this.root);
    return owner?.pid === pid && owner.token === this.token;
  }

  private replaceOwner(token: string, pid: number): void {
    const temp = join(this.lockDir, `${OWNER_FILE}.${process.pid}-${randomUUID()}`);
    writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, pid, token })}\n`, { mode: 0o600 });
    renameSync(temp, join(this.lockDir, OWNER_FILE));
  }
}

function acquireCleanupGuard(guardPort: number): Promise<Server> {
  if (!Number.isSafeInteger(guardPort) || guardPort < 1 || guardPort > 65_535) {
    return Promise.reject(new Error(`cleanup guard port must be between 1 and 65535, got '${guardPort}'`));
  }
  return new Promise((resolve, reject) => {
    const guard = createServer();
    const fail = (error: Error) => {
      guard.removeAllListeners();
      reject(new Error(`could not acquire cleanup recovery guard on 127.0.0.1:${guardPort}: ${error.message}`));
    };
    guard.once('error', fail);
    guard.once('listening', () => {
      guard.removeListener('error', fail);
      resolve(guard);
    });
    guard.listen({ host: '127.0.0.1', port: guardPort, exclusive: true });
  });
}

function closeCleanupGuard(guard: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    guard.close((error) => error ? reject(error) : resolve());
  });
}

export class StartLockHeldError extends Error {
  constructor(
    readonly lockDir: string,
    readonly pid: number,
  ) {
    super(
      `another run is already starting or running this stack (pid ${pid}); stop it with 'bun fx stop' before changing the instance`,
    );
    this.name = 'StartLockHeldError';
  }
}

export class StartLockStaleError extends Error {
  constructor(
    readonly lockDir: string,
    readonly pid: number,
  ) {
    super(`stale start lock at ${lockDir} (owner pid ${pid || 'unknown'}); run 'bun fx stop' to recover it`);
    this.name = 'StartLockStaleError';
  }
}

function readLegacyStartLockPid(lockDir: string): number {
  return readLegacyStartLockPidFile(join(lockDir, 'pid'));
}

function readLegacyStartLockPidFile(file: string): number {
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (!/^\d+$/.test(value)) return 0;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function sameOwner(left: StartLockOwner | null, right: StartLockOwner): boolean {
  return left?.schemaVersion === right.schemaVersion && left.pid === right.pid && left.token === right.token;
}

function hasRecoveryClaim(lockDir: string): boolean {
  try {
    return readdirSync(lockDir).some((entry) => /\.(?:owner\.json|pid)\.(?:instance-init|cleanup)-claim-/.test(entry));
  } catch {
    return false;
  }
}
