import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import {
  GoldenAssertionError,
  type GoldenKernel,
} from '../cases/_template.ts';
import type { FetchLike, StreamEvent } from './sse.ts';

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const LEDGER_SHARD_RE = /^events-(\d+)\.jsonl$/;
const SERVER_LOG_LIMIT_BYTES = 256 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_LEDGER_TIMEOUT_MS = 5_000;
const MODEL_EXECUTION_WAIVER = 'Model verification covers the host-composed requested model only; it does not prove the kernel or backend accepted or executed that model.';
const SECRET_ENV_NAME_RE = /(api[_-]?key|token|secret|password|credential)/i;

export const MODEL_EXECUTION_WAIVER_NOTE = MODEL_EXECUTION_WAIVER;
export const MODEL_EXECUTION_M3_CLOSURE = 'M3 ActionDispatchEventV1 wire change: requestedModel/effectiveModel';

type JsonRecord = Record<string, unknown>;

export interface GoldenServerProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number): void;
}

export type GoldenServerSpawner = (
  command: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => GoldenServerProcess;

export interface GoldenServerStartupManifest {
  command: string[];
  environment: {
    FORGEAX_KERNEL: 'kernel';
    FORGEAX_KERNEL_IMPL: string;
    FORGEAX_SERVER_HOST: '127.0.0.1';
    FORGEAX_SERVER_PORT: string;
    FORGEAX_PROJECT_ROOT: string;
    FORGEAX_NO_WATCH: '1';
  };
  port: number;
  expected: GoldenKernel;
  configSha256: string;
}

export interface GoldenServerStartupEvidence {
  manifest: GoldenServerStartupManifest;
  readyAfterMs: number;
  healthStatus: number;
}

export interface GoldenServerStopEvidence {
  exitCode: number | null;
  forced: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface GoldenServerRuntime {
  port: number;
  baseUrl: string;
  startup: GoldenServerStartupEvidence;
  stop(): Promise<GoldenServerStopEvidence>;
}

export interface LaunchGoldenServerOptions {
  projectRoot: string;
  requestedPort?: number;
  kernel: GoldenKernel;
  spawnServer?: GoldenServerSpawner;
  fetchImpl?: FetchLike;
  readyTimeoutMs?: number;
  now?: () => number;
  reservePort?: () => Promise<number>;
}

export interface GoldenModelLockEvidence {
  sid: string;
  agentId: string;
  model: string;
  agentJsonFile: string;
  previousModel: unknown;
  writtenModel: string;
  configSha256: string;
}

export interface GoldenLedgerSnapshot {
  files: string[];
  events: JsonRecord[];
}

export interface GoldenCliCaptureProxy {
  baseUrl: string;
  capturedCallId(): string;
  close(): void;
}

export interface GoldenTurnModelEvidence {
  callId: string;
  correlationMethod: 'runner-injected-nonce+isolated-ledger-delta';
  correlationNonceSha256: string;
  requestedModel: string;
  userEventOffset: number;
  assistantEventOffset: number;
  ledgerEventCountBefore: number;
  ledgerEventCountAfter: number;
  ledgerFiles: string[];
  promptSha256: string;
}

export interface GoldenL4bEvidenceAdapter {
  lockAgentModel(input: {
    projectRoot: string;
    sid: string;
    agentId: string;
    model: string;
  }): Promise<GoldenModelLockEvidence>;
  verifyAgentModelLock(evidence: GoldenModelLockEvidence): Promise<GoldenModelLockEvidence>;
  readAgentLedger(input: {
    projectRoot: string;
    sid: string;
    agentId: string;
  }): Promise<GoldenLedgerSnapshot>;
  createCliCaptureProxy(targetBaseUrl: string): Promise<GoldenCliCaptureProxy>;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function secretEnvironmentValues(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME_RE.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
}

export function redactGoldenEvidenceText(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  let redacted = text;
  for (const secret of secretEnvironmentValues(env)) {
    redacted = redacted.split(secret).join('<redacted>');
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*)[^\s,;"']+/gi, '$1<redacted>');
}

function safeSid(sid: string): string {
  if (
    !sid
    || sid === '.'
    || sid === '..'
    || sid.length > 160
    || sid.includes('/')
    || sid.includes('\\')
    || sid.includes('\0')
  ) {
    throw new GoldenAssertionError('refusing unsafe session id for L4b evidence', { sid });
  }
  return sid;
}

function safeAgentSegments(agentId: string): string[] {
  const segments = agentId.split('/');
  const valid = segments.length % 2 === 1 && segments.every((segment, index) => (
    index % 2 === 0 ? AGENT_NAME_RE.test(segment) : segment === 'agents'
  ));
  if (!valid) {
    throw new GoldenAssertionError('refusing unsafe agent id for L4b evidence', { agentId });
  }
  return segments;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function findSessionRoot(projectRoot: string, sidInput: string): Promise<string> {
  const sid = safeSid(sidInput);
  const gamesRoot = resolve(projectRoot, '.forgeax', 'games');
  const candidates: string[] = [];
  try {
    const games = await readdir(gamesRoot, { withFileTypes: true });
    for (const game of games.sort((left, right) => left.name.localeCompare(right.name))) {
      const gamePath = resolve(gamesRoot, game.name);
      if (!game.isDirectory() && !(game.isSymbolicLink() && await isDirectory(gamePath))) continue;
      candidates.push(resolve(gamePath, 'sessions', sid));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  candidates.push(resolve(projectRoot, '.forgeax', 'sessions', sid));
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new GoldenAssertionError(
      matches.length === 0
        ? `session root not found for ${sid}`
        : `session ${sid} is bound to multiple roots`,
      { sid, matches, candidates },
    );
  }
  return matches[0]!;
}

async function agentJsonPath(projectRoot: string, sid: string, agentId: string): Promise<string> {
  const segments = safeAgentSegments(agentId);
  const sessionRoot = await findSessionRoot(projectRoot, sid);
  const path = resolve(sessionRoot, 'agents', ...segments, 'agent.json');
  const expectedParent = resolve(sessionRoot, 'agents', ...segments);
  if (dirname(path) !== expectedParent) {
    throw new GoldenAssertionError('agent.json path escaped the session agent root', {
      sid,
      agentId,
      path,
    });
  }
  const info = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GoldenAssertionError('scaffolded agent.json was not found', { sid, agentId, path });
    }
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new GoldenAssertionError('agent.json must be a regular non-symlink file', {
      sid,
      agentId,
      path,
    });
  }
  return path;
}

function parseAgentConfig(raw: string, path: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new GoldenAssertionError('agent.json is not valid JSON', {
      path,
      error: (error as Error).message,
    });
  }
  if (!isRecord(parsed)) {
    throw new GoldenAssertionError('agent.json root must be an object', { path });
  }
  return parsed;
}

function readModel(config: JsonRecord): unknown {
  return isRecord(config.models) ? config.models.model : undefined;
}

export async function lockAgentModelFile(input: {
  projectRoot: string;
  sid: string;
  agentId: string;
  model: string;
}): Promise<GoldenModelLockEvidence> {
  const model = input.model.trim();
  if (!model) throw new GoldenAssertionError('model lock requires a non-empty model');
  const path = await agentJsonPath(input.projectRoot, input.sid, input.agentId);
  const config = parseAgentConfig(await readFile(path, 'utf8'), path);
  const previousModel = readModel(config);
  const models = isRecord(config.models) ? { ...config.models } : {};
  models.model = model;
  const next = { ...config, models };
  const encoded = `${JSON.stringify(next, null, 2)}\n`;
  const temp = join(dirname(path), `.agent.json.golden-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, encoded, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  const reread = parseAgentConfig(await readFile(path, 'utf8'), path);
  const writtenModel = readModel(reread);
  if (typeof writtenModel !== 'string' || writtenModel !== model) {
    throw new GoldenAssertionError('agent model lock readback did not match the requested string', {
      path,
      expected: model,
      actual: writtenModel,
    });
  }
  return {
    sid: input.sid,
    agentId: input.agentId,
    model,
    agentJsonFile: path,
    previousModel,
    writtenModel,
    configSha256: sha256(await readFile(path, 'utf8')),
  };
}

export async function verifyAgentModelFileLock(
  evidence: GoldenModelLockEvidence,
): Promise<GoldenModelLockEvidence> {
  const info = await lstat(evidence.agentJsonFile);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new GoldenAssertionError('agent.json changed into a non-regular file after the turn', {
      path: evidence.agentJsonFile,
    });
  }
  const raw = await readFile(evidence.agentJsonFile, 'utf8');
  const config = parseAgentConfig(raw, evidence.agentJsonFile);
  const actual = readModel(config);
  if (typeof actual !== 'string' || actual !== evidence.model) {
    throw new GoldenAssertionError('agent model lock was overwritten during the turn', {
      path: evidence.agentJsonFile,
      expected: evidence.model,
      actual,
    });
  }
  return { ...evidence, writtenModel: actual, configSha256: sha256(raw) };
}

export async function readAgentLedger(input: {
  projectRoot: string;
  sid: string;
  agentId: string;
}): Promise<GoldenLedgerSnapshot> {
  const sessionRoot = await findSessionRoot(input.projectRoot, input.sid);
  const segments = safeAgentSegments(input.agentId);
  const eventsDir = resolve(sessionRoot, 'agents', ...segments, 'events');
  let names: string[];
  try {
    names = await readdir(eventsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], events: [] };
    throw error;
  }
  const files = names
    .flatMap((name) => {
      const match = LEDGER_SHARD_RE.exec(name);
      return match ? [{ order: Number(match[1]), path: resolve(eventsDir, name) }] : [];
    })
    .sort((left, right) => left.order - right.order)
    .map((item) => item.path);
  const events: JsonRecord[] = [];
  for (const path of files) {
    const raw = await readFile(path, 'utf8');
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new GoldenAssertionError('agent ledger contains invalid JSONL', {
          path,
          line: index + 1,
          error: (error as Error).message,
        });
      }
      if (!isRecord(parsed)) {
        throw new GoldenAssertionError('agent ledger row is not an object', {
          path,
          line: index + 1,
        });
      }
      events.push(parsed);
    }
  }
  return { files, events };
}

function eventPayload(event: JsonRecord): JsonRecord {
  return isRecord(event.payload) ? event.payload : {};
}

function verifyTurnModelDelta(input: {
  before: GoldenLedgerSnapshot;
  after: GoldenLedgerSnapshot;
  prompt: string;
  expectedModel: string;
  callId: string;
  correlationNonce: string;
}): GoldenTurnModelEvidence {
  if (input.after.events.length < input.before.events.length) {
    throw new GoldenAssertionError('agent ledger shrank during the turn', {
      before: input.before.events.length,
      after: input.after.events.length,
    });
  }
  const delta = input.after.events.slice(input.before.events.length);
  const users = delta.flatMap((event, index) => {
    const content = eventPayload(event).content;
    return event.type === 'user_input'
      && content === input.prompt
      && typeof content === 'string'
      && content.includes(input.correlationNonce)
      ? [index]
      : [];
  });
  if (users.length !== 1) {
    throw new GoldenAssertionError('captured CLI call did not map to exactly one ledger user_input', {
      callId: input.callId,
      matchingUserInputs: users,
      deltaTypes: delta.map((event) => event.type),
    });
  }
  const userEventOffset = users[0]!;
  const nextUserOffset = delta.findIndex((event, index) => (
    index > userEventOffset && event.type === 'user_input'
  ));
  const turnEnd = nextUserOffset < 0 ? delta.length : nextUserOffset;
  const assistants = delta.flatMap((event, index) => (
    index > userEventOffset
      && index < turnEnd
      && event.type === 'hook:assistantMessage'
      ? [{ index, model: eventPayload(event).model }]
      : []
  ));
  if (assistants.length !== 1) {
    throw new GoldenAssertionError('captured CLI call did not map to exactly one assistant ledger row', {
      callId: input.callId,
      assistants,
      deltaTypes: delta.map((event) => event.type),
    });
  }
  const assistant = assistants[0]!;
  if (assistant.model !== input.expectedModel) {
    throw new GoldenAssertionError('ledger turnReq.model did not match the requested model lock', {
      callId: input.callId,
      expected: input.expectedModel,
      actual: assistant.model,
    });
  }
  return {
    callId: input.callId,
    correlationMethod: 'runner-injected-nonce+isolated-ledger-delta',
    correlationNonceSha256: sha256(input.correlationNonce),
    requestedModel: input.expectedModel,
    userEventOffset,
    assistantEventOffset: assistant.index,
    ledgerEventCountBefore: input.before.events.length,
    ledgerEventCountAfter: input.after.events.length,
    ledgerFiles: input.after.files,
    promptSha256: sha256(input.prompt),
  };
}

export async function waitForTurnModelEvidence(input: {
  read: () => Promise<GoldenLedgerSnapshot>;
  before: GoldenLedgerSnapshot;
  prompt: string;
  expectedModel: string;
  callId: string;
  correlationNonce: string;
  timeoutMs?: number;
}): Promise<GoldenTurnModelEvidence> {
  if (!input.correlationNonce.trim() || !input.prompt.includes(input.correlationNonce)) {
    throw new TypeError('ledger correlation requires the runner nonce inside the prompt');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_LEDGER_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return verifyTurnModelDelta({
        before: input.before,
        after: await input.read(),
        prompt: input.prompt,
        expectedModel: input.expectedModel,
        callId: input.callId,
        correlationNonce: input.correlationNonce,
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  } while (Date.now() < deadline);
  throw new GoldenAssertionError('timed out waiting for ledger-backed requested-model evidence', {
    callId: input.callId,
    timeoutMs,
    lastError: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

const ATTRIBUTABLE_EVENT_NAMES = new Set([
  'token',
  'thinking',
  'tool-call',
  'tool-call-delta',
  'tool-result',
  'stored-event',
  'done',
  'error',
]);

export function assertLockedProviderOnWire(
  events: readonly StreamEvent[],
  expectedProviderId: string,
): { expected: string; eventCount: number; eventNames: string[] } {
  const attributable = events.filter((event) => {
    const data = isRecord(event.data) ? event.data : {};
    return ATTRIBUTABLE_EVENT_NAMES.has(event.event)
      || (typeof data.type === 'string' && ATTRIBUTABLE_EVENT_NAMES.has(data.type))
      || Object.hasOwn(data, 'providerId');
  });
  if (attributable.length === 0) {
    throw new GoldenAssertionError('model turn produced zero provider-attributable wire events', {
      expected: expectedProviderId,
      eventNames: events.map((event) => event.event),
    });
  }
  const violations = attributable.flatMap((event, index) => {
    const data = isRecord(event.data) ? event.data : {};
    return data.providerId === expectedProviderId
      ? []
      : [{ index, event: event.event, providerId: data.providerId ?? null }];
  });
  if (violations.length > 0) {
    throw new GoldenAssertionError(
      `model turn did not stay on locked provider ${expectedProviderId}`,
      {
        expected: expectedProviderId,
        violations,
        eventNames: attributable.map((event) => event.event),
      },
    );
  }
  return {
    expected: expectedProviderId,
    eventCount: attributable.length,
    eventNames: attributable.map((event) => event.event),
  };
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolvePort(port);
        else reject(new Error('failed to reserve a loopback port'));
      });
    });
  });
}

function spawnServerProcess(
  command: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): GoldenServerProcess {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal = 15) => { child.kill(signal); },
  };
}

async function drainCappedText(
  stream: ReadableStream<Uint8Array>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const retained = new Uint8Array(SERVER_LOG_LIMIT_BYTES);
  let retainedBytes = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (retainedBytes < SERVER_LOG_LIMIT_BYTES) {
      const room = SERVER_LOG_LIMIT_BYTES - retainedBytes;
      const slice = value.byteLength <= room ? value : value.slice(0, room);
      retained.set(slice, retainedBytes);
      retainedBytes += slice.byteLength;
      if (slice.byteLength < value.byteLength) truncated = true;
    } else {
      truncated = true;
    }
  }
  const longestSecretBytes = secretEnvironmentValues(env).reduce(
    (longest, secret) => Math.max(longest, new TextEncoder().encode(secret).byteLength),
    0,
  );
  const safeBytes = truncated
    ? Math.max(0, retainedBytes - Math.min(retainedBytes, longestSecretBytes))
    : retainedBytes;
  const text = new TextDecoder().decode(retained.subarray(0, safeBytes));
  return { text: redactGoldenEvidenceText(text, env), truncated };
}

export function buildGoldenServerManifest(input: {
  projectRoot: string;
  port: number;
  kernel: GoldenKernel;
}): GoldenServerStartupManifest {
  const environment = {
    FORGEAX_KERNEL: 'kernel' as const,
    FORGEAX_KERNEL_IMPL: input.kernel.providerId,
    FORGEAX_SERVER_HOST: '127.0.0.1' as const,
    FORGEAX_SERVER_PORT: String(input.port),
    FORGEAX_PROJECT_ROOT: resolve(input.projectRoot),
    FORGEAX_NO_WATCH: '1' as const,
  };
  const unsigned = {
    command: ['bun', 'packages/server/src/main.ts'],
    environment,
    port: input.port,
    expected: { ...input.kernel },
  };
  return { ...unsigned, configSha256: sha256(stableJson(unsigned)) };
}

export async function launchGoldenServer(
  options: LaunchGoldenServerOptions,
): Promise<GoldenServerRuntime> {
  const requested = options.requestedPort ?? 0;
  if (requested !== 0) {
    throw new TypeError('runner-owned golden server must request port 0');
  }
  const port = await (options.reservePort ?? reserveLoopbackPort)();
  const manifest = buildGoldenServerManifest({
    projectRoot: options.projectRoot,
    port,
    kernel: options.kernel,
  });
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...manifest.environment,
  };
  delete env.FORGEAX_NO_KERNEL;
  const actualCommand = [process.execPath, 'packages/server/src/main.ts'];
  const child = (options.spawnServer ?? spawnServerProcess)(actualCommand, {
    cwd: resolve(options.projectRoot),
    env,
  });
  const stdoutPromise = drainCappedText(child.stdout, env);
  const stderrPromise = drainCappedText(child.stderr, env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  let healthStatus = 0;
  let exitedEarly: number | undefined;
  while (now() < deadline) {
    const probe = await Promise.race([
      fetchImpl(`http://127.0.0.1:${port}/api/health`)
        .then((response) => ({ kind: 'health' as const, response }))
        .catch(() => ({ kind: 'retry' as const })),
      child.exited.then((exitCode) => ({ kind: 'exit' as const, exitCode })),
    ]);
    if (probe.kind === 'health' && probe.response.ok) {
      healthStatus = probe.response.status;
      break;
    }
    if (probe.kind === 'exit') {
      exitedEarly = probe.exitCode;
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (healthStatus === 0) {
    try { child.kill(9); } catch { /* already exited */ }
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    throw new GoldenAssertionError('runner-owned ForgeaX server did not become ready', {
      port,
      exitedEarly: exitedEarly ?? null,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    });
  }

  let stopped = false;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    startup: {
      manifest,
      readyAfterMs: Math.max(0, now() - started),
      healthStatus,
    },
    async stop() {
      if (stopped) {
        return {
          exitCode: await child.exited.catch(() => null),
          forced: false,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      stopped = true;
      let forced = false;
      try { child.kill(15); } catch { /* already exited */ }
      const timeout = Symbol('server-stop-timeout');
      const outcome = await Promise.race([
        child.exited,
        new Promise<typeof timeout>((resolveTimeout) => setTimeout(() => resolveTimeout(timeout), 5_000)),
      ]);
      let exitCode: number | null;
      if (outcome === timeout) {
        forced = true;
        try { child.kill(9); } catch { /* already exited */ }
        exitCode = await Promise.race([
          child.exited,
          new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), 1_000)),
        ]);
      } else {
        exitCode = outcome;
      }
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      return {
        exitCode,
        forced,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    },
  };
}

export async function createCliCaptureProxy(
  targetBaseUrlInput: string,
  testSeams: {
    fetchImpl?: typeof fetch;
    serve?: (options: {
      hostname: string;
      port: number;
      fetch(request: Request): Promise<Response>;
    }) => { port: number; stop(force?: boolean): void };
  } = {},
): Promise<GoldenCliCaptureProxy> {
  const targetBaseUrl = targetBaseUrlInput.replace(/\/+$/, '');
  let callId: string | undefined;
  const fetchImpl = testSeams.fetchImpl ?? fetch;
  const proxy = (testSeams.serve ?? ((options) => Bun.serve(options)))({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/api/cli/chat' || request.method !== 'POST') {
        return new Response('golden CLI proxy only accepts POST /api/cli/chat', { status: 404 });
      }
      if (callId) return new Response('golden CLI proxy accepts one turn only', { status: 409 });
      const raw = await request.text();
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response('invalid JSON request', { status: 400 });
      }
      const observed = isRecord(body) && typeof body.callId === 'string' ? body.callId.trim() : '';
      if (!observed) return new Response('callId required', { status: 400 });
      callId = observed;
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      return fetchImpl(`${targetBaseUrl}${url.pathname}${url.search}`, {
        method: 'POST',
        headers,
        body: raw,
        signal: request.signal,
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${proxy.port}`,
    capturedCallId() {
      if (!callId) throw new GoldenAssertionError('forge run emitted no capturable callId');
      return callId;
    },
    close() { proxy.stop(true); },
  };
}

export const defaultGoldenL4bEvidenceAdapter: GoldenL4bEvidenceAdapter = {
  lockAgentModel: lockAgentModelFile,
  verifyAgentModelLock: verifyAgentModelFileLock,
  readAgentLedger,
  createCliCaptureProxy,
};
