import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ENGINE_COMMIT, ENGINE_VERSION, resolveEngineRelease } from '../engine/release';

const STATE_SCHEMA = 'forgeax.engine-preview-state/1.0.0';
const ENVELOPE_LIMIT = 1024 * 1024;
const LOG_LIMIT = 8 * 1024 * 1024;
export const ENGINE_PREVIEW_TOTAL_DEADLINE_MS = 150_000;
const DEFAULT_READY_DEADLINE_MS = 15_000;
export const ENGINE_PREVIEW_CLEANUP_DEADLINE_MS = 5_000;
const HEALTH_PATH = '/.forgeax/preview-health';

export interface PreviewPaths {
  readonly dir: string;
  readonly lock: string;
  readonly state: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PreviewIdentity {
  readonly root: string;
  readonly urls: { readonly local: readonly string[]; readonly network: readonly string[] };
  readonly engineVersion: string;
  readonly engineCommit: string;
  readonly buildDigest: string;
  readonly previewInstanceId: string;
}

export interface PreviewState extends PreviewIdentity {
  readonly schemaVersion: typeof STATE_SCHEMA;
  readonly projectRoot: string;
  readonly selectedUrl: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly instanceToken: string;
  readonly startedAt: string;
}

export interface EnginePreviewResult {
  readonly identity: PreviewIdentity;
  readonly selectedUrl: string;
  readonly pid: number;
  readonly reused: boolean;
  readonly paths: PreviewPaths;
}

export interface PreviewRuntimeOptions {
  readonly totalDeadlineMs?: number;
  readonly readyDeadlineMs?: number;
  readonly cleanupDeadlineMs?: number;
  /** Test-only installed carrier fixture; production leaves this unset. */
  readonly carrierPluginRoot?: string;
}

interface CommandEnvelope {
  readonly schemaVersion?: unknown;
  readonly artifacts?: unknown;
  readonly command?: unknown;
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: unknown;
}

const trackedStates = new Map<string, PreviewState>();
const liveChildren = new Map<string, ChildProcess>();
const directChildren = new Set<ChildProcess>();

function trackDirectChild(child: ChildProcess): void {
  directChildren.add(child);
  child.once('exit', () => directChildren.delete(child));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PID reuse protection. Linux exposes a kernel start tick; other Unix hosts use ps. */
export function processStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const startTicks = fields[19];
    if (startTicks) return `proc:${startTicks}`;
  } catch {
    /* macOS and other Unix hosts use ps below. */
  }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  const value = result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : '';
  return value ? `ps:${value}` : undefined;
}

export function previewPaths(projectRoot: string, gameRoot: string): PreviewPaths {
  const canonicalProject = realpathSync(resolve(projectRoot));
  const canonicalGame = realpathSync(resolve(gameRoot));
  const gameRootHash = createHash('sha256').update(canonicalGame).digest('hex');
  const dir = join(canonicalProject, '.forgeax', 'run', 'engine-preview', gameRootHash);
  return {
    dir,
    lock: join(dir, 'lock'),
    state: join(dir, 'state.json'),
    stdout: join(dir, 'stdout.log'),
    stderr: join(dir, 'stderr.log'),
  };
}

function preparePaths(paths: PreviewPaths): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  for (const path of [paths.stdout, paths.stderr]) {
    const fd = openSync(path, 'a', 0o600);
    closeSync(fd);
    chmodSync(path, 0o600);
  }
}

function rotateLog(path: string, incomingBytes: number): void {
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    /* a missing log is created by appendFileSync */
  }
  if (bytes + incomingBytes <= LOG_LIMIT) return;
  const older = `${path}.2`;
  const previous = `${path}.1`;
  rmSync(older, { force: true });
  if (existsSync(previous)) renameSync(previous, older);
  if (existsSync(path)) renameSync(path, previous);
}

function appendLog(path: string, chunk: Buffer | string): void {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  rotateLog(path, value.byteLength);
  appendFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function redactingLog(path: string, secret: string): { write(chunk: Buffer): void; flush(): void } {
  let pending = '';
  const drain = (): void => {
    pending = pending.replaceAll(secret, '[REDACTED]');
    let retain = Math.min(secret.length - 1, pending.length);
    while (retain > 0 && !secret.startsWith(pending.slice(-retain))) retain--;
    const safeLength = pending.length - retain;
    if (safeLength > 0) appendLog(path, pending.slice(0, safeLength));
    pending = pending.slice(safeLength);
  };
  return {
    write(chunk) {
      pending += chunk.toString('utf8');
      // Retain only a suffix that could be the beginning of a token split across
      // chunks. Unlike a blind N-byte tail, complete framed output is appended
      // immediately and cannot be reordered behind the next Engine build.
      drain();
    },
    flush() {
      if (pending) appendLog(path, pending.replaceAll(secret, '[REDACTED]'));
      pending = '';
    },
  };
}

function readState(paths: PreviewPaths): PreviewState | undefined {
  try {
    const state = JSON.parse(readFileSync(paths.state, 'utf8')) as PreviewState;
    if (
      state.schemaVersion !== STATE_SCHEMA ||
      typeof state.pid !== 'number' ||
      typeof state.processStartIdentity !== 'string' ||
      typeof state.instanceToken !== 'string'
    ) return undefined;
    return state;
  } catch {
    return undefined;
  }
}

function writeState(paths: PreviewPaths, state: PreviewState): void {
  const temp = `${paths.state}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(temp, 0o600);
  renameSync(temp, paths.state);
  chmodSync(paths.state, 0o600);
}

interface LockHandle { readonly acquired: boolean; release(): void }

function acquireLock(paths: PreviewPaths): LockHandle {
  preparePaths(paths);
  const owner = JSON.stringify({
    pid: process.pid,
    identity: processStartIdentity(process.pid) ?? 'unknown',
    token: randomUUID(),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(paths.lock, `${owner}\n`, { flag: 'wx', mode: 0o600 });
      return {
        acquired: true,
        release() {
          try {
            if (readFileSync(paths.lock, 'utf8').trim() === owner) unlinkSync(paths.lock);
          } catch {
            /* another recovery already removed an obsolete lock */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let raw: string;
      try {
        raw = readFileSync(paths.lock, 'utf8');
      } catch {
        return { acquired: false, release() {} };
      }
      try {
        const parsed = JSON.parse(raw) as { pid?: unknown; identity?: unknown };
        const pid = Number(parsed.pid);
        const identity = processStartIdentity(pid);
        if (processAlive(pid) && identity !== undefined && parsed.identity === identity) {
          return { acquired: false, release() {} };
        }
        unlinkSync(paths.lock);
      } catch {
        try { unlinkSync(paths.lock); } catch { return { acquired: false, release() {} }; }
      }
    }
  }
  return { acquired: false, release() {} };
}

export function parseEnvelope(stdout: string, command: string): CommandEnvelope {
  if (Buffer.byteLength(stdout, 'utf8') > ENVELOPE_LIMIT + 1) {
    throw new Error(`${command}_envelope_too_large`);
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let envelope: CommandEnvelope | undefined;
  let envelopeIndex = -1;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${command}_envelope_invalid: unexpected JSON frame`);
    }
    if (envelope !== undefined) throw new Error(`${command}_envelope_invalid: multiple JSON frames`);
    envelope = parsed as CommandEnvelope;
    envelopeIndex = index;
  }
  if (envelope === undefined) throw new Error(`${command}_envelope_invalid: JSON frame is missing`);
  if (envelopeIndex !== lines.length - 1) {
    throw new Error(`${command}_envelope_invalid: diagnostics after JSON frame`);
  }
  if (envelope.schemaVersion !== undefined || !Array.isArray(envelope.artifacts) || envelope.command !== `project ${command}` || typeof envelope.ok !== 'boolean') {
    throw new Error(`${command}_envelope_invalid: wrong schema or command`);
  }
  if (!envelope.ok) {
    const error = envelope.error && typeof envelope.error === 'object'
      ? JSON.stringify(envelope.error)
      : 'unknown Engine failure';
    throw new Error(`${command}_failed: ${error}`);
  }
  return envelope;
}

async function waitForExit(child: ChildProcess, deadlineMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(null);
    }, Math.max(0, deadlineMs));
    const exited = (code: number | null): void => {
      cleanup();
      resolvePromise(code ?? 0);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('exit', exited);
    };
    child.once('exit', exited);
  });
}

async function terminateDirectChild(child: ChildProcess, cleanupMs: number): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  child.kill('SIGTERM');
  const grace = Math.max(0, Math.floor(cleanupMs * 0.8));
  if ((await waitForExit(child, grace)) !== null) return;
  child.kill('SIGKILL');
  if ((await waitForExit(child, cleanupMs - grace)) === null) {
    throw new Error('preview_stop_failed');
  }
}

async function runBuild(
  cliPath: string,
  gameRoot: string,
  paths: PreviewPaths,
  deadlineAt: number,
  cleanupMs: number,
): Promise<void> {
  const child = spawn(process.execPath, [cliPath, 'project', 'build', '--json'], {
    cwd: gameRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackDirectChild(child);
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    appendLog(paths.stdout, chunk);
    if (Buffer.byteLength(stdout, 'utf8') > ENVELOPE_LIMIT + 1) child.kill('SIGTERM');
  });
  child.stderr?.on('data', (chunk: Buffer) => appendLog(paths.stderr, chunk));
  const exit = await waitForExit(child, deadlineAt - Date.now());
  if (exit === null) {
    await terminateDirectChild(child, cleanupMs);
    throw new Error('engine_build_timeout');
  }
  parseEnvelope(stdout, 'build');
  if (exit !== 0) throw new Error(`engine_build_exit_${exit}`);
}

function previewIdentity(value: unknown, fallback?: Omit<PreviewIdentity, 'root' | 'urls'>): PreviewIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('preview_envelope_invalid: value is not an object');
  }
  const identity = value as Partial<PreviewIdentity>;
  if (
    typeof identity.root !== 'string' ||
    identity.urls === null || typeof identity.urls !== 'object' ||
    !Array.isArray(identity.urls.local) || !Array.isArray(identity.urls.network)
  ) throw new Error('preview_envelope_invalid: root or urls are missing');
  const fields = ['engineVersion', 'engineCommit', 'buildDigest', 'previewInstanceId'] as const;
  for (const field of fields) {
    if (identity[field] !== undefined && typeof identity[field] !== 'string') {
      throw new Error(`preview_envelope_invalid: ${field} is not a string`);
    }
    if (field !== 'previewInstanceId' && identity[field] !== undefined && fallback !== undefined && identity[field] !== fallback[field]) {
      throw new Error(`preview_envelope_invalid: ${field} conflicts with the verified release`);
    }
  }
  const normalized = {
    root: identity.root,
    urls: identity.urls,
    engineVersion: identity.engineVersion ?? fallback?.engineVersion,
    engineCommit: identity.engineCommit ?? fallback?.engineCommit,
    buildDigest: identity.buildDigest ?? fallback?.buildDigest,
    previewInstanceId: identity.previewInstanceId ?? fallback?.previewInstanceId,
  };
  if (fields.some((field) => typeof normalized[field] !== 'string')) {
    throw new Error('preview_envelope_invalid: identity fields are missing');
  }
  return normalized as PreviewIdentity;
}

function loopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'http:' && url.username === '' && url.password === '' &&
      (host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.'));
  } catch {
    return false;
  }
}

function selectUrl(identity: PreviewIdentity): string {
  const urls = [...identity.urls.local, ...identity.urls.network];
  if (urls.length === 0 || urls.some((url) => typeof url !== 'string' || !loopbackUrl(url))) {
    throw new Error('preview_loopback_url_invalid');
  }
  return urls.sort((left, right) => left.localeCompare(right))[0]!;
}

async function readPreviewEnvelope(
  child: ChildProcess,
  logStdout: (chunk: Buffer) => void,
  timeoutMs: number,
  fallback: Omit<PreviewIdentity, 'root' | 'urls'>,
): Promise<PreviewIdentity> {
  return await new Promise((resolvePromise, reject) => {
    let stdout = '';
    const onRemaining = (chunk: Buffer): void => logStdout(chunk);
    const timer = setTimeout(() => finish(new Error('engine_preview_readiness_timeout')), timeoutMs);
    const finish = (error?: Error, identity?: PreviewIdentity): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.stdout?.off('data', onData);
      child.stdout?.on('data', onRemaining);
      child.once('exit', () => child.stdout?.off('data', onRemaining));
      if (error) reject(error);
      else resolvePromise(identity!);
    };
    const onExit = (code: number | null): void => finish(new Error(`engine_preview_exit_${code ?? 'signal'}`));
    const onData = (chunk: Buffer): void => {
      logStdout(chunk);
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > ENVELOPE_LIMIT + 1) {
        finish(new Error('preview_envelope_too_large'));
        return;
      }
      if (!stdout.includes('\n')) return;
      try {
        const envelope = parseEnvelope(stdout, 'preview');
        finish(undefined, previewIdentity(envelope.value, fallback));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.once('exit', onExit);
    child.stdout?.on('data', onData);
  });
}

async function fetchHealth(state: PreviewIdentity, selectedUrl: string, token: string, timeoutMs: number): Promise<PreviewIdentity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(HEALTH_PATH, selectedUrl).toString();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.status === 404 || (response.ok && !response.headers.get('content-type')?.includes('application/json'))) {
      const manifestResponse = await fetch(new URL('forgeax-dist.json', selectedUrl), { signal: controller.signal });
      if (!manifestResponse.ok) throw new Error(`static manifest HTTP ${manifestResponse.status}`);
      const manifest = Buffer.from(await manifestResponse.arrayBuffer());
      if (manifest.byteLength > ENVELOPE_LIMIT) throw new Error('static manifest is too large');
      const digest = createHash('sha256').update(manifest).digest('hex');
      if (digest !== state.buildDigest) throw new Error('preview_static_digest_mismatch');
      return state;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = previewIdentity(await response.json());
    if (
      realpathSync(health.root) !== realpathSync(state.root) ||
      health.engineVersion !== state.engineVersion ||
      health.engineCommit !== state.engineCommit ||
      health.buildDigest !== state.buildDigest ||
      health.previewInstanceId !== state.previewInstanceId
    ) throw new Error('preview_health_identity_mismatch');
    return health;
  } finally {
    clearTimeout(timer);
  }
}

function distDigest(gameRoot: string): string {
  return createHash('sha256').update(readFileSync(join(gameRoot, 'dist', 'forgeax-dist.json'))).digest('hex');
}

async function verifiedExistingState(
  paths: PreviewPaths,
  desiredDigest: string,
  deadlineAt: number,
  cleanupMs: number,
): Promise<PreviewState | undefined> {
  const state = readState(paths);
  if (!state) {
    if (existsSync(paths.state)) throw new Error('preview_ownership_unverified: state is malformed');
    return undefined;
  }
  if (!processAlive(state.pid)) {
    rmSync(paths.state, { force: true });
    trackedStates.delete(paths.state);
    liveChildren.delete(paths.state);
    return undefined;
  }
  if (processStartIdentity(state.pid) !== state.processStartIdentity) {
    throw new Error('preview_ownership_unverified: process start identity changed');
  }
  try {
    await fetchHealth(
      state,
      state.selectedUrl,
      state.instanceToken,
      Math.max(1, Math.min(2_000, deadlineAt - Date.now())),
    );
  } catch (error) {
    throw new Error(`preview_ownership_unverified: ${error instanceof Error ? error.message : String(error)}`);
  }
  trackedStates.set(paths.state, state);
  if (
    state.root === realpathSync(state.root) &&
    state.engineVersion === ENGINE_VERSION &&
    state.engineCommit === ENGINE_COMMIT &&
    state.buildDigest === desiredDigest
  ) return state;
  await stopVerifiedState(paths, state, cleanupMs);
  return undefined;
}

async function stopVerifiedState(paths: PreviewPaths, state: PreviewState, cleanupMs: number): Promise<void> {
  if (!processAlive(state.pid)) {
    rmSync(paths.state, { force: true });
    return;
  }
  if (processStartIdentity(state.pid) !== state.processStartIdentity) {
    throw new Error('preview_ownership_unverified: refusing to signal reused PID');
  }
  const started = Date.now();
  try {
    await fetchHealth(state, state.selectedUrl, state.instanceToken, Math.min(2_000, cleanupMs));
  } catch (error) {
    throw new Error(`preview_ownership_unverified: ${error instanceof Error ? error.message : String(error)}`);
  }
  const child = liveChildren.get(paths.state);
  if (child?.pid === state.pid) child.kill('SIGTERM');
  else process.kill(state.pid, 'SIGTERM');
  while (processAlive(state.pid) && Date.now() - started < Math.floor(cleanupMs * 0.8)) await sleep(25);
  if (processAlive(state.pid)) {
    if (processStartIdentity(state.pid) !== state.processStartIdentity) {
      throw new Error('preview_ownership_unverified: identity changed before forced stop');
    }
    if (child?.pid === state.pid) child.kill('SIGKILL');
    else process.kill(state.pid, 'SIGKILL');
  }
  while (processAlive(state.pid) && Date.now() - started < cleanupMs) await sleep(25);
  if (processAlive(state.pid)) throw new Error('preview_stop_failed');
  rmSync(paths.state, { force: true });
  trackedStates.delete(paths.state);
  liveChildren.delete(paths.state);
}

export async function startEnginePreview(
  projectRoot: string,
  gameRoot: string,
  options: PreviewRuntimeOptions = {},
): Promise<EnginePreviewResult> {
  const totalMs = options.totalDeadlineMs ?? ENGINE_PREVIEW_TOTAL_DEADLINE_MS;
  const readyMs = options.readyDeadlineMs ?? DEFAULT_READY_DEADLINE_MS;
  const cleanupMs = options.cleanupDeadlineMs ?? ENGINE_PREVIEW_CLEANUP_DEADLINE_MS;
  const deadlineAt = Date.now() + totalMs;
  const release = resolveEngineRelease(
    gameRoot,
    options.carrierPluginRoot === undefined ? {} : { pluginRoot: options.carrierPluginRoot },
  );
  const canonicalProject = realpathSync(resolve(projectRoot));
  const paths = previewPaths(canonicalProject, release.gameRoot);
  const lock = acquireLock(paths);
  if (!lock.acquired) throw new Error('preview_busy');
  try {
    await runBuild(release.cliPath, release.gameRoot, paths, deadlineAt, cleanupMs);
    const digest = distDigest(release.gameRoot);
    const existing = await verifiedExistingState(paths, digest, deadlineAt, cleanupMs);
    if (existing) {
      return {
        identity: existing,
        selectedUrl: existing.selectedUrl,
        pid: existing.pid,
        reused: true,
        paths,
      };
    }

    const token = randomBytes(32).toString('hex');
    const previewInstanceId = randomUUID();
    // Engine owns ephemeral port allocation; never collide with another game.
    const child = spawn(process.execPath, [release.cliPath, 'project', 'preview', '--port', '0', '--json'], {
      cwd: release.gameRoot,
      detached: true,
      env: { ...process.env, FORGEAX_PREVIEW_INSTANCE_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackDirectChild(child);
    const stdoutLog = redactingLog(paths.stdout, token);
    const stderrLog = redactingLog(paths.stderr, token);
    child.stderr?.on('data', (chunk: Buffer) => stderrLog.write(chunk));
    child.once('exit', () => {
      stdoutLog.flush();
      stderrLog.flush();
    });
    if (!child.pid) throw new Error('engine_preview_pid_missing');
    let identity: PreviewIdentity;
    try {
      identity = await readPreviewEnvelope(
        child,
        (chunk) => stdoutLog.write(chunk),
        Math.max(1, Math.min(readyMs, deadlineAt - Date.now())),
        {
          engineVersion: release.version,
          engineCommit: release.commit,
          buildDigest: digest,
          previewInstanceId,
        },
      );
      const selectedUrl = selectUrl(identity);
      if (
        realpathSync(identity.root) !== release.gameRoot ||
        identity.engineVersion !== release.version ||
        identity.engineCommit !== release.commit ||
        identity.buildDigest !== digest
      ) throw new Error('preview_identity_mismatch');
      await fetchHealth(identity, selectedUrl, token, Math.max(1, Math.min(readyMs, deadlineAt - Date.now())));
      const startIdentity = processStartIdentity(child.pid);
      if (!startIdentity) throw new Error('preview_process_identity_unavailable');
      const state: PreviewState = {
        ...identity,
        schemaVersion: STATE_SCHEMA,
        projectRoot: canonicalProject,
        selectedUrl,
        pid: child.pid,
        processStartIdentity: startIdentity,
        instanceToken: token,
        startedAt: new Date().toISOString(),
      };
      writeState(paths, state);
      child.unref();
      trackedStates.set(paths.state, state);
      liveChildren.set(paths.state, child);
      child.once('exit', () => liveChildren.delete(paths.state));
      return { identity, selectedUrl, pid: child.pid, reused: false, paths };
    } catch (error) {
      await terminateDirectChild(child, cleanupMs).catch(() => undefined);
      throw error;
    }
  } finally {
    lock.release();
  }
}

export async function stopEnginePreview(
  projectRoot: string,
  gameRoot: string,
  options: PreviewRuntimeOptions = {},
): Promise<{ readonly stopped: boolean; readonly paths: PreviewPaths }> {
  const paths = previewPaths(projectRoot, gameRoot);
  const lock = acquireLock(paths);
  if (!lock.acquired) throw new Error('preview_busy');
  try {
    const state = readState(paths);
    if (!state) {
      if (existsSync(paths.state)) throw new Error('preview_ownership_unverified: state is malformed');
      return { stopped: false, paths };
    }
    if (!processAlive(state.pid)) {
      rmSync(paths.state, { force: true });
      trackedStates.delete(paths.state);
      liveChildren.delete(paths.state);
      return { stopped: false, paths };
    }
    await stopVerifiedState(paths, state, options.cleanupDeadlineMs ?? ENGINE_PREVIEW_CLEANUP_DEADLINE_MS);
    return { stopped: true, paths };
  } finally {
    lock.release();
  }
}

export function inspectEnginePreview(projectRoot: string, gameRoot: string): {
  readonly paths: PreviewPaths;
  readonly state?: PreviewState;
  readonly processLive: boolean;
  readonly processIdentityMatches: boolean;
} {
  const paths = previewPaths(projectRoot, gameRoot);
  const state = readState(paths);
  return {
    paths,
    ...(state ? { state } : {}),
    processLive: state ? processAlive(state.pid) : false,
    processIdentityMatches: state
      ? processStartIdentity(state.pid) === state.processStartIdentity
      : false,
  };
}

/** Stop only previews this MCP process started or verified and adopted. */
export async function stopTrackedEnginePreviews(): Promise<void> {
  await Promise.all([...directChildren].map(async (child) => {
    await terminateDirectChild(child, ENGINE_PREVIEW_CLEANUP_DEADLINE_MS).catch(() => undefined);
  }));
  const entries = [...trackedStates.entries()];
  await Promise.all(entries.map(async ([statePath, state]) => {
    const paths: PreviewPaths = {
      dir: dirname(statePath),
      lock: join(dirname(statePath), 'lock'),
      state: statePath,
      stdout: join(dirname(statePath), 'stdout.log'),
      stderr: join(dirname(statePath), 'stderr.log'),
    };
    const lock = acquireLock(paths);
    if (!lock.acquired) return;
    try {
      await stopVerifiedState(paths, state, ENGINE_PREVIEW_CLEANUP_DEADLINE_MS).catch(() => undefined);
    } finally {
      lock.release();
    }
  }));
}

/** Test/evidence helper: enumerate state directories without trusting their PIDs. */
export function previewStateDirectories(projectRoot: string): readonly string[] {
  const root = join(resolve(projectRoot), '.forgeax', 'run', 'engine-preview');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}
