import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, arch, platform } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { RuntimeArtifact, type InstalledRuntime } from './types';

export function runtimeCacheRoot(): string {
  return process.env.FORGEAX_RUNTIME_CACHE?.trim() || join(homedir(), '.forgeax', 'runtimes');
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function runtimeInstallRoot(runtimeId: string, version: string, machine: { platform: NodeJS.Platform; arch: string } = { platform: platform(), arch: arch() }, cacheRoot = runtimeCacheRoot()): string {
  return join(cacheRoot, safe(runtimeId), safe(version), `${safe(machine.platform)}-${safe(machine.arch)}`);
}

/**
 * Hash in chunks. Runtime artifacts are hundreds of megabytes, so reading one whole
 * into memory to hash it is a needless allocation of that same size.
 */
export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

/**
 * Readiness record for one installed runtime.
 *
 * `artifactPath` is absent for archive installs: once extraction succeeds the archive
 * is redundant, and keeping it doubles the runtime's footprint on the user's disk.
 * The checksum stays recorded as provenance of what was verified at install time.
 */
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
  const marker = markerPath(root);
  if (!existsSync(marker)) return undefined;
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8')) as ReadyMarker;
    if (value.schemaVersion !== 2 || !value.runtimeId || !value.version || !value.sha256 || !value.command) return undefined;
    if (value.format !== 'archive' && value.format !== 'file') return undefined;
    if (value.format === 'file' && !value.artifactPath) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Verify both the atomic marker and the bytes it vouches for. */
export function readInstalledRuntime(runtimeId: string, version: string, machine: { platform: NodeJS.Platform; arch: string } = { platform: platform(), arch: arch() }, cacheRoot = runtimeCacheRoot()): InstalledRuntime | undefined {
  const root = runtimeInstallRoot(runtimeId, version, machine, cacheRoot);
  const marker = readMarker(root);
  if (!marker || marker.runtimeId !== runtimeId || marker.version !== version || marker.platform !== machine.platform || marker.arch !== machine.arch) return undefined;
  // Both the command and any retained artifact must resolve inside the install root,
  // so a tampered marker cannot point the launcher at an arbitrary path.
  const contained = (candidate: string): boolean => {
    const relativePath = relative(root, candidate);
    return !relativePath.startsWith('..') && !isAbsolute(relativePath) && existsSync(candidate);
  };

  let artifactPath: string | undefined;
  if (marker.format === 'file') {
    artifactPath = resolve(root, marker.artifactPath!);
    if (!contained(artifactPath)) return undefined;
    // For a file install the artifact *is* the executable, so its bytes still matter.
    try {
      if (sha256File(artifactPath) !== marker.sha256.toLowerCase()) return undefined;
    } catch {
      return undefined;
    }
  } else {
    // The archive's checksum was verified before extraction; re-hashing it on every
    // status read would cost hundreds of megabytes of I/O to re-learn the same fact.
    // What must hold now is that the extracted tree still carries the entry point.
    if (!contained(resolve(root, marker.command))) return undefined;
  }
  return { runtimeId, version, root, ...(artifactPath ? { artifactPath } : {}), command: marker.command, args: marker.args, sha256: marker.sha256, platform: marker.platform, arch: marker.arch };
}

export function listInstalledRuntimes(runtimeId: string, cacheRoot = runtimeCacheRoot()): InstalledRuntime[] {
  const root = join(cacheRoot, safe(runtimeId));
  if (!existsSync(root)) return [];
  const result: InstalledRuntime[] = [];
  for (const version of requireDirectoryNames(root)) {
    const runtime = readInstalledRuntime(runtimeId, version, { platform: platform(), arch: arch() }, cacheRoot);
    if (runtime) result.push(runtime);
  }
  return result.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function requireDirectoryNames(root: string): string[] {
  // Kept behind a tiny helper so cache discovery remains easy to test and audit.
  return readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
}

export interface RuntimeLock {
  readonly acquired: boolean;
  release(): void;
}

/** Name of the in-root install lock, shared by the lock helper and the extractor. */
const LOCK_FILE = '.install.lock';

/** Cross-process installation lock. A stale lock is safe to reclaim after 10 minutes. */
export function acquireRuntimeLock(root: string, staleAfterMs = 10 * 60_000): RuntimeLock {
  mkdirSync(root, { recursive: true });
  const file = join(root, LOCK_FILE);
  let fd: number | undefined;
  try {
    fd = openSync(file, 'wx');
    writeFileSync(fd, `${process.pid}\n`, 'utf8');
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs > staleAfterMs) {
        rmSync(file, { force: true });
        fd = openSync(file, 'wx');
        writeFileSync(fd, `${process.pid}\n`, 'utf8');
      }
    } catch {
      fd = undefined;
    }
  }
  return {
    acquired: fd !== undefined,
    release: () => {
      if (fd === undefined) return;
      try { closeSync(fd); } catch { /* already closed */ }
      try { rmSync(file, { force: true }); } catch { /* another process reclaimed it */ }
      fd = undefined;
    },
  };
}

async function materializeSource(source: string, destination: string, sourceRoot?: string): Promise<void> {
  if (/^http:\/\//i.test(source)) {
    throw new Error('runtime artifact URL must use HTTPS');
  }
  if (/^https:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`runtime artifact download failed (${response.status})`);
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    return;
  }
  copyFileSync(resolve(sourceRoot ?? process.cwd(), source), destination);
}

function validateArchive(archive: string): void {
  // A bundled Engine contains many asset files; the listing can exceed Node's
  // small default spawnSync buffer even though the archive itself is valid.
  const result = spawnSync('tar', ['-tzf', archive], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`runtime archive listing failed: ${result.stderr?.trim() || 'tar exited unsuccessfully'}`);
  }
  for (const entry of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`runtime archive contains an unsafe path: ${entry}`);
    }
  }
}

/**
 * Replace the install tree with the archive's contents.
 *
 * `tar -x` overlays rather than replaces, so extracting over a previous install leaves
 * behind every file the new archive does not happen to overwrite. Observed in
 * acceptance: a 310 MB Runtime unpacked onto a stale 1.8 GB tree stayed 1.8 GB and kept
 * packages that had been deliberately pruned. Everything except the caller's lock and
 * the archive itself is cleared first.
 */
function extractArchive(archive: string, destination: string): void {
  validateArchive(archive);
  const keep = new Set([basename(archive), LOCK_FILE]);
  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue;
    rmSync(join(destination, entry.name), { recursive: true, force: true });
  }
  const result = spawnSync('tar', ['-xzf', archive, '-C', destination, '--no-same-owner'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`runtime archive extraction failed: ${result.stderr?.trim() || 'tar exited unsuccessfully'}`);
  }
}

/** Install one manifest artifact and publish readiness only after verification. */
export async function installRuntime(artifact: RuntimeArtifact, options: {
  runtimeId?: string;
  cacheRoot?: string;
  sourceRoot?: string;
  machine?: { platform: NodeJS.Platform; arch: string };
} = {}): Promise<InstalledRuntime> {
  const runtimeId = options.runtimeId ?? artifact.runtimeId ?? 'forgeax-game-runtime';
  const machine = options.machine ?? { platform: platform(), arch: arch() };
  const root = join(options.cacheRoot ?? runtimeCacheRoot(), safe(runtimeId), safe(artifact.version), `${safe(machine.platform)}-${safe(machine.arch)}`);
  const cacheRoot = options.cacheRoot ?? runtimeCacheRoot();
  const existing = readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
  // Reuse only when the cache holds the same bytes the manifest now names. Runtime
  // versions are rebuilt in place during development, so matching version + platform
  // is not evidence that the cached tree is the artifact being asked for.
  if (existing && existing.sha256 === artifact.sha256.toLowerCase()) return existing;
  const lock = acquireRuntimeLock(root);
  if (!lock.acquired) {
    const waited = readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot);
    if (waited) return waited;
    throw new Error(`runtime ${runtimeId}@${artifact.version} is being installed by another process`);
  }
  try {
    const filename = basename(new URL(artifact.source, 'file:///runtime-artifact').pathname) || 'runtime-artifact';
    const artifactPath = join(root, filename.replace(/[^a-zA-Z0-9._-]/g, '_'));
    const temporary = `${artifactPath}.part-${process.pid}`;
    await materializeSource(artifact.source, temporary, options.sourceRoot);
    const digest = sha256File(temporary);
    if (digest !== artifact.sha256.toLowerCase()) {
      rmSync(temporary, { force: true });
      throw new Error(`runtime artifact checksum mismatch: expected ${artifact.sha256}, got ${digest}`);
    }
    renameSync(temporary, artifactPath);
    const isArchive = artifact.format === 'archive';
    if (isArchive) {
      extractArchive(artifactPath, root);
      // Extraction succeeded, so the archive is now dead weight the user would carry
      // for the lifetime of the install.
      rmSync(artifactPath, { force: true });
    }
    const marker: ReadyMarker = {
      schemaVersion: 2,
      runtimeId,
      version: artifact.version,
      format: isArchive ? 'archive' : 'file',
      ...(isArchive ? {} : { artifactPath: filename }),
      command: artifact.command ?? filename,
      args: artifact.args ?? [],
      sha256: digest,
      platform: machine.platform,
      arch: machine.arch,
    };
    const markerTmp = `${markerPath(root)}.tmp-${process.pid}`;
    writeFileSync(markerTmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    renameSync(markerTmp, markerPath(root));
    return readInstalledRuntime(runtimeId, artifact.version, machine, cacheRoot) as InstalledRuntime;
  } finally {
    lock.release();
  }
}
