import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readDotenv } from './env.ts';
import { isAlive, killTree, listenPids, spawnService } from './proc.ts';
import { readinessSummary, waitForRuntime } from './runtime-readiness.ts';
import {
  readRuntimeState,
  runtimeStateBelongsToInstance,
  type RuntimeOwnerIdentity,
  type RuntimeState,
} from './runtime-state.ts';
import { resolveRuntimeInstance, runtimeInstanceProcessEnv, type RuntimeInstance } from './runtime-instance.ts';
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
import { resolveActiveServerRole } from './server-role.ts';

export type ExistingRuntimePolicy = 'error' | 'ensure' | 'restart';

interface StartSourceRuntimeOptions {
  readonly root: string;
  readonly profile: Exclude<StartupProfile, 'desktop-prod'>;
  readonly existing: ExistingRuntimePolicy;
  readonly runArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
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
    interface: { dir: join(root, 'packages', childEnv.STUDIO === undefined || childEnv.STUDIO === '1' ? 'studio' : 'interface') },
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
    stopSourceRuntime(root, childEnv);
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
            return { startup, launcherPid: state.launcherPid, reused: true };
          }
        }
        stopSourceRuntime(root, childEnv);
      } else {
        throw new Error(`local runtime launcher is already running (pid ${state.launcherPid}); use \`bun fx restart\``);
      }
    }
  }

  const initiallyBusy = occupiedSourceRuntimePorts(startup);
  if (initiallyBusy.length > 0) {
    if (options.existing === 'ensure') stopSourceRuntime(root, childEnv);
    else throw new Error(formatBusyPorts(initiallyBusy));
  }

  const lock = new StartLock(root);
  lock.acquireOrThrow();
  let launcherPid = 0;
  try {
    // Re-read the complete RuntimeInstance after acquiring the same lock used
    // by `instance init`; all port preflight and child projection below are now
    // one atomic startup transaction.
    ({ startup, childEnv } = resolveSourceRuntimeEnvironment(root, options.profile, suppliedEnv));

    const busy = occupiedSourceRuntimePorts(startup);
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
}

async function waitForLauncherExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function occupiedSourceRuntimePorts(startup: StartupEnvironment) {
  return sourceRuntimePorts(startup)
    .map(([name, port]) => ({ name, port, pids: listenPids(port) }))
    .filter((entry) => entry.pids.length > 0);
}

function formatBusyPorts(busy: ReadonlyArray<{ name: string; port: number; pids: readonly number[] }>): string {
  return `dev stack ports are already occupied: ${busy
    .map(({ name, port, pids }) => `${name}=:${port} pid=${pids.join(',')}`)
    .join('; ')}`;
}

export function sourceRuntimePorts(startup: StartupEnvironment): ReadonlyArray<readonly [name: string, port: number]> {
  const ports: Array<readonly [string, number]> = [
    ['server', startup.server.port],
    ['interface', startup.interface.port],
    ['engine', startup.engine.port],
  ];
  return ports;
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

function stopSourceRuntime(root: string, env: NodeJS.ProcessEnv): void {
  const stopped = spawnSync(process.execPath, [join(root, 'scripts', 'stop.ts'), '--force'], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if ((stopped.status ?? 1) !== 0) {
    throw new Error(`failed to stop the existing local runtime (exit ${stopped.status ?? 'unknown'})`);
  }
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
