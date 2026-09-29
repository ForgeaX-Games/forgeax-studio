/**
 * The three-user-config install transaction.
 *
 * This module intentionally does not know about projects, Engine games, Preview,
 * Asset3D, or Studio.  Its only product state is the three user MCP config files and
 * an external, plugin-owned recovery directory.  All parsing happens before locks or
 * target writes; all target writes happen through same-directory durable temporary
 * files; rollback is guarded by the postimage digest so a concurrent edit is never
 * overwritten.
 */
import {
  closeSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configuredHome, INSTALL_CLIENT_IDS, INSTALL_CLIENTS, launchSpec, type ClientSpec } from './clients';
import type { LaunchSpec } from './clients';
import { buildEntry, mergeJsonConfig, mergeTomlConfig } from './write-config';
import { assertReleaseIdentity, RELEASE_IDENTITY_MIME, RELEASE_IDENTITY_URI, type ReleaseIdentity } from './release-manifest';
import { INSTALL_VERIFY_TIMEOUT_MS, verifyLaunchForInstall, type InstallVerification } from './verify';

export type InstallPhase =
  | 'PREPARING'
  | 'PREPARED'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'CLEANING'
  | 'CLEANED'
  | 'ROLLING_BACK'
  | 'ROLLED_BACK'
  | 'RECOVERY_REQUIRED';

export type InstallTargetState =
  | 'PLANNED'
  | 'TEMP_DURABLE'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'CONCURRENT';

export interface InstallPreimage {
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly mode: number | null;
  readonly backupRelativePath: string | null;
}

export interface InstallJournalTarget {
  readonly client: string;
  readonly path: string;
  readonly lockPath: string;
  readonly tempName: string;
  readonly preimage: InstallPreimage;
  readonly postimageSha256: string | null;
  readonly state: InstallTargetState;
  readonly error?: string;
}

export interface InstallJournal {
  readonly schema: 'install-transaction/1';
  readonly transactionUuid: string;
  readonly transactionKey: string;
  readonly canonicalHome: string;
  readonly createdAt: string;
  readonly phase: InstallPhase;
  readonly commitOrder: readonly string[];
  readonly targets: readonly InstallJournalTarget[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface InstallTargetResult {
  readonly client: string;
  readonly path: string;
  readonly status: 'CURRENT' | 'UPDATED' | 'ROLLED_BACK';
  readonly preimage: InstallPreimage;
  readonly postimageSha256: string;
}

export interface InstallResult {
  readonly phase: 'COMMITTED' | 'CURRENT' | 'ROLLED_BACK';
  readonly transactionKey?: string;
  readonly transactionUuid?: string;
  readonly releaseIdentity: ReleaseIdentity;
  readonly targets: readonly InstallTargetResult[];
  readonly lockOrder: readonly string[];
}

export interface InstallFaultHooks {
  /** Throw after the Nth target has been committed, before the next commit. */
  readonly failAfterCommit?: number;
  /** Test-only deterministic hook; it may edit a target to model a race. */
  readonly afterCommit?: (target: InstallTargetResult, index: number) => void;
  /** Test-only hook immediately before a target's rename. */
  readonly beforeCommit?: (target: InstallTargetResult, index: number) => void;
}

export interface InstallOptions {
  readonly clients?: readonly ClientSpec[];
  readonly launch?: LaunchSpec;
  readonly home?: string;
  readonly stateRoot?: string;
  readonly cwd?: string;
  readonly transactionUuid?: string;
  readonly verify?: (launch: LaunchSpec, timeoutMs?: number) => Promise<InstallVerification>;
  readonly faults?: InstallFaultHooks;
}

interface TargetPlan {
  readonly client: ClientSpec;
  readonly path: string;
  readonly parent: string;
  readonly lockPath: string;
  readonly existing: Buffer | undefined;
  readonly existingMode: number | null;
  readonly existingDevice: number | null;
  readonly existingInode: number | null;
  readonly merged: Buffer;
  readonly changed: boolean;
  readonly preimage: InstallPreimage;
  readonly postimageSha256: string;
  readonly tempName: string;
}

interface MutableJournalTarget extends InstallJournalTarget {
  state: InstallTargetState;
  error?: string;
}

interface MutableJournal extends Omit<InstallJournal, 'phase' | 'targets' | 'error'> {
  phase: InstallPhase;
  targets: MutableJournalTarget[];
  error?: { code: string; message: string };
}

interface TransactionPaths {
  readonly stateRoot: string;
  readonly installRoot: string;
  readonly keyRoot: string;
  readonly transactionRoot: string;
  readonly journal: string;
  readonly preimages: string;
}

const INSTALL_SCHEMA = 'install-transaction/1' as const;
const DEFAULT_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export class InstallTransactionError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly journal?: InstallJournal;

  constructor(code: string, message: string, options?: { path?: string; journal?: InstallJournal }) {
    super(`${code}: ${message}`);
    this.name = 'InstallTransactionError';
    this.code = code;
    this.path = options?.path;
    this.journal = options?.journal;
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function sortUtf8(values: readonly string[]): string[] {
  return [...values].sort(compareUtf8);
}

function errorCode(error: unknown): string {
  if (error instanceof InstallTransactionError) return error.code;
  return error instanceof Error ? error.name || 'INSTALL_FAILED' : 'INSTALL_FAILED';
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 512);
}

function throwConfig(message: string, path?: string): never {
  throw new InstallTransactionError('INSTALL_CONFIG_INVALID', message, path ? { path } : undefined);
}

function canonicalHome(input?: string): string {
  const raw = resolve(input ?? configuredHome() ?? homedir());
  let stat;
  try {
    stat = lstatSync(raw);
  } catch (error) {
    throwConfig(`canonical home is unavailable: ${raw} (${safeMessage(error)})`);
  }
  // HOME itself may be a user-selected symlink (for example a managed macOS
  // volume).  It is canonicalized before any containment or lock decision.  The
  // target and every existing child component are still rejected when symlinked.
  if (!stat.isDirectory() && !stat.isSymbolicLink()) throwConfig(`canonical home is not a directory: ${raw}`);
  try {
    const canonical = realpathNative(raw);
    const canonicalStat = lstatSync(canonical);
    if (!canonicalStat.isDirectory()) throwConfig(`canonical home is not a directory: ${raw}`);
    return canonical;
  } catch (error) {
    throwConfig(`canonical home cannot be resolved: ${raw} (${safeMessage(error)})`);
  }
}

function realpathNative(path: string): string {
  // The caller has already rejected symlinks in every component it owns.  Native
  // realpath still gives us the platform's canonical byte path for lock ordering.
  return (realpathSync.native ?? realpathSync)(path);
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function existingPathInfo(path: string): { readonly mode: number; readonly dev: number; readonly ino: number } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throwConfig(`target disappeared during preflight: ${path}`, path);
    }
    throwConfig(`cannot inspect target ${path}: ${safeMessage(error)}`, path);
  }
  if (stat.isSymbolicLink()) throwConfig(`target or ancestor is a symlink: ${path}`, path);
  if (!stat.isFile() || stat.nlink !== 1) throwConfig(`target must be one regular file: ${path}`, path);
  return { mode: stat.mode & 0o7777, dev: stat.dev, ino: stat.ino };
}

/** Validate every existing component without ever resolving through a symlink. */
function canonicalTarget(input: string, home: string): { path: string; parent: string; info?: ReturnType<typeof existingPathInfo> } {
  const lexical = resolve(input);
  if (!inside(home, lexical) || lexical === home) throwConfig(`target escapes canonical home: ${lexical}`, lexical);
  const rel = relative(home, lexical).split(sep).filter(Boolean);
  let current = home;
  for (let index = 0; index < rel.length; index++) {
    current = join(current, rel[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throwConfig(`target or ancestor is a symlink: ${current}`, lexical);
      if (index < rel.length - 1 && !stat.isDirectory()) {
        throwConfig(`target parent is not a directory: ${current}`, lexical);
      }
    } catch (error) {
      if (error instanceof InstallTransactionError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throwConfig(`cannot inspect target component ${current}: ${safeMessage(error)}`, lexical);
    }
  }
  if (!existsSync(lexical)) return { path: lexical, parent: dirname(lexical) };
  const info = existingPathInfo(lexical);
  let real: string;
  try {
    real = realpathNative(lexical);
  } catch (error) {
    throwConfig(`target cannot be canonicalized: ${lexical} (${safeMessage(error)})`, lexical);
  }
  if (!inside(home, real)) throwConfig(`target resolves outside canonical home: ${lexical}`, lexical);
  return { path: real, parent: dirname(real), info };
}

function ensureSecureDirectory(path: string, mode = DIRECTORY_MODE): string[] {
  const absolute = resolve(path);
  const components = absolute.split(sep);
  let current = components[0] === '' ? sep : components.shift()!;
  const created: string[] = [];
  for (const component of components) {
    if (!component) continue;
    current = current === sep ? join(current, component) : join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new InstallTransactionError('INSTALL_CONFIG_INVALID', `state path is not a directory: ${current}`, { path: current });
      }
    } catch (error) {
      if (error instanceof InstallTransactionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new InstallTransactionError('INSTALL_CONFIG_INVALID', `cannot inspect state path ${current}: ${safeMessage(error)}`, { path: current });
      }
      mkdirSync(current, mode);
      created.push(current);
      // The directory is plugin-owned from this point onward; enforce the frozen
      // restrictive mode even on filesystems whose umask would otherwise differ.
      chmodSync(current, mode);
    }
  }
  return created;
}

function fsyncParent(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch (error) {
    throw new InstallTransactionError('INSTALL_DURABILITY_FAILED', `cannot fsync directory ${path}: ${safeMessage(error)}`, { path });
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* preserve the original durability error */
      }
    }
  }
}

function writeFd(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

function durableCreate(path: string, bytes: Buffer, mode: number): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
  try {
    fchmodSync(fd, mode);
    writeFd(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParent(dirname(path));
}

function durableAtomicReplace(path: string, bytes: Buffer, mode: number, token: string): void {
  const parent = dirname(path);
  const temp = join(parent, `.${basenameSafe(path)}.forgeax-${token}.tmp`);
  if (existsSync(temp)) throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `owned temporary path already exists: ${temp}`, { path: temp });
  try {
    durableCreate(temp, bytes, mode);
    renameSync(temp, path);
    fsyncParent(parent);
  } finally {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        /* keep the error that caused recovery */
      }
    }
  }
}

function basenameSafe(path: string): string {
  const value = path.slice(path.lastIndexOf(sep) + 1);
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Transaction IDs are path components, never caller-controlled path fragments. */
function validTransactionToken(token: string): boolean {
  return token !== '.' && token !== '..' && /^[A-Za-z0-9._-]{1,128}$/.test(token);
}

function removeOwned(path: string, expectedType: 'file' | 'directory'): boolean {
  try {
    const stat = lstatSync(path);
    if (expectedType === 'file') {
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      unlinkSync(path);
    } else {
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      rmdirSync(path);
    }
    fsyncParent(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new InstallTransactionError('INSTALL_DURABILITY_FAILED', `cannot remove owned path ${path}: ${safeMessage(error)}`, { path });
  }
}

function stateRootFor(home: string, explicit?: string): string {
  if (explicit) return canonicalizeStatePath(resolve(explicit));
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'ForgeaX', 'game');
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && isAbsolute(xdg)) return canonicalizeStatePath(join(resolve(xdg), 'forgeax', 'game'));
  return join(home, '.local', 'state', 'forgeax', 'game');
}

/** Canonicalize trusted existing ancestors (macOS `/var` is commonly a symlink). */
function canonicalizeStatePath(input: string): string {
  let current = input;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return input;
    missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  try {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new InstallTransactionError('INSTALL_CONFIG_INVALID', `state root is not a directory: ${input}`, { path: input });
    }
    let canonical = realpathNative(current);
    for (const component of missing.reverse()) canonical = join(canonical, component);
    return canonical;
  } catch (error) {
    if (error instanceof InstallTransactionError) throw error;
    throw new InstallTransactionError('INSTALL_CONFIG_INVALID', `state root cannot be canonicalized: ${input}: ${safeMessage(error)}`, { path: input });
  }
}

function transactionKey(paths: readonly string[]): string {
  return sha256(Buffer.from(sortUtf8(paths).join('\0'), 'utf8'));
}

function transactionPaths(home: string, targets: readonly string[], stateRoot: string, uuid: string): TransactionPaths {
  const installRoot = join(stateRoot, 'install');
  const keyRoot = join(installRoot, transactionKey(targets));
  const transactionRoot = join(keyRoot, uuid);
  return {
    stateRoot,
    installRoot,
    keyRoot,
    transactionRoot,
    journal: join(transactionRoot, 'journal.json'),
    preimages: join(transactionRoot, 'preimages'),
  };
}

function readUtf8(path: string, bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throwConfig(`config is not valid UTF-8: ${path}`, path);
  return text;
}

function preimageFor(existing: Buffer | undefined, mode: number | null, backupRelativePath: string | null): InstallPreimage {
  return {
    exists: existing !== undefined,
    sha256: existing ? sha256(existing) : null,
    mode: mode === null ? null : mode,
    backupRelativePath,
  };
}

function currentSnapshot(path: string): { exists: boolean; bytes?: Buffer; sha256: string | null; mode: number | null; dev?: number; ino?: number } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, sha256: null, mode: null };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    return { exists: true, sha256: null, mode: stat.mode & 0o7777, dev: stat.dev, ino: stat.ino };
  }
  const bytes = readFileSync(path);
  return { exists: true, bytes, sha256: sha256(bytes), mode: stat.mode & 0o7777, dev: stat.dev, ino: stat.ino };
}

function matchesPreimage(snapshot: ReturnType<typeof currentSnapshot>, preimage: InstallPreimage): boolean {
  return snapshot.exists === preimage.exists && snapshot.sha256 === preimage.sha256 && snapshot.mode === preimage.mode;
}

function matchesDigest(snapshot: ReturnType<typeof currentSnapshot>, digest: string | null): boolean {
  return snapshot.exists && snapshot.sha256 === digest;
}

function ownedTempMatches(path: string, expectedDigest: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `cannot inspect owned temporary path ${path}: ${safeMessage(error)}`, { path });
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `owned temporary path is not a regular file: ${path}`, { path });
  }
  return sha256(readFileSync(path)) === expectedDigest;
}

function journalBytes(journal: InstallJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8');
}

function writeJournal(path: string, journal: InstallJournal, token: string, createOnly = false): void {
  const parent = dirname(path);
  const temp = join(parent, `.journal-${token}.tmp`);
  if (existsSync(temp)) throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `journal temporary path already exists: ${temp}`, { path: temp });
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `journal destination is not a regular file: ${path}`, { path });
    }
    if (createOnly) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `journal destination already exists: ${path}`, { path });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    durableCreate(temp, journalBytes(journal), DEFAULT_MODE);
    renameSync(temp, path);
    fsyncParent(parent);
  } finally {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        /* preserve the original failure */
      }
    }
  }
}

function readJournal(path: string): InstallJournal | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as InstallJournal;
    if (value.schema !== INSTALL_SCHEMA || typeof value.transactionUuid !== 'string' || !Array.isArray(value.targets)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function updateJournal(paths: TransactionPaths, journal: MutableJournal): void {
  writeJournal(paths.journal, journal, journal.transactionUuid);
}

function lockMetadata(uuid: string, home: string, releaseDigest: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      schema: 'forgeax-install-lock/1',
      transactionUuid: uuid,
      canonicalHome: home,
      releaseDigest,
      hostname: hostname(),
      pid: process.pid,
      processStartIdentity: `${process.pid}:${Math.floor(process.uptime() * 1000)}`,
      createdAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
}

function lockFile(path: string, bytes: Buffer): void {
  try {
    durableCreate(path, bytes, DEFAULT_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new InstallTransactionError('INSTALL_ALREADY_RUNNING', `target lock already exists: ${path}`, { path });
    }
    throw error;
  }
}

function releaseLock(path: string, uuid: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return;
    let metadata: unknown;
    try {
      metadata = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return;
    }
    if ((metadata as { transactionUuid?: unknown })?.transactionUuid !== uuid) return;
    unlinkSync(path);
    fsyncParent(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new InstallTransactionError('INSTALL_DURABILITY_FAILED', `cannot release lock ${path}: ${safeMessage(error)}`, { path });
    }
  }
}

function targetResult(plan: TargetPlan, status: InstallTargetResult['status']): InstallTargetResult {
  return {
    client: plan.client.id,
    path: plan.path,
    status,
    preimage: plan.preimage,
    postimageSha256: plan.postimageSha256,
  };
}

function targetState(journal: MutableJournal, path: string, state: InstallTargetState, error?: string): void {
  const target = journal.targets.find((entry) => entry.path === path);
  if (!target) throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `journal target disappeared: ${path}`, { path });
  target.state = state;
  if (error) target.error = error;
}

function journalError(journal: MutableJournal, error: unknown): void {
  journal.error = { code: errorCode(error), message: safeMessage(error) };
}

function restorePreimage(plan: TargetPlan, paths: TransactionPaths, token: string): void {
  if (!plan.preimage.exists) {
    const snapshot = currentSnapshot(plan.path);
    if (!matchesDigest(snapshot, plan.postimageSha256)) {
      throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `postimage changed before removing created target: ${plan.path}`, { path: plan.path });
    }
    unlinkSync(plan.path);
    fsyncParent(plan.parent);
    return;
  }
  const backupRelative = plan.preimage.backupRelativePath;
  if (!backupRelative) throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `missing preimage record for ${plan.path}`, { path: plan.path });
  const backupPath = join(paths.transactionRoot, backupRelative);
  const backupStat = lstatSync(backupPath);
  if (backupStat.isSymbolicLink() || !backupStat.isFile() || backupStat.nlink !== 1) {
    throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `invalid preimage backup for ${plan.path}`, { path: backupPath });
  }
  const bytes = readFileSync(backupPath);
  if (sha256(bytes) !== plan.preimage.sha256) throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `preimage digest changed for ${plan.path}`, { path: backupPath });
  durableAtomicReplace(plan.path, bytes, plan.preimage.mode ?? DEFAULT_MODE, token);
}

function rollback(
  plans: readonly TargetPlan[],
  paths: TransactionPaths,
  journal: MutableJournal,
): boolean {
  journal.phase = 'ROLLING_BACK';
  updateJournal(paths, journal);
  let conflict = false;
  for (const plan of [...plans].reverse()) {
    const target = journal.targets.find((entry) => entry.path === plan.path)!;
    // A target whose merge was already byte-identical was never part of the
    // visible mutation.  Never replace it during rollback: doing so would churn
    // its inode/mtime and could overwrite an equal-byte concurrent mode change.
    if (!plan.changed) continue;
    const snapshot = currentSnapshot(plan.path);
    // A rename may have succeeded immediately before a directory fsync or journal
    // update failed, leaving the journal at TEMP_DURABLE.  Treat an exact postimage
    // as committed regardless of that last durable state; treating it as a mere
    // temporary would leak a partially installed config.
    if (matchesDigest(snapshot, plan.postimageSha256)) {
      try {
        restorePreimage(plan, paths, journal.transactionUuid);
        target.state = 'ROLLED_BACK';
        updateJournal(paths, journal);
      } catch (error) {
        target.state = 'CONCURRENT';
        target.error = safeMessage(error);
        conflict = true;
        updateJournal(paths, journal);
      }
      continue;
    }
    if (matchesPreimage(snapshot, plan.preimage)) {
      if (target.state === 'TEMP_DURABLE') {
        try {
          const temp = join(plan.parent, plan.tempName);
          if (ownedTempMatches(temp, sha256(plan.merged))) {
            unlinkSync(temp);
            fsyncParent(plan.parent);
          } else if (lstatSync(temp).isFile()) {
            target.state = 'CONCURRENT';
            target.error = 'owned temporary postimage changed before rollback';
            conflict = true;
            updateJournal(paths, journal);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            target.state = 'CONCURRENT';
            target.error = safeMessage(error);
            conflict = true;
            updateJournal(paths, journal);
          }
        }
      }
      continue;
    }
    if (target.state === 'PLANNED' && !plan.changed) continue;
    {
      target.state = 'CONCURRENT';
      target.error = 'current target no longer matches this transaction postimage';
      conflict = true;
      updateJournal(paths, journal);
    }
  }
  if (conflict) {
    journal.phase = 'RECOVERY_REQUIRED';
    journalError(journal, new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', 'a concurrent config edit was preserved'));
    updateJournal(paths, journal);
    return false;
  }
  journal.phase = 'ROLLED_BACK';
  updateJournal(paths, journal);
  return true;
}

function cleanupTransaction(
  plans: readonly TargetPlan[],
  paths: TransactionPaths,
  journal: MutableJournal,
): void {
  journal.phase = 'CLEANING';
  updateJournal(paths, journal);
  for (const plan of plans) {
    const temp = join(plan.parent, plan.tempName);
    try {
      if (ownedTempMatches(temp, sha256(plan.merged))) {
        unlinkSync(temp);
        fsyncParent(plan.parent);
      } else if (lstatSync(temp).isFile()) {
        throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `owned temporary path changed before cleanup: ${temp}`, { path: temp });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (existsSync(paths.preimages)) {
    for (const entry of readdirSync(paths.preimages)) {
      const path = join(paths.preimages, entry);
      removeOwned(path, 'file');
    }
    removeOwned(paths.preimages, 'directory');
  }
  journal.phase = 'CLEANED';
  updateJournal(paths, journal);
  removeOwned(paths.journal, 'file');
  removeOwned(paths.transactionRoot, 'directory');
  try {
    if (readdirSync(paths.keyRoot).length === 0) removeOwned(paths.keyRoot, 'directory');
  } catch {
    /* leave a non-empty or externally changed key directory intact */
  }
}

/** Remove only the known local residue from a transaction before its journal existed. */
function cleanupBareTransaction(paths: TransactionPaths, token: string): void {
  if (!validTransactionToken(token)) {
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `transaction id is not a safe path component: ${token}`, { path: paths.transactionRoot });
  }
  let entries: string[];
  try {
    entries = readdirSync(paths.transactionRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect bare transaction: ${paths.transactionRoot}`, { path: paths.transactionRoot });
  }
  const journalTemp = `.journal-${token}.tmp`;
  for (const entry of entries) {
    if (entry === journalTemp) {
      removeOwned(join(paths.transactionRoot, entry), 'file');
      continue;
    }
    if (entry === 'preimages') {
      let stat;
      try {
        stat = lstatSync(paths.preimages);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect bare preimages: ${paths.preimages}`, { path: paths.preimages });
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `bare preimages is not a directory: ${paths.preimages}`, { path: paths.preimages });
      }
      for (const preimage of readdirSync(paths.preimages)) {
        if (!/^\d+$/.test(preimage)) {
          throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `unexpected bare preimage: ${preimage}`, { path: join(paths.preimages, preimage) });
        }
        removeOwned(join(paths.preimages, preimage), 'file');
      }
      removeOwned(paths.preimages, 'directory');
      continue;
    }
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `unexpected bare transaction entry: ${entry}`, { path: join(paths.transactionRoot, entry) });
  }
  removeOwned(paths.journal, 'file');
  removeOwned(paths.transactionRoot, 'directory');
  try {
    if (readdirSync(paths.keyRoot).length === 0) removeOwned(paths.keyRoot, 'directory');
  } catch {
    /* leave a non-empty or externally changed key directory intact */
  }
}

function validateRecoveryJournal(journal: InstallJournal, key: string, home: string, paths: TransactionPaths): void {
  if (
    journal.schema !== INSTALL_SCHEMA ||
    !validTransactionToken(journal.transactionUuid) ||
    journal.transactionKey !== key ||
    journal.canonicalHome !== home ||
    journal.transactionUuid !== paths.transactionRoot.slice(paths.transactionRoot.lastIndexOf(sep) + 1)
  ) {
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery journal does not match canonical install transaction: ${paths.journal}`, { path: paths.journal });
  }
  const seen = new Set<string>();
  for (const target of journal.targets) {
    const canonicalPath = resolve(target.path);
    const expectedLock = join(dirname(canonicalPath), `.${basenameSafe(canonicalPath)}.forgeax.lock`);
    const expectedTemp = `.${basenameSafe(canonicalPath)}.forgeax-${journal.transactionUuid}.tmp`;
    if (
      canonicalPath !== target.path ||
      !inside(home, target.path) ||
      !inside(home, target.lockPath) ||
      target.lockPath !== expectedLock ||
      target.tempName !== expectedTemp
    ) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery journal target escapes canonical home: ${target.path}`, { path: target.path });
    }
    if (seen.has(target.path)) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery journal contains duplicate target: ${target.path}`, { path: target.path });
    }
    seen.add(target.path);
    if (
      typeof target.preimage.exists !== 'boolean' ||
      (target.preimage.sha256 !== null && !/^[0-9a-f]{64}$/.test(target.preimage.sha256)) ||
      (target.preimage.mode !== null && (!Number.isInteger(target.preimage.mode) || target.preimage.mode < 0 || target.preimage.mode > 0o7777)) ||
      (target.preimage.exists && (target.preimage.sha256 === null || target.preimage.mode === null)) ||
      (!target.preimage.exists && (target.preimage.sha256 !== null || target.preimage.mode !== null || target.preimage.backupRelativePath !== null)) ||
      !['PLANNED', 'TEMP_DURABLE', 'COMMITTED', 'ROLLED_BACK', 'CONCURRENT'].includes(target.state)
    ) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery preimage/state is invalid: ${target.path}`, { path: target.path });
    }
    // The journal is untrusted input after a crash.  Re-walk all existing target
    // ancestors without following symlinks before inspecting or restoring bytes.
    const components = relative(home, target.path).split(sep).filter(Boolean);
    let current = home;
    for (const [index, component] of components.entries()) {
      current = join(current, component);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery target ancestor is a symlink: ${current}`, { path: current });
        }
        if (index < components.length - 1 && !stat.isDirectory()) {
          throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery target parent is not a directory: ${current}`, { path: current });
        }
      } catch (error) {
        if (error instanceof InstallTransactionError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect recovery target ${current}: ${safeMessage(error)}`, { path: current });
      }
    }
    if (target.preimage.exists && (!target.preimage.backupRelativePath || !/^preimages\/\d+$/.test(target.preimage.backupRelativePath))) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery preimage path is invalid: ${target.path}`, { path: target.path });
    }
  }
}

function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM still means that a live process owns the pid; only an absent process
    // can make a lock reclaimable.
    return code !== 'ESRCH' && code !== 'ENOENT';
  }
}

function reclaimStaleRecoveryLock(path: string, journal: InstallJournal, home: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect recovery lock ${path}: ${safeMessage(error)}`, { path });
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery lock is not a regular file: ${path}`, { path });
  }
  let metadata: { transactionUuid?: unknown; canonicalHome?: unknown; pid?: unknown };
  try {
    metadata = JSON.parse(readFileSync(path, 'utf8')) as typeof metadata;
  } catch {
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery lock metadata is invalid: ${path}`, { path });
  }
  if (metadata.transactionUuid !== journal.transactionUuid || metadata.canonicalHome !== home) {
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery lock does not match journal: ${path}`, { path });
  }
  if (processIsAlive(metadata.pid)) {
    throw new InstallTransactionError('INSTALL_ALREADY_RUNNING', `recovery lock owner is still alive: ${path}`, { path });
  }
  unlinkSync(path);
  fsyncParent(dirname(path));
}

function acquireRecoveryLocks(journal: InstallJournal, home: string, key: string): { uuid: string; paths: string[] } {
  const uuid = randomUUID();
  const acquired: string[] = [];
  try {
    const lockPaths = [...journal.targets].map((target) => target.lockPath).sort(compareUtf8);
    for (const path of lockPaths) {
      reclaimStaleRecoveryLock(path, journal, home);
      lockFile(path, lockMetadata(uuid, home, `sha256:${key}`));
      acquired.push(path);
    }
    return { uuid, paths: acquired };
  } catch (error) {
    for (const path of acquired) {
      try {
        releaseLock(path, uuid);
      } catch {
        /* Preserve a lock whose ownership bytes changed. */
      }
    }
    throw error;
  }
}

function plansFromJournal(journal: InstallJournal, txRoot: string): TargetPlan[] {
  return journal.targets.map((target) => {
    const backup = target.preimage.backupRelativePath ? join(txRoot, target.preimage.backupRelativePath) : undefined;
    let bytes: Buffer | undefined;
    if (backup) {
      try {
        const backupStat = lstatSync(backup);
        if (backupStat.isSymbolicLink() || !backupStat.isFile() || backupStat.nlink !== 1) {
          throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery preimage backup is not a regular file: ${backup}`, { path: backup });
        }
        bytes = readFileSync(backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const tempPath = join(dirname(target.path), target.tempName);
    let tempBytes: Buffer | undefined;
    try {
      const tempStat = lstatSync(tempPath);
      if (tempStat.isFile() && !tempStat.isSymbolicLink() && tempStat.nlink === 1) tempBytes = readFileSync(tempPath);
    } catch {
      /* A committed target no longer has a sibling temporary file. */
    }
    const postimage = target.postimageSha256;
    if (typeof postimage !== 'string' || !/^[0-9a-f]{64}$/.test(postimage)) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery postimage digest is invalid: ${target.path}`, { path: target.path });
    }
    const changed = !(target.preimage.exists && target.preimage.sha256 === postimage);
    return {
      client: INSTALL_CLIENTS.find((client) => client.id === target.client) ?? INSTALL_CLIENTS[0]!,
      path: target.path,
      parent: dirname(target.path),
      lockPath: target.lockPath,
      existing: bytes,
      existingMode: target.preimage.mode,
      existingDevice: null,
      existingInode: null,
      merged: tempBytes ?? Buffer.alloc(0),
      changed,
      preimage: target.preimage,
      postimageSha256: postimage,
      tempName: target.tempName,
    };
  });
}

function journalTargetsArePreOrPost(journal: InstallJournal): void {
  for (const target of journal.targets) {
    const snapshot = currentSnapshot(target.path);
    const isPre = matchesPreimage(snapshot, target.preimage);
    const isPost = matchesDigest(snapshot, target.postimageSha256);
    if (!isPre && !isPost) {
      throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `concurrent edit remains at ${target.path}`, { path: target.path, journal });
    }
  }
}

/**
 * Re-enter every durable transaction left by a crash.  A completed transaction
 * only needs cleanup; a prepared/committing/rolling-back transaction is rolled back
 * in reverse order.  A foreign digest is preserved and remains a hard recovery
 * error; it is never guessed at or deleted.
 */
function recoverPending(
  keyRoot: string,
  key: string,
  home: string,
  expectedTargets: readonly string[],
): void {
  let keyStat;
  try {
    keyStat = lstatSync(keyRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect install recovery root: ${keyRoot}`, { path: keyRoot });
  }
  if (keyStat.isSymbolicLink() || !keyStat.isDirectory()) {
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `install recovery root is not a directory: ${keyRoot}`, { path: keyRoot });
  }
  for (const parent of [dirname(keyRoot), dirname(dirname(keyRoot))]) {
    let stat;
    try {
      stat = lstatSync(parent);
    } catch (error) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect install recovery parent ${parent}: ${safeMessage(error)}`, { path: parent });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `install recovery parent is not a directory: ${parent}`, { path: parent });
    }
  }
  let entries: string[];
  try {
    entries = readdirSync(keyRoot);
  } catch {
    throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect install recovery root: ${keyRoot}`, { path: keyRoot });
  }
  for (const entry of entries) {
    const txRoot = join(keyRoot, entry);
    let stat;
    try {
      stat = lstatSync(txRoot);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (!validTransactionToken(entry)) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery transaction id is not a safe path component: ${entry}`, { path: txRoot });
    }
    const paths: TransactionPaths = {
      stateRoot: dirname(dirname(keyRoot)),
      installRoot: dirname(keyRoot),
      keyRoot,
      transactionRoot: txRoot,
      journal: join(txRoot, 'journal.json'),
      preimages: join(txRoot, 'preimages'),
    };
    let journalStat;
    try {
      journalStat = lstatSync(paths.journal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A process can die while the initial journal's same-directory temporary
        // is durable, or just after the final journal unlink.  There is no target
        // mutation before that journal exists, so only remove the exact transaction
        // directory residue whose names we own; foreign entries remain a conflict.
        cleanupBareTransaction(paths, entry);
        continue;
      }
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect recovery journal: ${paths.journal}`, { path: paths.journal });
    }
    if (journalStat.isSymbolicLink() || !journalStat.isFile() || journalStat.nlink !== 1) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery journal is not a regular file: ${paths.journal}`, { path: paths.journal });
    }
    const journal = readJournal(paths.journal);
    if (!journal) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery journal is invalid: ${paths.journal}`, { path: paths.journal });
    }
    let preimagesStat;
    try {
      preimagesStat = lstatSync(paths.preimages);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `cannot inspect recovery preimages: ${paths.preimages}`, { path: paths.preimages });
      }
    }
    if (preimagesStat && (preimagesStat.isSymbolicLink() || !preimagesStat.isDirectory())) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery preimages is not a directory: ${paths.preimages}`, { path: paths.preimages });
    }
    validateRecoveryJournal(journal, key, home, paths);
    const journalPaths = sortUtf8(journal.targets.map((target) => target.path));
    if (JSON.stringify(journalPaths) !== JSON.stringify(sortUtf8(expectedTargets))) {
      throw new InstallTransactionError('INSTALL_RECOVERY_CONFLICT', `recovery target set differs: ${paths.journal}`, { path: paths.journal });
    }
    const recoveryLocks = acquireRecoveryLocks(journal, home, key);
    try {
      const plans = plansFromJournal(journal, txRoot);
      const mutable: MutableJournal = {
        ...journal,
        targets: journal.targets.map((target) => ({ ...target })),
      };
      if (journal.phase === 'COMMITTED' || journal.phase === 'CLEANING' || journal.phase === 'CLEANED') {
        journalTargetsArePreOrPost(journal);
        if (journal.targets.some((target) => !matchesDigest(currentSnapshot(target.path), target.postimageSha256))) {
          throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `committed transaction is missing a postimage: ${paths.journal}`, { path: paths.journal, journal });
        }
        cleanupTransaction(plans, paths, mutable);
        continue;
      }
      journalTargetsArePreOrPost(journal);
      const rolledBack = rollback(plans, paths, mutable);
      if (!rolledBack) {
        throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `recovery could not restore ${paths.journal}`, { path: paths.journal, journal: mutable });
      }
      cleanupTransaction(plans, paths, mutable);
    } finally {
      for (const lockPath of recoveryLocks.paths) {
        try {
          releaseLock(lockPath, recoveryLocks.uuid);
        } catch {
          /* Preserve a lock whose ownership bytes changed. */
        }
      }
    }
  }
}

function makePlan(client: ClientSpec, home: string, launch: LaunchSpec, uuid: string): TargetPlan {
  const targetPath =
    client.id === 'codex'
      ? join(home, '.codex', 'config.toml')
      : client.id === 'cursor'
        ? join(home, '.cursor', 'mcp.json')
        : client.id === 'claude'
          ? join(home, '.claude.json')
          : client.path('');
  const resolved = canonicalTarget(targetPath, home);
  let existing: Buffer | undefined;
  let mode: number | null = null;
  let dev: number | null = null;
  let ino: number | null = null;
  if (resolved.info) {
    existing = readFileSync(resolved.path);
    // Validate UTF-8 before passing bytes to the merge parser.
    const text = readUtf8(resolved.path, existing);
    mode = resolved.info.mode;
    dev = resolved.info.dev;
    ino = resolved.info.ino;
    try {
      const entry = buildEntry(client, launch);
      const mergeSpec = client.format === 'json' ? { ...client, path: () => resolved.path } : client;
      const merged = client.format === 'toml' ? mergeTomlConfig(text, entry) : mergeJsonConfig(text, mergeSpec, entry);
      const bytes = Buffer.from(merged.content, 'utf8');
      return {
        client,
        path: resolved.path,
        parent: resolved.parent,
        lockPath: join(resolved.parent, `.${basenameSafe(resolved.path)}.forgeax.lock`),
        existing,
        existingMode: mode,
        existingDevice: dev,
        existingInode: ino,
        merged: bytes,
        changed: merged.changed,
        preimage: preimageFor(existing, mode, `preimages/${String(0)}`),
        postimageSha256: sha256(merged.changed ? bytes : existing),
        tempName: `.${basenameSafe(resolved.path)}.forgeax-${uuid}.tmp`,
      };
    } catch (error) {
      if (error instanceof InstallTransactionError) throw error;
      throwConfig(safeMessage(error), resolved.path);
    }
  }
  try {
    const entry = buildEntry(client, launch);
    const mergeSpec = client.format === 'json' ? { ...client, path: () => resolved.path } : client;
    const merged = client.format === 'toml' ? mergeTomlConfig(undefined, entry) : mergeJsonConfig(undefined, mergeSpec, entry);
    const bytes = Buffer.from(merged.content, 'utf8');
    return {
      client,
      path: resolved.path,
      parent: resolved.parent,
      lockPath: join(resolved.parent, `.${basenameSafe(resolved.path)}.forgeax.lock`),
      existing,
      existingMode: mode,
      existingDevice: dev,
      existingInode: ino,
      merged: bytes,
      changed: true,
      preimage: preimageFor(undefined, null, null),
      postimageSha256: sha256(bytes),
      tempName: `.${basenameSafe(resolved.path)}.forgeax-${uuid}.tmp`,
    };
  } catch (error) {
    if (error instanceof InstallTransactionError) throw error;
    throwConfig(safeMessage(error), resolved.path);
  }
}

function assignBackupPaths(plans: readonly TargetPlan[]): TargetPlan[] {
  return plans.map((plan, index) => ({
    ...plan,
    preimage: {
      ...plan.preimage,
      backupRelativePath: plan.preimage.exists ? `preimages/${String(index)}` : null,
    },
  }));
}

function validateUniqueTargets(plans: readonly TargetPlan[]): void {
  const seen = new Set<string>();
  for (const plan of plans) {
    if (seen.has(plan.path)) throwConfig(`two requested clients resolve to one canonical target: ${plan.path}`, plan.path);
    seen.add(plan.path);
  }
}

function initialJournal(paths: TransactionPaths, home: string, uuid: string, plans: readonly TargetPlan[], releaseDigest: string): MutableJournal {
  void releaseDigest;
  return {
    schema: INSTALL_SCHEMA,
    transactionUuid: uuid,
    transactionKey: transactionKey(plans.map((plan) => plan.path)),
    canonicalHome: home,
    createdAt: new Date().toISOString(),
    phase: 'PREPARING',
    commitOrder: sortUtf8(plans.map((plan) => plan.path)),
    targets: plans.map((plan) => ({
      client: plan.client.id,
      path: plan.path,
      lockPath: plan.lockPath,
      tempName: plan.tempName,
      preimage: plan.preimage,
      postimageSha256: plan.postimageSha256,
      state: 'PLANNED',
    })),
  };
}

function backupPreimages(paths: TransactionPaths, plans: readonly TargetPlan[], journal: MutableJournal): void {
  ensureSecureDirectory(paths.preimages);
  for (const plan of plans) {
    if (!plan.preimage.exists || !plan.existing || !plan.preimage.backupRelativePath) continue;
    const backupPath = join(paths.transactionRoot, plan.preimage.backupRelativePath);
    durableCreate(backupPath, plan.existing, DEFAULT_MODE);
    if (sha256(readFileSync(backupPath)) !== plan.preimage.sha256) {
      throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `preimage backup digest mismatch: ${backupPath}`, { path: backupPath });
    }
    updateJournal(paths, journal);
  }
}

function writeTemps(paths: TransactionPaths, plans: readonly TargetPlan[], journal: MutableJournal): void {
  void paths;
  for (const plan of plans) {
    if (!plan.changed) continue;
    const temp = join(plan.parent, plan.tempName);
    if (existsSync(temp)) throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `temporary path already exists: ${temp}`, { path: temp });
    ensureSecureDirectory(plan.parent, 0o700);
    durableCreate(temp, plan.merged, plan.existingMode ?? DEFAULT_MODE);
    targetState(journal, plan.path, 'TEMP_DURABLE');
    updateJournal(paths, journal);
  }
}

function commitPlans(paths: TransactionPaths, plans: readonly TargetPlan[], journal: MutableJournal, faults: InstallFaultHooks | undefined): void {
  journal.phase = 'COMMITTING';
  updateJournal(paths, journal);
  const ordered = [...plans].filter((plan) => plan.changed).sort((left, right) => compareUtf8(left.path, right.path));
  let committed = 0;
  for (let index = 0; index < ordered.length; index++) {
    const plan = ordered[index]!;
    const result = targetResult(plan, 'UPDATED');
    faults?.beforeCommit?.(result, index);
    const before = currentSnapshot(plan.path);
    if (!matchesPreimage(before, plan.preimage)) {
      throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `target changed after preflight: ${plan.path}`, { path: plan.path });
    }
    // rename is replacement-capable but is protected by the no-follow, regular-file
    // preflight and a digest guard immediately before it; a concurrent postimage is
    // detected and preserved during rollback.
    renameSync(join(plan.parent, plan.tempName), plan.path);
    fsyncParent(plan.parent);
    targetState(journal, plan.path, 'COMMITTED');
    updateJournal(paths, journal);
    committed++;
    faults?.afterCommit?.(result, index);
    if (faults?.failAfterCommit !== undefined && committed >= faults.failAfterCommit) {
      throw new InstallTransactionError('INSTALL_FAULT_INJECTED', `fault injected after commit ${committed}`);
    }
  }
  journal.phase = 'COMMITTED';
  updateJournal(paths, journal);
}

async function transact(
  home: string,
  stateRoot: string,
  uuid: string,
  plans: readonly TargetPlan[],
  release: ReleaseIdentity,
  faults: InstallFaultHooks | undefined,
): Promise<InstallResult> {
  const sortedPlans = [...plans].sort((left, right) => compareUtf8(left.path, right.path));
  const paths = transactionPaths(home, sortedPlans.map((plan) => plan.path), stateRoot, uuid);
  ensureSecureDirectory(paths.stateRoot);
  ensureSecureDirectory(paths.installRoot);
  ensureSecureDirectory(paths.keyRoot);
  ensureSecureDirectory(paths.transactionRoot);
  chmodSync(paths.stateRoot, DIRECTORY_MODE);
  chmodSync(paths.installRoot, DIRECTORY_MODE);
  chmodSync(paths.keyRoot, DIRECTORY_MODE);
  chmodSync(paths.transactionRoot, DIRECTORY_MODE);
  let journal = initialJournal(paths, home, uuid, sortedPlans, release.releaseDigest);
  const locks: string[] = [];
  let journalWritten = false;
  try {
    // Persist PREPARING before lock acquisition so a lock conflict can close this
    // transaction durably instead of leaving an orphan state directory.
    writeJournal(paths.journal, journal, uuid, true);
    journalWritten = true;
    const lockBytes = lockMetadata(uuid, home, release.releaseDigest);
    for (const plan of sortedPlans) {
      ensureSecureDirectory(plan.parent, 0o700);
      lockFile(plan.lockPath, lockBytes);
      locks.push(plan.lockPath);
    }
    backupPreimages(paths, sortedPlans, journal);
    writeTemps(paths, sortedPlans, journal);
    journal.phase = 'PREPARED';
    updateJournal(paths, journal);
    commitPlans(paths, sortedPlans, journal, faults);
    for (const plan of sortedPlans) {
      if (plan.changed && !matchesDigest(currentSnapshot(plan.path), plan.postimageSha256)) {
        throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', `committed target changed before cleanup: ${plan.path}`, { path: plan.path });
      }
    }
    for (const lock of locks) releaseLock(lock, uuid);
    cleanupTransaction(sortedPlans, paths, journal);
    const targets = sortedPlans.map((plan) => targetResult(plan, plan.changed ? 'UPDATED' : 'CURRENT'));
    return {
      phase: 'COMMITTED',
      transactionKey: paths.keyRoot.slice(paths.installRoot.length + 1),
      transactionUuid: uuid,
      releaseIdentity: release,
      targets,
      lockOrder: sortedPlans.map((plan) => plan.path),
    };
  } catch (error) {
    journalError(journal, error);
    if (!journalWritten) {
      for (const lock of locks) {
        try {
          releaseLock(lock, uuid);
        } catch {
          /* Never remove a lock whose ownership bytes changed. */
        }
      }
      try {
      cleanupBareTransaction(paths, uuid);
      } catch {
        /* Preserve any foreign residue when there is no durable journal. */
      }
      if (error instanceof InstallTransactionError) throw error;
      throw new InstallTransactionError('INSTALL_FAILED', safeMessage(error));
    }
    try {
      const rolledBack = rollback(sortedPlans, paths, journal);
      for (const lock of locks) releaseLock(lock, uuid);
      if (rolledBack) cleanupTransaction(sortedPlans, paths, journal);
    } catch (rollbackError) {
      journalError(journal, rollbackError);
      journal.phase = 'RECOVERY_REQUIRED';
      try {
        updateJournal(paths, journal);
      } catch {
        /* retain whatever durable journal state already exists */
      }
      for (const lock of locks) {
        try {
          releaseLock(lock, uuid);
        } catch {
          /* never remove a lock whose ownership bytes changed */
        }
      }
      throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', safeMessage(rollbackError), { journal });
    }
    if (error instanceof InstallTransactionError) {
      if (error.code === 'INSTALL_RECOVERY_REQUIRED' || journal.phase === 'RECOVERY_REQUIRED') {
        throw new InstallTransactionError('INSTALL_RECOVERY_REQUIRED', safeMessage(error), { path: error.path, journal });
      }
      throw error;
    }
    throw new InstallTransactionError('INSTALL_FAILED', safeMessage(error));
  }
}

/**
 * Verify the exact launcher, preflight all three targets, and atomically install the
 * requested ForgeaX MCP entries.  `installConfigs` is the CLI-facing entry point;
 * tests may inject a verifier and fault hooks without spawning npx or touching a
 * user's home.
 */
export async function installConfigs(options: InstallOptions = {}): Promise<InstallResult> {
  const clients = options.clients ? [...options.clients] : [...INSTALL_CLIENTS];
  if (!clients.length) throw new InstallTransactionError('INSTALL_CONFIG_INVALID', 'no install targets were requested');
  if (clients.some((client) => !INSTALL_CLIENT_IDS.includes(client.id as (typeof INSTALL_CLIENT_IDS)[number]))) {
    throw new InstallTransactionError('INSTALL_CONFIG_INVALID', 'install supports only codex, cursor, and claude targets');
  }
  const launch = options.launch ?? launchSpec('npx');
  const expectedLaunch = launchSpec('npx');
  if (launch.command !== expectedLaunch.command || JSON.stringify(launch.args) !== JSON.stringify(expectedLaunch.args)) {
    throw new InstallTransactionError('INSTALL_LAUNCH_MISMATCH', `install requires ${expectedLaunch.command} ${expectedLaunch.args.join(' ')}`);
  }
  const home = canonicalHome(options.home);
  let verification: InstallVerification;
  try {
    verification = await (options.verify ?? verifyLaunchForInstall)(launch, INSTALL_VERIFY_TIMEOUT_MS);
    if (
      verification.releaseIdentityMimeType !== RELEASE_IDENTITY_MIME ||
      !verification.resources.includes(RELEASE_IDENTITY_URI) ||
      JSON.stringify(verification.handshake) !== JSON.stringify(['initialize', 'tools/list', 'resources/list', 'resources/read'])
    ) {
      throw new Error('release identity handshake is incomplete or has the wrong media type');
    }
    assertReleaseIdentity(verification.releaseIdentity);
  } catch (error) {
    if (error instanceof InstallTransactionError && error.code === 'INSTALL_CONFIG_INVALID') throw error;
    throw new InstallTransactionError('INSTALL_LAUNCH_MISMATCH', safeMessage(error));
  }
  const uuid = options.transactionUuid ?? randomUUID();
  if (!validTransactionToken(uuid)) {
    throw new InstallTransactionError('INSTALL_CONFIG_INVALID', 'transaction UUID is not a safe path component');
  }
  // Resolve target paths once to find the recovery key, then rebuild every plan
  // after recovery.  A crash-recovery rollback can remove a target that was still
  // a postimage during this first read; carrying that stale plan forward would
  // incorrectly report CURRENT and skip the needed reinstall.
  const preliminary = clients.map((client) => makePlan(client, home, launch, uuid));
  validateUniqueTargets(preliminary);
  const stateRoot = stateRootFor(home, options.stateRoot);
  const preliminaryPaths = preliminary.map((plan) => plan.path);
  const paths = transactionPaths(home, preliminaryPaths, stateRoot, uuid);
  recoverPending(paths.keyRoot, transactionKey(preliminaryPaths), home, preliminaryPaths);
  const plans = assignBackupPaths(clients.map((client) => makePlan(client, home, launch, uuid)));
  validateUniqueTargets(plans);
  const changed = plans.some((plan) => plan.changed);
  const lockOrder = sortUtf8(plans.map((plan) => plan.path));
  if (!changed) {
    return {
      phase: 'CURRENT',
      releaseIdentity: verification.releaseIdentity,
      targets: plans.map((plan) => targetResult(plan, 'CURRENT')),
      lockOrder,
    };
  }
  return transact(home, stateRoot, uuid, plans, verification.releaseIdentity, options.faults);
}

/** Alias kept intentionally descriptive for callers that only install MCP configs. */
export const installMcpConfigs = installConfigs;
