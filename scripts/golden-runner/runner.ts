#!/usr/bin/env bun
import { randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GoldenApi } from './lib/api.ts';
import {
  type FetchLike,
  type StreamEvent,
  readEventStream,
} from './lib/sse.ts';
import {
  assertLockedProviderOnWire,
  defaultGoldenL4bEvidenceAdapter,
  launchGoldenServer,
  MODEL_EXECUTION_M3_CLOSURE,
  MODEL_EXECUTION_WAIVER_NOTE,
  redactGoldenEvidenceText,
  waitForTurnModelEvidence,
  type GoldenL4bEvidenceAdapter,
  type GoldenModelLockEvidence,
  type GoldenServerRuntime,
  type GoldenServerStartupEvidence,
  type GoldenServerStopEvidence,
  type GoldenTurnModelEvidence,
  type LaunchGoldenServerOptions,
} from './lib/l4b-evidence.ts';
import {
  assertAllowedPartialOrder,
  GoldenAssertionError,
  type GoldenCaseContext,
  type GoldenCaseDefinition,
  type GoldenCaseState,
  type GoldenCliProcess,
  type GoldenCliRunOptions,
  type GoldenCliRunResult,
  type GoldenCliSpawner,
  type GoldenKernel,
  type GoldenMode,
  type GoldenStepResult,
} from './cases/_template.ts';

const DEFAULT_SERVER_PORT = 18900;
const DEFAULT_CLI_TIMEOUT_MS = 120_000;
const GOLDEN_STATE_VERSION = 1;
const CASE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const GOLDEN_SLUG_RE = /^gc-[0-9a-f]{8}$/;

export interface GoldenReportStep {
  name: string;
  ok: boolean;
  evidence: unknown;
}

export interface GoldenReport {
  case: string;
  mode: GoldenMode;
  runCompleted: boolean;
  steps: GoldenReportStep[];
  startedAt: string;
  durationMs: number;
  kernel?: { providerId: string; model: string };
  server?: {
    startup: GoldenServerStartupEvidence;
    teardown?: GoldenServerStopEvidence;
  };
  verification?: {
    bl2Verdict: 'PARTIAL';
    providerVerified: 'NOT_RUN' | 'PASS' | 'FAIL';
    requestedModelVerified: 'NOT_RUN' | 'PASS' | 'FAIL';
    modelExecutedVerified: 'WAIVED';
    modelExecutionWaiver: string;
    m3Closure: string;
    providerEvidence: Array<{ expected: string; eventCount: number; eventNames: string[] }>;
    requestedModelEvidence: GoldenTurnModelEvidence[];
  };
  metadata: { slug: string; sid?: string };
  failure?: { kind: 'assertion' | 'environment'; message: string };
}

export interface RunOutcome {
  report: GoldenReport;
  exitCode: 0 | 1 | 2;
}

export interface RunGoldenCaseOptions {
  mode: GoldenMode;
  serverPort?: number;
  projectRoot?: string;
  fetchImpl?: FetchLike;
  /** Tests may disable crash-state I/O while still exercising case execution. */
  manageArtifacts?: boolean;
  /** Tests inject a pipe-compatible process; production always uses Bun.spawn. */
  spawnCli?: GoldenCliSpawner;
  /** L4b always owns a dedicated server; false is accepted only outside L4b. */
  manageServer?: boolean;
  /** Test seam for server lifecycle; production uses launchGoldenServer. */
  launchServer?: (options: LaunchGoldenServerOptions) => Promise<GoldenServerRuntime>;
  /** Test seam for filesystem/proxy evidence; production uses the fail-closed adapter. */
  l4bEvidenceAdapter?: GoldenL4bEvidenceAdapter;
  /** Test seam for ledger polling; production uses the real fail-closed verifier. */
  verifyTurnModelEvidence?: typeof waitForTurnModelEvidence;
  now?: () => number;
  slugFactory?: () => string;
  runIdFactory?: () => string;
}

interface GoldenRunStateFile {
  version: 1;
  runId: string;
  pid: number;
  case: string;
  slug: string;
  sid?: string;
  startedAt: string;
}

export interface CleanupEvidence {
  apiAttempts: Array<{ resource: 'session' | 'game'; status?: number; error?: string }>;
  removedPaths: string[];
  warnings: string[];
}

interface CleanupGoldenArtifactsOptions {
  projectRoot: string;
  slug: string;
  sid?: string;
  api?: Pick<GoldenApi, 'deleteSession' | 'deleteGame'>;
}

interface CleanupStaleRunsOptions {
  projectRoot: string;
  api?: Pick<GoldenApi, 'deleteSession' | 'deleteGame'>;
  isProcessAlive?: (pid: number) => boolean;
}

interface CliOptions {
  caseName: string;
  mode: GoldenMode;
  serverPort: number;
  reportPath?: string;
}

const USAGE = 'bun scripts/golden-runner/runner.ts --case <name> [--mode l4a|l4b] [--server-port N] [--report <path>]';

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorEvidence(error: unknown): Record<string, unknown> {
  const value = asError(error);
  return {
    error: value.message,
    type: value.name,
    ...(error instanceof GoldenAssertionError && error.evidence !== undefined
      ? { detail: error.evidence }
      : {}),
  };
}

function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item instanceof Error) return errorEvidence(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'string') return redactGoldenEvidenceText(item, process.env);
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
  return encoded === undefined ? null : JSON.parse(encoded);
}

function isAssertionFailure(error: unknown): boolean {
  return error instanceof GoldenAssertionError
    || (error instanceof Error && error.name === 'AssertionError');
}

function normalizeStepResult(result: GoldenStepResult | undefined): GoldenStepResult {
  return result && typeof result === 'object' ? result : {};
}

const CLI_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
] as const;

export function buildGoldenCliEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(CLI_ENV_ALLOWLIST.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function spawnCliProcess(command: readonly string[], options: { cwd: string }): GoldenCliProcess {
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: buildGoldenCliEnvironment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal = 9) => { child.kill(signal); },
  };
}

function validateCliTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('CLI timeoutMs must be a positive finite number');
  }
}

async function readTextStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => {}); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return output + decoder.decode();
}

async function collectCliProcess(
  child: GoldenCliProcess,
  command: string[],
  timeoutMs: number,
): Promise<Omit<GoldenCliRunResult, 'callId'>> {
  // Drain both pipes immediately. stdout is teed so the report retains the
  // exact JSONL while the existing tolerant parser restores StreamEvent[] for
  // partial-order assertions.
  const drains = new AbortController();
  const [eventStream, stdoutStream] = child.stdout.tee();
  const eventsPromise = readEventStream(eventStream, undefined, drains.signal);
  const stdoutPromise = readTextStream(stdoutStream, drains.signal);
  const stderrPromise = readTextStream(child.stderr, drains.signal);
  const completed = Promise.all([
    child.exited,
    eventsPromise,
    stdoutPromise,
    stderrPromise,
  ]).then(([exitCode, events, stdout, stderr]) => ({
    command,
    exitCode,
    stdout,
    stderr,
    events,
  }));
  const timedOut = Symbol('cli-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof timedOut>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(timedOut), timeoutMs);
  });

  let resultOrTimeout: Omit<GoldenCliRunResult, 'callId'> | typeof timedOut;
  try {
    resultOrTimeout = await Promise.race([completed, timeout]);
  } catch (error) {
    try { child.kill(9); } catch { /* process may already be gone */ }
    drains.abort(error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (resultOrTimeout === timedOut) {
    let killError: string | undefined;
    try { child.kill(9); } catch (error) { killError = asError(error).message; }
    drains.abort(new Error(`forge run timed out after ${timeoutMs}ms`));
    const [events, stdout, stderr] = await Promise.all([
      eventsPromise,
      stdoutPromise,
      stderrPromise,
    ]);
    const exitWaitExpired = Symbol('exit-wait-expired');
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const exitCode = await Promise.race([
      child.exited,
      new Promise<typeof exitWaitExpired>((resolveTimeout) => {
        exitTimer = setTimeout(() => resolveTimeout(exitWaitExpired), 1_000);
      }),
    ]).finally(() => {
      if (exitTimer) clearTimeout(exitTimer);
    });
    throw new GoldenAssertionError(
      `forge run exceeded total timeout ${timeoutMs}ms`,
      {
        command,
        timeoutMs,
        killed: killError === undefined,
        killSignal: 9,
        exitCode: exitCode === exitWaitExpired ? null : exitCode,
        ...(killError ? { killError } : {}),
        stdout,
        stderr,
        eventNames: events.map((event) => event.event),
      },
    );
  }

  return resultOrTimeout;
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
    throw new Error('refusing to clean an unsafe session id');
  }
  return sid;
}

export function makeGoldenSlug(bytes: Uint8Array = randomBytes(4)): string {
  if (bytes.byteLength !== 4) throw new Error('golden slug requires exactly four random bytes');
  return `gc-${Buffer.from(bytes).toString('hex')}`;
}

async function removeOwnedPath(path: string, evidence: CleanupEvidence): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    evidence.warnings.push(`lstat ${path}: ${(error as Error).message}`);
    return;
  }
  try {
    if (stat.isSymbolicLink()) await unlink(path);
    else await rm(path, { recursive: true, force: true });
    evidence.removedPaths.push(path);
  } catch (error) {
    evidence.warnings.push(`remove ${path}: ${(error as Error).message}`);
  }
}

async function clearActiveGamePointer(
  projectRoot: string,
  slug: string,
  evidence: CleanupEvidence,
): Promise<void> {
  const path = resolve(projectRoot, '.forgeax', 'active-game.json');
  let parsed: { slug?: unknown };
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as { slug?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      evidence.warnings.push(`read ${path}: ${(error as Error).message}`);
    }
    return;
  }
  if (parsed.slug !== slug) return;
  try {
    await rm(path, { force: true });
    evidence.removedPaths.push(path);
  } catch (error) {
    evidence.warnings.push(`remove ${path}: ${(error as Error).message}`);
  }
}

/** Delete only resources whose slug proves runner ownership. All I/O is best-effort. */
export async function cleanupGoldenArtifacts(
  options: CleanupGoldenArtifactsOptions,
): Promise<CleanupEvidence> {
  const { projectRoot, api } = options;
  if (!GOLDEN_SLUG_RE.test(options.slug)) {
    throw new Error(`refusing to clean non-golden slug: ${options.slug}`);
  }
  const slug = options.slug;
  const sid = options.sid ? safeSid(options.sid) : undefined;
  const evidence: CleanupEvidence = { apiAttempts: [], removedPaths: [], warnings: [] };

  if (api && sid) {
    try {
      const response = await api.deleteSession(sid);
      evidence.apiAttempts.push({ resource: 'session', status: response.status });
    } catch (error) {
      evidence.apiAttempts.push({ resource: 'session', error: (error as Error).message });
    }
  }
  if (api) {
    try {
      const response = await api.deleteGame(slug);
      evidence.apiAttempts.push({ resource: 'game', status: response.status });
    } catch (error) {
      evidence.apiAttempts.push({ resource: 'game', error: (error as Error).message });
    }
  }

  // Offline/crashed-server fallback for both known session layouts.
  await removeOwnedPath(resolve(projectRoot, '.forgeax', 'games', slug), evidence);
  if (sid) {
    await removeOwnedPath(resolve(projectRoot, '.forgeax', 'sessions', sid), evidence);
  }
  await clearActiveGamePointer(projectRoot, slug, evidence);
  return evidence;
}

function runsDir(projectRoot: string): string {
  return resolve(projectRoot, '.forgeax', 'golden-runner', 'runs');
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeRunState(path: string, state: GoldenRunStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Recover only dead runner processes; live concurrent runs are left untouched. */
export async function cleanupStaleGoldenRuns(
  options: CleanupStaleRunsOptions,
): Promise<{ cleaned: string[]; skippedActive: string[]; warnings: string[] }> {
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const result = { cleaned: [] as string[], skippedActive: [] as string[], warnings: [] as string[] };
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await readdir(runsDir(options.projectRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = resolve(runsDir(options.projectRoot), entry.name);
    let state: GoldenRunStateFile;
    try {
      state = JSON.parse(await readFile(path, 'utf8')) as GoldenRunStateFile;
    } catch (error) {
      result.warnings.push(`invalid state ${entry.name}: ${(error as Error).message}`);
      continue;
    }
    if (state.version !== GOLDEN_STATE_VERSION || !GOLDEN_SLUG_RE.test(state.slug)) {
      result.warnings.push(`ignored unsafe state ${entry.name}`);
      continue;
    }
    if (isProcessAlive(state.pid)) {
      result.skippedActive.push(state.runId);
      continue;
    }
    let sid: string | undefined;
    if (state.sid) {
      try {
        sid = safeSid(state.sid);
      } catch (error) {
        result.warnings.push(`ignored unsafe sid in ${entry.name}: ${(error as Error).message}`);
      }
    }
    const cleanup = await cleanupGoldenArtifacts({
      projectRoot: options.projectRoot,
      slug: state.slug,
      ...(sid ? { sid } : {}),
      ...(options.api ? { api: options.api } : {}),
    });
    result.warnings.push(...cleanup.warnings);
    await rm(path, { force: true });
    result.cleaned.push(state.runId);
  }
  return result;
}

function validateDefinition(definition: GoldenCaseDefinition, mode: GoldenMode): void {
  if (!CASE_NAME_RE.test(definition.name)) throw new Error(`invalid case name: ${definition.name}`);
  if (!definition.modes.includes(mode)) {
    throw new Error(`case ${definition.name} does not support mode ${mode}`);
  }
  const names = definition.steps.map((step) => step.name);
  if (new Set(names).size !== names.length) throw new Error('case step names must be unique');
  if (mode === 'l4b') {
    if (!definition.kernel?.providerId || !definition.kernel.model) {
      throw new Error(`case ${definition.name} must lock kernel.providerId and kernel.model in l4b mode`);
    }
  }
}

export async function runGoldenCase(
  definition: GoldenCaseDefinition,
  options: RunGoldenCaseOptions,
): Promise<RunOutcome> {
  const now = options.now ?? Date.now;
  const startedMs = now();
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnCli = options.spawnCli ?? spawnCliProcess;
  const manageServer = options.manageServer ?? options.mode === 'l4b';
  const evidenceAdapter = options.l4bEvidenceAdapter ?? defaultGoldenL4bEvidenceAdapter;
  let serverPort = options.serverPort ?? (options.mode === 'l4b' ? 0 : DEFAULT_SERVER_PORT);
  if (!Number.isInteger(serverPort) || serverPort < 0 || serverPort > 65_535) {
    throw new TypeError(`invalid server port: ${serverPort}`);
  }
  if (options.mode === 'l4b' && !manageServer) {
    throw new TypeError('L4b requires runner-owned server evidence');
  }
  if (!manageServer && serverPort === 0) {
    throw new TypeError('serverPort=0 requires runner-owned server lifecycle');
  }
  if (options.mode === 'l4b' && serverPort !== 0) {
    throw new TypeError('L4b runner-owned server must request port 0');
  }
  const slug = (options.slugFactory ?? makeGoldenSlug)();
  if (!GOLDEN_SLUG_RE.test(slug)) throw new Error(`slugFactory returned invalid slug: ${slug}`);
  const report: GoldenReport = {
    case: definition.name,
    mode: options.mode,
    runCompleted: false,
    steps: [],
    startedAt: new Date(startedMs).toISOString(),
    durationMs: 0,
    ...(options.mode === 'l4b'
      ? {
          verification: {
            bl2Verdict: 'PARTIAL',
            providerVerified: 'NOT_RUN',
            requestedModelVerified: 'NOT_RUN',
            modelExecutedVerified: 'WAIVED',
            modelExecutionWaiver: MODEL_EXECUTION_WAIVER_NOTE,
            m3Closure: MODEL_EXECUTION_M3_CLOSURE,
            providerEvidence: [],
            requestedModelEvidence: [],
          },
        }
      : {}),
    metadata: { slug },
  };
  let exitCode: 0 | 1 | 2 = 0;
  let sid: string | undefined;
  let caseStarted = false;
  let statePath: string | undefined;
  const manageArtifacts = options.manageArtifacts !== false;
  const outputs = new Map<string, unknown>();
  const events: StreamEvent[] = [];
  const modelLocks = new Map<string, GoldenModelLockEvidence>();
  let serverRuntime: GoldenServerRuntime | undefined;
  let lockedKernel: Readonly<GoldenKernel> | undefined;

  const fail = (error: unknown): void => {
    if (exitCode !== 0) return;
    const assertion = isAssertionFailure(error);
    exitCode = assertion ? 1 : 2;
    report.failure = {
      kind: assertion ? 'assertion' : 'environment',
      message: asError(error).message,
    };
  };

  const execute = async (
    name: string,
    action: () => GoldenStepResult | Promise<GoldenStepResult>,
    outputName?: string,
  ): Promise<boolean> => {
    try {
      const result = normalizeStepResult(await action());
      if (outputName && Object.hasOwn(result, 'value')) outputs.set(outputName, result.value);
      report.steps.push({ name, ok: true, evidence: jsonSafe(result.evidence) });
      return true;
    } catch (error) {
      report.steps.push({ name, ok: false, evidence: jsonSafe(errorEvidence(error)) });
      fail(error);
      return false;
    }
  };

  try {
    validateDefinition(definition, options.mode);
    if (options.mode === 'l4b') {
      lockedKernel = Object.freeze(structuredClone(definition.kernel!));
      report.kernel = { ...lockedKernel };
    }
  } catch (error) {
    report.steps.push({ name: 'runner validation', ok: false, evidence: jsonSafe(errorEvidence(error)) });
    fail(error);
  }

  if (exitCode === 0 && options.mode === 'l4b' && manageServer) {
    try {
      serverRuntime = await (options.launchServer ?? launchGoldenServer)({
        projectRoot,
        requestedPort: serverPort,
        kernel: lockedKernel!,
        now,
      });
      serverPort = serverRuntime.port;
      report.server = { startup: serverRuntime.startup };
      report.steps.push({
        name: 'runner-owned server startup',
        ok: true,
        evidence: jsonSafe(serverRuntime.startup),
      });
    } catch (error) {
      report.steps.push({
        name: 'runner-owned server startup',
        ok: false,
        evidence: jsonSafe(errorEvidence(error)),
      });
      fail(error);
    }
  }

  const baseUrl = serverRuntime?.baseUrl ?? `http://127.0.0.1:${serverPort}`;

  const state: GoldenCaseState = {
    value<T = unknown>(stepName: string): T {
      if (!outputs.has(stepName)) throw new Error(`case step produced no value: ${stepName}`);
      return outputs.get(stepName) as T;
    },
    get events() { return events; },
  };

  const runId = (options.runIdFactory ?? randomUUID)();
  const runState: GoldenRunStateFile = {
    version: 1,
    runId,
    pid: process.pid,
    case: definition.name,
    slug,
    startedAt: report.startedAt,
  };

  const recordSession = async (nextSid: string): Promise<void> => {
    sid = safeSid(nextSid);
    report.metadata.sid = sid;
    runState.sid = sid;
    if (manageArtifacts && statePath) await writeRunState(statePath, runState);
  };
  const api = new GoldenApi(baseUrl, fetchImpl, recordSession);

  const context: GoldenCaseContext = {
    mode: options.mode,
    baseUrl,
    serverPort,
    projectRoot,
    slug,
    get sid() { return sid; },
    api,
    fetch: fetchImpl,
    recordSession,
    async lockAgentModel(agentId: string) {
      if (options.mode !== 'l4b' || !lockedKernel) {
        throw new Error('ctx.lockAgentModel is available only to l4b cases with a locked kernel');
      }
      if (!sid) throw new Error('ctx.lockAgentModel requires a recorded session');
      const existing = modelLocks.get(agentId);
      if (existing) return evidenceAdapter.verifyAgentModelLock(existing);
      const locked = await evidenceAdapter.lockAgentModel({
        projectRoot,
        sid,
        agentId,
        model: lockedKernel.model,
      });
      modelLocks.set(agentId, locked);
      return locked;
    },
    async runCli(runOptions: GoldenCliRunOptions) {
      if (options.mode !== 'l4b' || !lockedKernel) {
        throw new Error('ctx.runCli is available only to l4b cases with a locked kernel');
      }
      if (!sid) throw new Error('ctx.runCli requires a recorded session');
      if (!runOptions.prompt.trim()) throw new Error('ctx.runCli requires a non-empty prompt');
      if (!runOptions.agentId.trim()) throw new Error('ctx.runCli requires a non-empty agentId');
      const timeoutMs = runOptions.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
      validateCliTimeout(timeoutMs);
      const modelLock = modelLocks.get(runOptions.agentId)
        ?? await context.lockAgentModel(runOptions.agentId);
      const ledgerBefore = await evidenceAdapter.readAgentLedger({
        projectRoot,
        sid,
        agentId: runOptions.agentId,
      });
      const correlationNonce = randomUUID();
      const correlatedPrompt = `${runOptions.prompt}\n\n[forgeax-golden-correlation-nonce:${correlationNonce}]`;
      const proxy = await evidenceAdapter.createCliCaptureProxy(baseUrl);
      const command = [
        './packages/orchestrator/bin/forge',
        'run',
        '--json',
        correlatedPrompt,
        '--agent',
        runOptions.agentId,
        '--session',
        sid,
        '--server',
        proxy.baseUrl,
      ];
      let result: GoldenCliRunResult;
      let callId: string;
      try {
        const collected = await collectCliProcess(
          spawnCli(command, { cwd: projectRoot }),
          command,
          timeoutMs,
        );
        callId = proxy.capturedCallId();
        result = {
          ...collected,
          stdout: redactGoldenEvidenceText(collected.stdout, process.env),
          stderr: redactGoldenEvidenceText(collected.stderr, process.env),
          callId,
        };
      } catch (error) {
        if (report.verification) {
          report.verification.providerVerified = 'FAIL';
          report.verification.requestedModelVerified = 'FAIL';
        }
        throw error;
      } finally {
        proxy.close();
      }
      events.push(...result.events);

      try {
        const providerEvidence = assertLockedProviderOnWire(
          result.events,
          lockedKernel.providerId,
        );
        report.verification!.providerEvidence.push(providerEvidence);
        report.verification!.providerVerified = 'PASS';
      } catch (error) {
        report.verification!.providerVerified = 'FAIL';
        throw error;
      }

      try {
        const requestedModelEvidence = await (options.verifyTurnModelEvidence ?? waitForTurnModelEvidence)({
          read: () => evidenceAdapter.readAgentLedger({
            projectRoot,
            sid,
            agentId: runOptions.agentId,
          }),
          before: ledgerBefore,
          prompt: correlatedPrompt,
          expectedModel: lockedKernel.model,
          callId,
          correlationNonce,
        });
        await evidenceAdapter.verifyAgentModelLock(modelLock);
        report.verification!.requestedModelEvidence.push(requestedModelEvidence);
        report.verification!.requestedModelVerified = 'PASS';
      } catch (error) {
        report.verification!.requestedModelVerified = 'FAIL';
        throw error;
      }

      if (result.exitCode !== 0) {
        throw new GoldenAssertionError(
          `forge run exited with code ${result.exitCode}`,
          {
            callId,
            command,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            eventNames: result.events.map((event) => event.event),
          },
        );
      }
      return result;
    },
  };

  try {
    try {
      if (exitCode !== 0) throw new Error('runner validation or server startup failed');
      let stale: Awaited<ReturnType<typeof cleanupStaleGoldenRuns>> | undefined;
      if (manageArtifacts) {
        stale = await cleanupStaleGoldenRuns({ projectRoot, api });
        statePath = resolve(runsDir(projectRoot), `${runId}.json`);
        await writeRunState(statePath, runState);
      }
      report.steps.push({
        name: 'runner setup',
        ok: true,
        evidence: jsonSafe({
          slug,
          serverPort,
          serverOwned: Boolean(serverRuntime),
          staleRunsCleaned: stale?.cleaned.length ?? 0,
          activeRunsSkipped: stale?.skippedActive.length ?? 0,
          warnings: stale?.warnings ?? [],
        }),
      });
      caseStarted = true;
    } catch (error) {
      report.steps.push({ name: 'runner setup', ok: false, evidence: jsonSafe(errorEvidence(error)) });
      fail(error);
    }

    if (exitCode === 0 && definition.setup) {
      await execute('case setup', () => definition.setup!(context, state));
    }

    for (const step of definition.steps) {
      if (exitCode !== 0) break;
      await execute(step.name, () => step.run(context, state), step.name);
    }

    if (exitCode === 0 && options.mode === 'l4b') {
      await execute('assert: l4b verification completeness', () => {
        const verification = report.verification!;
        if (
          !report.server
          ||
          verification.providerVerified !== 'PASS'
          || verification.requestedModelVerified !== 'PASS'
          || verification.providerEvidence.length === 0
          || verification.requestedModelEvidence.length === 0
        ) {
          throw new GoldenAssertionError('L4b provider/requested-model evidence is incomplete', {
            providerVerified: verification.providerVerified,
            requestedModelVerified: verification.requestedModelVerified,
            providerEvidenceCount: verification.providerEvidence.length,
            requestedModelEvidenceCount: verification.requestedModelEvidence.length,
            serverEvidencePresent: Boolean(report.server),
          });
        }
        return {
          evidence: {
            bl2Verdict: verification.bl2Verdict,
            providerVerified: verification.providerVerified,
            requestedModelVerified: verification.requestedModelVerified,
            modelExecutedVerified: verification.modelExecutedVerified,
            modelExecutionWaiver: verification.modelExecutionWaiver,
            m3Closure: verification.m3Closure,
          },
        };
      });
    }

    for (const assertion of definition.asserts ?? []) {
      if (exitCode !== 0) break;
      await execute(`assert: ${assertion.name}`, async () => ({
        evidence: await assertion.check(context, state),
      }));
    }

    if (exitCode === 0 && options.mode === 'l4b' && definition.partialOrder?.length) {
      await execute('assert: allowed partial order', () => {
        assertAllowedPartialOrder(events, definition.partialOrder!);
        return {};
      });
    }
  } finally {
    if (caseStarted && definition.teardown) {
      await execute('case teardown', () => definition.teardown!(context, state));
    }

    let cleanup: CleanupEvidence | undefined;
    if (manageArtifacts) {
      try {
        cleanup = await cleanupGoldenArtifacts({ projectRoot, slug, ...(sid ? { sid } : {}), api });
      } catch (error) {
        cleanup = { apiAttempts: [], removedPaths: [], warnings: [asError(error).message] };
      }
      if (statePath) {
        try {
          await rm(statePath, { force: true });
        } catch (error) {
          cleanup.warnings.push(`remove ${statePath}: ${(error as Error).message}`);
        }
      }
    }
    report.steps.push({
      name: 'runner teardown',
      ok: true,
      evidence: jsonSafe(cleanup ?? { skipped: true }),
    });
    if (serverRuntime) {
      try {
        const stopped = await serverRuntime.stop();
        report.server = { startup: serverRuntime.startup, teardown: stopped };
        if (stopped.forced || stopped.exitCode !== 0) {
          throw new Error(
            `runner-owned server teardown was not clean (exit=${String(stopped.exitCode)}, forced=${String(stopped.forced)})`,
          );
        }
        report.steps.push({
          name: 'runner-owned server teardown',
          ok: true,
          evidence: jsonSafe({
            exitCode: stopped.exitCode,
            forced: stopped.forced,
            stdoutTruncated: stopped.stdoutTruncated,
            stderrTruncated: stopped.stderrTruncated,
          }),
        });
      } catch (error) {
        report.steps.push({
          name: 'runner-owned server teardown',
          ok: false,
          evidence: jsonSafe(errorEvidence(error)),
        });
        fail(error);
      }
    }
    report.metadata = { slug, ...(sid ? { sid } : {}) };
    report.runCompleted = exitCode === 0;
    report.durationMs = Math.max(0, now() - startedMs);
  }

  return { report, exitCode };
}

export function parseRunnerArgs(argv: string[], env = process.env): CliOptions {
  let caseName = '';
  let mode: GoldenMode = 'l4a';
  let portRaw: string | undefined;
  let reportPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[++index];
      if (!value) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--case': caseName = next(); break;
      case '--mode': {
        const value = next();
        if (value !== 'l4a' && value !== 'l4b') throw new Error(`invalid --mode: ${value}`);
        mode = value;
        break;
      }
      case '--server-port': portRaw = next(); break;
      case '--report': reportPath = next(); break;
      case '-h':
      case '--help': throw new Error(USAGE);
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!CASE_NAME_RE.test(caseName)) throw new Error('--case must be a lowercase kebab-case name');
  const resolvedPortRaw = portRaw ?? (mode === 'l4b'
    ? '0'
    : env.FORGEAX_SERVER_PORT ?? String(DEFAULT_SERVER_PORT));
  const serverPort = Number(resolvedPortRaw);
  if (
    !Number.isInteger(serverPort)
    || serverPort < (mode === 'l4b' ? 0 : 1)
    || serverPort > 65_535
  ) {
    throw new Error(`invalid server port: ${resolvedPortRaw}`);
  }
  if (mode === 'l4b' && serverPort !== 0) {
    throw new Error('L4b runner-owned server must request port 0');
  }
  return { caseName, mode, serverPort, ...(reportPath ? { reportPath } : {}) };
}

export async function loadGoldenCase(caseName: string): Promise<GoldenCaseDefinition> {
  if (!CASE_NAME_RE.test(caseName)) throw new Error(`invalid case name: ${caseName}`);
  const url = new URL(`./cases/${caseName}.ts`, import.meta.url);
  let module: { default?: unknown };
  try {
    module = await import(url.href) as { default?: unknown };
  } catch (error) {
    throw new Error(`failed to load golden case ${caseName}: ${(error as Error).message}`, { cause: error });
  }
  if (!module.default || typeof module.default !== 'object') {
    throw new Error(`golden case ${caseName} has no default definition export`);
  }
  const definition = module.default as GoldenCaseDefinition;
  if (definition.name !== caseName) {
    throw new Error(`golden case name mismatch: requested ${caseName}, exported ${definition.name}`);
  }
  return definition;
}

async function outputReport(report: GoldenReport, reportPath?: string): Promise<void> {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (!reportPath) {
    process.stdout.write(json);
    return;
  }
  const path = resolve(reportPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json, 'utf8');
}

export async function main(argv = process.argv.slice(2)): Promise<0 | 1 | 2> {
  let options: CliOptions;
  try {
    options = parseRunnerArgs(argv);
  } catch (error) {
    process.stderr.write(`${asError(error).message}\n${USAGE}\n`);
    return 2;
  }

  let definition: GoldenCaseDefinition;
  try {
    definition = await loadGoldenCase(options.caseName);
  } catch (error) {
    process.stderr.write(`${asError(error).message}\n`);
    return 2;
  }

  const outcome = await runGoldenCase(definition, {
    mode: options.mode,
    serverPort: options.serverPort,
  });
  try {
    await outputReport(outcome.report, options.reportPath);
  } catch (error) {
    process.stderr.write(`failed to write golden report: ${asError(error).message}\n`);
    return 2;
  }
  return outcome.exitCode;
}

if (import.meta.main) {
  process.exitCode = await main();
}
