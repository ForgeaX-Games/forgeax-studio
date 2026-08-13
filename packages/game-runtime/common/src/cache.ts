import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { InstalledRuntime, RuntimeArtifact, RuntimeMachine } from './types';

const LOCK_FILE = '.install.lock';
const currentMachine = (): RuntimeMachine => ({ platform: process.platform, arch: process.arch });

export function runtimeCacheRoot(): string {
  return process.env.FORGEAX_RUNTIME_CACHE?.trim() || join(homedir(), '.forgeax', 'runtimes');
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function runtimeInstallRoot(
  runtimeId: string,
  version: string,
  machine: RuntimeMachine = currentMachine(),
  cacheRoot = runtimeCacheRoot(),
): string {
  return join(cacheRoot, safe(runtimeId), safe(version), `${safe(machine.platform)}-${safe(machine.arch)}`);
}

export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

interface ReadyMarker {
  readonly schemaVersion: 2;
  readonly runtimeId: string;
  readonly version: string;
  readonly format: 'archive' | 'file';
  readonly artifactPath?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly sha256: string;
  readonly platform: string;
  readonly arch: string;
}

function markerPath(root: string): string {
  return join(root, '.ready.json');
}

function readMarker(root: string): ReadyMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(markerPath(root), 'utf8')) as ReadyMarker;
    if (value.schemaVersion !== 2 || !value.runtimeId || !value.version || !value.sha256 || !value.command) return undefined;
    if (value.format !== 'archive' && value.format !== 'file') return undefined;
    if (value.format === 'file' && !value.artifactPath) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path) && existsSync(candidate);
}

export function readInstalledRuntime(
  runtimeId: string,
  version: string,
  machine: RuntimeMachine = currentMachine(),
  cacheRoot = runtimeCacheRoot(),
): InstalledRuntime | undefined {
  const root = runtimeInstallRoot(runtimeId, version, machine, cacheRoot);
  const marker = readMarker(root);
  if (!marker || marker.runtimeId !== runtimeId || marker.version !== version) return undefined;
  if (marker.platform !== machine.platform || marker.arch !== machine.arch) return undefined;

  const commandPath = resolve(root, marker.command);
  if (!contained(root, commandPath)) return undefined;
  let artifactPath: string | undefined;
  if (marker.format === 'file') {
    artifactPath = resolve(root, marker.artifactPath!);
    if (!contained(root, artifactPath)) return undefined;
    try {
      if (sha256File(artifactPath) !== marker.sha256.toLowerCase()) return undefined;
    } catch {
      return undefined;
    }
  }
  return {
    runtimeId,
    version,
    root,
    ...(artifactPath ? { artifactPath } : {}),
    command: marker.command,
    args: marker.args,
    sha256: marker.sha256,
    platform: marker.platform,
    arch: marker.arch,
  };
}

export function listInstalledRuntimes(
  runtimeId: string,
  machine: RuntimeMachine = currentMachine(),
  cacheRoot = runtimeCacheRoot(),
): InstalledRuntime[] {
  const root = join(cacheRoot, safe(runtimeId));
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => readInstalledRuntime(runtimeId, item.name, machine, cacheRoot))
    .filter((item): item is InstalledRuntime => Boolean(item))
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
}

export interface RuntimeLock {
  readonly acquired: boolean;
  release(): void;
}

export function acquireRuntimeLock(root: string, staleAfterMs = 10 * 60_000): RuntimeLock {
  mkdirSync(root, { recursive: true });
  const file = join(root, LOCK_FILE);
  let handle: number | undefined;
  try {
    handle = openSync(file, 'wx');
    writeFileSync(handle, `${process.pid}\n`, 'utf8');
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs > staleAfterMs) {
        rmSync(file, { force: true });
        handle = openSync(file, 'wx');
        writeFileSync(handle, `${process.pid}\n`, 'utf8');
      }
    } catch {
      handle = undefined;
    }
  }
  return {
    acquired: handle !== undefined,
    release: () => {
      if (handle === undefined) return;
      try { closeSync(handle); } catch { /* already closed */ }
      try { rmSync(file, { force: true }); } catch { /* already reclaimed */ }
      handle = undefined;
    },
  };
}

function safeLocalSource(source: string, sourceRoot: string): string {
  if (isAbsolute(source)) throw new Error('runtime artifact path is outside the distribution root');
  const lexicalRoot = resolve(sourceRoot);
  const candidate = resolve(lexicalRoot, source);
  const lexicalPath = relative(lexicalRoot, candidate);
  if (lexicalPath.startsWith('..') || isAbsolute(lexicalPath)) {
    throw new Error('runtime artifact path is outside the distribution root');
  }
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error('runtime artifact source must not be a symbolic link');
  }
  const root = realpathSync(lexicalRoot);
  const realSource = realpathSync(candidate);
  const realPath = relative(root, realSource);
  if (realPath.startsWith('..') || isAbsolute(realPath)) {
    throw new Error('runtime artifact path is outside the distribution root');
  }
  return realSource;
}

async function materializeSource(source: string, destination: string, sourceRoot?: string): Promise<void> {
  if (/^http:\/\//i.test(source)) throw new Error('runtime artifact URL must use HTTPS');
  if (/^https:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`runtime artifact download failed (${response.status})`);
    if (response.url && !/^https:\/\//i.test(response.url)) {
      throw new Error('runtime artifact redirect must keep HTTPS');
    }
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (!sourceRoot) throw new Error('a distribution root is required for local runtime artifacts');
  copyFileSync(safeLocalSource(source, sourceRoot), destination);
}

function validateArchive(archive: string): void {
  // `-P` prevents tar from sanitizing traversal names in listing output before
  // this validator can reject them. Extraction itself never uses `-P`.
  const listing = spawnSync('tar', ['-tzPf', archive], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (listing.status !== 0) {
    throw new Error(`runtime archive listing failed: ${listing.stderr?.trim() || 'tar exited unsuccessfully'}`);
  }
  for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`runtime archive contains an unsafe path: ${entry}`);
    }
  }
  const verbose = spawnSync('tar', ['-tvzPf', archive], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (verbose.status !== 0) throw new Error('runtime archive metadata listing failed');
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new Error('runtime archive contains a link or special entry');
    }
  }
}

function extractArchive(archive: string, destination: string): void {
  validateArchive(archive);
  const keep = new Set([basename(archive), LOCK_FILE]);
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (!keep.has(entry.name)) rmSync(join(destination, entry.name), { recursive: true, force: true });
  }
  const args = ['-xzf', archive, '-C', destination];
  if (process.platform !== 'win32') args.push('--no-same-owner');
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`runtime archive extraction failed: ${result.stderr?.trim() || 'tar exited unsuccessfully'}`);
  }
}

function validateCommand(command: string): void {
  const normalized = command.replaceAll('\\', '/');
  if (!normalized || isAbsolute(command) || normalized.split('/').includes('..')) {
    throw new Error(`runtime command must stay inside the install root: ${command}`);
  }
}

export async function installRuntime(artifact: RuntimeArtifact, options: {
  runtimeId?: string;
  cacheRoot?: string;
  sourceRoot?: string;
  machine?: RuntimeMachine;
} = {}): Promise<InstalledRuntime> {
  const runtimeId = options.runtimeId ?? artifact.runtimeId ?? 'forgeax-game-runtime';
  const machine = options.machine ?? currentMachine();
  const cacheRoot = options.cacheRoot ?? runtimeCacheRoot();
  const root = runtimeInstallRoot(runtimeId, artifact.version, machine, cacheRoot);
  const expectedSha = artifact.sha256.toLowerCase();
  const existing = readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
  if (existing?.sha256 === expectedSha) return existing;

  const lock = acquireRuntimeLock(root);
  if (!lock.acquired) {
    const installed = readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
    if (installed) return installed;
    throw new Error(`runtime ${runtimeId}@${artifact.version} is being installed by another process`);
  }
  try {
    const sourceName = basename(new URL(artifact.source, 'file:///runtime-artifact/').pathname) || 'runtime-artifact';
    const filename = sourceName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const artifactPath = join(root, filename);
    const temporary = `${artifactPath}.part-${process.pid}`;
    try {
      await materializeSource(artifact.source, temporary, options.sourceRoot);
      const digest = sha256File(temporary);
      if (digest !== expectedSha) throw new Error(`runtime artifact checksum mismatch: expected ${expectedSha}, got ${digest}`);
      rmSync(artifactPath, { force: true });
      renameSync(temporary, artifactPath);

      const isArchive = artifact.format === 'archive';
      if (isArchive) {
        extractArchive(artifactPath, root);
        rmSync(artifactPath, { force: true });
      }
      const command = artifact.command ?? filename;
      validateCommand(command);
      if (!contained(root, resolve(root, command))) {
        throw new Error(`runtime command is missing from the installed artifact: ${command}`);
      }
      const marker: ReadyMarker = {
        schemaVersion: 2,
        runtimeId,
        version: artifact.version,
        format: isArchive ? 'archive' : 'file',
        ...(isArchive ? {} : { artifactPath: filename }),
        command,
        args: artifact.args ?? [],
        sha256: digest,
        platform: machine.platform,
        arch: machine.arch,
      };
      const markerTmp = `${markerPath(root)}.tmp-${process.pid}`;
      writeFileSync(markerTmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
      renameSync(markerTmp, markerPath(root));
      const installed = readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
      if (!installed) throw new Error('runtime readiness marker validation failed');
      return installed;
    } catch (error) {
      rmSync(temporary, { force: true });
      rmSync(markerPath(root), { force: true });
      throw error;
    }
  } finally {
    lock.release();
  }
}
