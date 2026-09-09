import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readDotenv } from './env.ts';
import {
  canBindPort,
  clearPidfiles,
  isAlive,
  isPortBusy,
  killTree,
  listenPids,
  selfAndAncestors,
  sleep,
  spawnService,
} from './proc.ts';
import { readinessSummary, waitForRuntime } from './runtime-readiness.ts';
import {
  readRuntimeState,
  runtimeStateBelongsToInstance,
  type RuntimeOwnerIdentity,
  type RuntimeState,
} from './runtime-state.ts';
import {
  resolveRuntimeInstance,
  runtimeInstanceProcessEnv,
  writeRuntimeInstanceManifest,
  type RuntimeInstance,
} from './runtime-instance.ts';
import {
  readRuntimeProcessSnapshot,
  runtimeProcessBelongsToInstance,
  type RuntimeProcessSnapshot,
} from './runtime-process-owner.ts';
import {
  resolveStartupEnvironment,
  startupProcessEnv,
  type StartupEnvironment,
  type StartupProfile,
} from './startup-environment.ts';
import { StartLock } from './startlock.ts';
import {
  acquireRuntimePortStartupLocks,
  type RuntimePortStartupLocks,
} from './runtime-port-lock.ts';
import { resolveActiveServerRole } from './server-role.ts';
import { cleanupStopArtifacts, resolveInstanceStopScope, type StopScope } from './stop-scope.ts';
import {
  approvedSnapshotMatches,
  canFinalizeStop,
  discoverStopTargets,
  waitForStopPids,
  type StopDiscovery,
  type StopDiscoveryDeps,
  type StopRefusal,
} from './stop-execution.ts';

export type ExistingRuntimePolicy = 'error' | 'ensure' | 'restart';

export interface StartSourceRuntimeOptions {
  readonly root: string;
  readonly profile: Exclude<StartupProfile, 'desktop-prod'>;
  readonly existing: ExistingRuntimePolicy;
  readonly runArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Interactive operator approval for exact foreign/orphan PIDs discovered during restart. */
  readonly approveUnownedStop?: (refusals: readonly StopRefusal[]) => boolean | Promise<boolean>;
}

export interface StartedSourceRuntime {
  readonly startup: StartupEnvironment;
  readonly launcherPid: number;
  readonly reused: boolean;
}

export interface LiveRuntimeStateDependencies {
  readonly readState?: (path: string) => RuntimeState | null;
  readonly isAlive?: (pid: number) => boolean;
  readonly readProcessSnapshot?: (pid: number) => RuntimeProcessSnapshot | null;
  readonly processBelongsToInstance?: (
    snapshot: RuntimeProcessSnapshot | null,
    request: { root: string; service: 'launcher' },
  ) => boolean;
}

export interface SourceRuntimeStopTargets {
  readonly scope: StopScope;
  readonly discovery: StopDiscovery;
}

/** One shared discovery model for normal state, missing state, run.lock, plugin
 * wrappers, and listener children. Restart must not maintain a second, smaller
 * list of process shapes than the lifecycle stop contract. */
export function discoverSourceRuntimeStopTargets(
  instance: RuntimeInstance,
  state: RuntimeState | null,
  owners: RuntimeOwnerIdentity,
  deps: StopDiscoveryDeps,
): SourceRuntimeStopTargets {
  const scope = resolveInstanceStopScope(instance, state, {
    activeServer: owners.server,
    interfaceDir: owners.interface.dir,
  });
  return { scope, discovery: discoverStopTargets(scope, deps) };
}

/** Re-check PIDs that survived graceful shutdown against the exact owner
 * contracts that originally admitted them. RuntimeState may disappear when
 * the launcher handles SIGTERM, but a still-owned wrapper must still be forced
 * down instead of being forgotten between discovery passes. */
export function revalidateSourceRuntimeStopSurvivors(
  initial: SourceRuntimeStopTargets,
  survivors: readonly number[],
  deps: Pick<StopDiscoveryDeps, 'readSnapshot' | 'owns' | 'approvedUnownedProcesses'>,
): Map<number, string> {
  const carried = new Map<number, string>();
  for (const pid of survivors) {
    const label = initial.discovery.found.get(pid);
    if (!label) continue;
    const snapshot = deps.readSnapshot(pid);
    if (!snapshot) continue;
    const owners = [
      ...initial.scope.pids.filter((target) => target.pid === pid).flatMap((target) => target.owners),
      ...initial.scope.ports.filter((target) => target.key === label).map((target) => target.owner),
    ];
    if (
      !owners.some((owner) => deps.owns(snapshot, owner))
      && !approvedSnapshotMatches(snapshot, deps.approvedUnownedProcesses?.get(pid))
    ) {
      throw new Error(`refusing to force graceful survivor pid=${pid}: ownership changed`);
    }
    carried.set(pid, label);
  }
  return carried;
}

/** Returns state only after validating its instance, PID liveness, and PID ownership. */
export function liveRuntimeStateForInstance(
  instance: RuntimeInstance,
  deps: LiveRuntimeStateDependencies = {},
): RuntimeState | null {
  const state = (deps.readState ?? readRuntimeState)(instance.stateFile);
  if (!runtimeStateBelongsToInstance(instance, state)) return null;
  if (!(deps.isAlive ?? isAlive)(state.launcherPid)) return null;
  const snapshot = (deps.readProcessSnapshot ?? readRuntimeProcessSnapshot)(state.launcherPid);
  if (
    !(deps.processBelongsToInstance ?? runtimeProcessBelongsToInstance)(snapshot, {
      root: instance.root,
      service: 'launcher',
    })
  )
    return null;
  return state;
}

/** Exact startup compatibility required before `--ensure` may reuse a launcher. */
export function runtimeStateMatchesStartup(
  state: RuntimeState,
  startup: StartupEnvironment,
  owners: RuntimeOwnerIdentity,
): boolean {
  return state.profile === startup.profile
    && isDeepStrictEqual(state.startup, startup)
    && isDeepStrictEqual(state.owners, owners);
}

export function resolveExpectedRuntimeOwners(
  root: string,
  childEnv: NodeJS.ProcessEnv,
): RuntimeOwnerIdentity {
  const activeServer = resolveActiveServerRole({
    root,
    profile: childEnv.FORGEAX_SERVER_PROFILE,
  });
  return {
    server: { packageDir: activeServer.packageDir, entry: activeServer.entry },
    interface: { dir: join(root, 'packages', 'ide') },
  };
}

export function ensureRuntimeAction(
  state: RuntimeState,
  startup: StartupEnvironment,
  owners: RuntimeOwnerIdentity,
): 'reuse' | 'restart' {
  return runtimeStateMatchesStartup(state, startup, owners) ? 'reuse' : 'restart';
}

export function resolveSourceRuntimeEnvironment(
  root: string,
  profile: Exclude<StartupProfile, 'desktop-prod'>,
  suppliedEnv: NodeJS.ProcessEnv = process.env,
): { startup: StartupEnvironment; childEnv: NodeJS.ProcessEnv } {
  const instance = resolveRuntimeInstance({ root });
  // This is deliberately pure: the pre-lock probe must not mutate the parent
  // environment into an old instance projection. The persisted instance owns
  // all runtime paths/ports; only a socket explicitly supplied by the parent
  // may override its agent-host socket.
  const parentAgentHostSocket = suppliedEnv.FORGEAX_AGENT_HOST_SOCK;
  const dotenv = readDotenv(instance.envFile);
  const agentHostSocket = parentAgentHostSocket ?? dotenv.FORGEAX_AGENT_HOST_SOCK ?? instance.agentHostSocket;
  const env = {
    ...process.env,
    ...dotenv,
    ...suppliedEnv,
    // Source runs need the same credentialed Server ↔ Engine runtime-scope
    // channel as packaged runs. Generate it once for this resolved child
    // environment when neither the instance env file nor the caller owns it.
    FORGEAX_RUNTIME_SCOPE_SECRET:
      suppliedEnv.FORGEAX_RUNTIME_SCOPE_SECRET
      ?? dotenv.FORGEAX_RUNTIME_SCOPE_SECRET
      ?? randomUUID(),
    ...runtimeInstanceProcessEnv(instance),
    FORGEAX_AGENT_HOST_SOCK: agentHostSocket,
  };
  const startup = resolveStartupEnvironment({ root, profile, env });
  // startupProcessEnv is the final authority for values it controls. In
  // particular, when FORGEAX_BRIDGE=0 it deliberately removes the bridge port
  // rather than letting the RuntimeInstance's potential bridge port leak back
  // into a disabled runtime.
  const childEnv = startupProcessEnv(startup, env);
  // The handoff credential is transport-only; never project it into a normal
  // launcher/service environment even if a caller accidentally supplied one.
  delete childEnv.FORGEAX_START_LOCK_HANDOFF_TOKEN;
  return { startup, childEnv };
}

export async function startSourceRuntime(options: StartSourceRuntimeOptions): Promise<StartedSourceRuntime> {
  const root = resolve(options.root);
  const suppliedEnv = options.env ?? process.env;
  // This projection is only for deciding whether an already-running launcher
  // may be reused/stopped. The actual start transaction resolves again after
  // it owns run.lock, so `instance init --force` cannot strand a launcher on
  // the configuration observed here.
  let { startup, childEnv } = resolveSourceRuntimeEnvironment(root, options.profile, suppliedEnv);

  if (options.existing === 'restart') {
    await stopSourceRuntime(root, childEnv, options.approveUnownedStop);
  } else {
    const instance = resolveRuntimeInstance({ root });
    const state = liveRuntimeStateForInstance(instance);
    if (state) {
      if (options.existing === 'ensure') {
        const expectedOwners = resolveExpectedRuntimeOwners(root, childEnv);
        if (ensureRuntimeAction(state, startup, expectedOwners) === 'reuse') {
          const readiness = await waitForRuntime(startup, {
            launcherAlive: () => isAlive(state.launcherPid),
          });
          if (readiness.ready) {
            writeRuntimeInstanceManifest(instance);
            return { startup, launcherPid: state.launcherPid, reused: true };
          }
        }
        await stopSourceRuntime(root, childEnv);
      } else {
        throw new Error(`local runtime launcher is already running (pid ${state.launcherPid}); use \`bun fx restart\``);
      }
    }
  }

  const initiallyBusy = await occupiedSourceRuntimePorts(startup);
  if (initiallyBusy.length > 0) {
    if (options.existing === 'ensure') await stopSourceRuntime(root, childEnv);
    else throw new Error(formatBusyPorts(initiallyBusy));
  }

  // RuntimeInstance config is checkout-local, but its service ports are
  // host-global. Dispose the prior runtime before taking these startup leases:
  // cleanup uses the server lease as its own recovery guard. From here through
  // readiness, the leases close the probe-to-bind race with other starters.
  const portStartupLocks = await acquireRuntimePortStartupLocks(
    sourceRuntimePorts(startup).map(([, port]) => port),
    { root },
  );
  // `instance init` is allowed to publish the RuntimeInstance under its own
  // StartLock. If that publication lands between the initial projection above
  // and the start transaction below, the final projection can name a
  // different host-global port tuple. Keep the initial lease while acquiring
  // any newly projected ports so there is no unlock/rebind gap.
  let finalPortStartupLocks: RuntimePortStartupLocks | null = null;
  try {

    const lock = new StartLock(root);
    lock.acquireOrThrow();
    let launcherPid = 0;
    try {
      // Re-read the complete RuntimeInstance after acquiring the same lock used
      // by `instance init`; all port preflight and child projection below are now
      // one atomic startup transaction.
      ({ startup, childEnv } = resolveSourceRuntimeEnvironment(root, options.profile, suppliedEnv));
      // Publish the resolved, credential-free endpoint contract under the same
      // instance lock that owns the final child environment. Browsers and
      // evidence collectors consume this file instead of re-deriving ports.
      writeRuntimeInstanceManifest(resolveRuntimeInstance({ root }));

      const finalPorts = additionalSourceRuntimePorts(startup, portStartupLocks.ports);
      if (finalPorts.length > 0) {
        finalPortStartupLocks = await acquireRuntimePortStartupLocks(finalPorts, { root });
      }

      const busy = await occupiedSourceRuntimePorts(startup);
      if (busy.length > 0) {
        throw new Error(formatBusyPorts(busy));
      }

      const logFd = openRuntimeLog(startup.logFile);
      const startupLogCursor = { offset: 0, partialLine: false };
      console.log(`[start] streaming startup logs from ${startup.logFile}`);
      const launcher = spawnService(
        'bun',
        [join(root, 'scripts', 'local-runtime.ts'), '--profile', startup.profile, ...(options.runArgs ?? [])],
        {
          cwd: root,
          detach: true,
          logFd,
          env: {
            ...childEnv,
            FORGEAX_START_LOCK_HANDOFF_TOKEN: lock.handoffToken(),
          },
        },
      );
      closeSync(logFd);
      launcherPid = launcher.pid ?? 0;
      if (!launcherPid) throw new Error('local runtime launcher did not return a pid');

      const readiness = await waitForRuntime(startup, {
        launcherAlive: () => isAlive(launcherPid),
        onCheck: () => streamNewLog(startup.logFile, startupLogCursor),
      });
      streamNewLog(startup.logFile, startupLogCursor);
      if (startupLogCursor.partialLine) process.stdout.write('\n');
      if (!readiness.ready) {
        throw new Error(
          `local runtime failed readiness: ${readinessSummary(readiness)}\n` +
            `last lines of ${startup.logFile}:\n${tailLog(startup.logFile, 40)}`,
        );
      }

      return { startup, launcherPid, reused: false };
    } catch (error) {
      if (!launcherPid) lock.release();
      else {
        if (isAlive(launcherPid)) killTree(launcherPid, true);
        await waitForLauncherExit(launcherPid);
        // Only clears a dead child (or a not-yet-adopted parent owner); a live
        // adopted launcher remains the authoritative lock owner.
        lock.releaseHandoffFailure(launcherPid);
      }
      throw error;
    }
  } finally {
    // Release after readiness or rollback has completed, never before the
    // RuntimeInstance owns (or has cleaned) every declared service port.
    finalPortStartupLocks?.release();
    portStartupLocks.release();
  }
}

async function waitForLauncherExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function occupiedSourceRuntimePorts(startup: StartupEnvironment) {
  const endpoints = [
    ['server', startup.server],
    ['interface', startup.interface],
    ['engine', startup.engine],
    ...(startup.mcp.enabled ? [['engine-mcp', startup.mcp] as const] : []),
  ] as const;
  const entries = await Promise.all(endpoints.map(async ([name, endpoint]) => {
    const pids = listenPids(endpoint.port);
    if (pids.length > 0) return { name, port: endpoint.port, pids };
    if (await canBindPort(endpoint.port, endpoint.host)) return null;
    // No listener is visible, but the exact bind the child will perform is
    // still rejected (for example while a recently closed socket is settling).
    return { name, port: endpoint.port, pids: [] };
  }));
  return entries.filter((entry): entry is { name: string; port: number; pids: number[] } => entry !== null);
}

function formatBusyPorts(busy: ReadonlyArray<{ name: string; port: number; pids: readonly number[] }>): string {
  return `dev stack ports are already occupied: ${busy
    .map(({ name, port, pids }) => `${name}=:${port}${pids.length > 0 ? ` pid=${pids.join(',')}` : ' (not bindable)'}`)
    .join('; ')}`;
}

export function sourceRuntimePorts(startup: StartupEnvironment): ReadonlyArray<readonly [name: string, port: number]> {
  const ports: Array<readonly [string, number]> = [
    ['server', startup.server.port],
    ['interface', startup.interface.port],
    ['engine', startup.engine.port],
    ...(startup.mcp.enabled ? [['engine-mcp', startup.mcp.port] as const] : []),
  ];
  return ports;
}

/** Core ports in the final startup projection that are not already leased. */
export function additionalSourceRuntimePorts(
  startup: StartupEnvironment,
  leasedPorts: readonly number[],
): readonly number[] {
  const leased = new Set(leasedPorts);
  return sourceRuntimePorts(startup)
    .map(([, port]) => port)
    .filter((port) => !leased.has(port));
}

/** Runtime ports that are safe to report, but not necessarily reserve. */
export function sourceRuntimeStatusPorts(
  startup: StartupEnvironment,
): ReadonlyArray<readonly [name: string, port: number]> {
  return [
    ...sourceRuntimePorts(startup),
    ['narrative', startup.optional.narrativePort],
    ['face-mask', startup.optional.faceMaskPort],
    ['rhi-reviewer', startup.optional.rhiReviewerPort],
  ];
}

async function stopSourceRuntime(
  root: string,
  env: NodeJS.ProcessEnv,
  approveUnownedStop?: StartSourceRuntimeOptions['approveUnownedStop'],
): Promise<void> {
  const instance = resolveRuntimeInstance({ root });
  const owners = resolveExpectedRuntimeOwners(root, env);
  const approvedUnownedProcesses = new Map<number, RuntimeProcessSnapshot>();
  const deps: StopDiscoveryDeps = {
    listenPids,
    readSnapshot: readRuntimeProcessSnapshot,
    owns: runtimeProcessBelongsToInstance,
    isAlive,
    isPortBusy,
    protectedPids: selfAndAncestors(),
    approvedUnownedProcesses,
  };
  const discover = (): SourceRuntimeStopTargets => discoverSourceRuntimeStopTargets(
    instance,
    readRuntimeState(instance.stateFile),
    owners,
    deps,
  );

  let gracefulTargets = discover();
  const approvable = gracefulTargets.discovery.refusals.filter(
    (refusal) => refusal.reason === 'ownership-unproven'
      && refusal.cwd !== null
      && refusal.commandLine !== null
      && refusal.startToken !== null,
  );
  if (approvable.length > 0 && approveUnownedStop && await approveUnownedStop(approvable)) {
    for (const refusal of approvable) {
      approvedUnownedProcesses.set(refusal.pid, {
        pid: refusal.pid,
        cwd: refusal.cwd,
        commandLine: refusal.commandLine,
        startToken: refusal.startToken,
      });
    }
    // Bind consent to the exact observed PIDs, then rediscover. A replacement
    // PID or newly protected ancestor remains unapproved and fails closed.
    gracefulTargets = discover();
  }
  assertSourceRuntimeStopIsSafe(gracefulTargets);
  let gracefulSurvivors: number[] = [];
  if (gracefulTargets.discovery.found.size > 0) {
    console.log(`[restart] stopping ${gracefulTargets.discovery.found.size} checkout-owned runtime process(es)`);
    for (const pid of gracefulTargets.discovery.found.keys()) killTree(pid, false);
    gracefulSurvivors = await waitForStopPids(
      gracefulTargets.discovery.found.keys(),
      isAlive,
      sleep,
      { timeoutMs: 4_000 },
    );
  }

  // Wrappers can exit before their listener children or respawn a child during
  // graceful shutdown. Discover from fresh state/ports before escalation.
  const targets = discover();
  assertSourceRuntimeStopIsSafe(targets);
  const forceTargets = new Map(targets.discovery.found);
  for (const [pid, label] of revalidateSourceRuntimeStopSurvivors(
    gracefulTargets,
    gracefulSurvivors,
    deps,
  )) forceTargets.set(pid, label);
  if (forceTargets.size > 0) {
    for (const pid of forceTargets.keys()) killTree(pid, true);
    await waitForStopPids(forceTargets.keys(), isAlive, sleep, { timeoutMs: 2_000 });
  }

  const finalTargets = discover();
  assertSourceRuntimeStopIsSafe(finalTargets);
  if (!canFinalizeStop(finalTargets.scope, finalTargets.discovery, deps)) {
    throw new Error('failed to stop the existing local runtime: owned process or port survived');
  }
  const cleanup = await cleanupStopArtifacts(instance, {
    clearPidfiles,
    canFinalize: () => canFinalizeStop(finalTargets.scope, finalTargets.discovery, deps),
  });
  if (!cleanup.ok) {
    throw new Error(`failed to finalize existing local runtime: ${
      cleanup.error instanceof Error ? cleanup.error.message : String(cleanup.error)
    }`);
  }
}

function assertSourceRuntimeStopIsSafe(targets: SourceRuntimeStopTargets): void {
  if (!targets.discovery.blocked && !targets.scope.lockConflict) return;
  const refusals = targets.discovery.refusals
    .map(({ pid, source, reason }) => `${source} pid=${pid} ${reason}`)
    .join('; ');
  throw new Error(`refusing to stop runtime with unproven ownership${refusals ? `: ${refusals}` : ''}`);
}

export function openRuntimeLog(path: string): number {
  mkdirSync(dirname(path), { recursive: true });
  rotateLog(path);
  return openSync(path, 'w');
}

function rotateLog(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(path, resolve(dirname(path), `forgeax-stack-${stamp}.log`));
}

function tailLog(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(log unavailable)';
  }
}

function streamNewLog(path: string, cursor: { offset: number; partialLine: boolean }): void {
  try {
    const contents = readFileSync(path, 'utf8');
    if (contents.length < cursor.offset) cursor.offset = 0;
    const chunk = contents.slice(cursor.offset);
    cursor.offset = contents.length;
    if (!chunk) return;
    process.stdout.write(chunk);
    cursor.partialLine = !chunk.endsWith('\n');
  } catch {
    // The detached launcher may not have created the log file yet.
  }
}
