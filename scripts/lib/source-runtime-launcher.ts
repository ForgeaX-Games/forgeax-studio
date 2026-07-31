import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadDotenv } from './env.ts';
import {
  isAlive,
  killTree,
  listenPids,
  spawnService,
} from './proc.ts';
import {
  readinessSummary,
  waitForRuntime,
} from './runtime-readiness.ts';
import { readRuntimeState } from './runtime-state.ts';
import {
  resolveStartupEnvironment,
  startupProcessEnv,
  type StartupEnvironment,
  type StartupProfile,
} from './startup-environment.ts';

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

export async function startSourceRuntime(
  options: StartSourceRuntimeOptions,
): Promise<StartedSourceRuntime> {
  const root = resolve(options.root);
  const env = options.env ?? process.env;
  loadDotenv(env.FORGEAX_ENV_FILE ?? join(root, '.env'));
  const startup = resolveStartupEnvironment({
    root,
    profile: options.profile,
    env,
  });
  const childEnv = startupProcessEnv(startup, env);
  Object.assign(env, childEnv);

  if (options.existing === 'restart') {
    stopSourceRuntime(root, childEnv);
  } else {
    const state = readRuntimeState(startup.stateFile);
    if (state && isAlive(state.launcherPid)) {
      if (options.existing === 'ensure') {
        const readiness = await waitForRuntime(startup, {
          launcherAlive: () => isAlive(state.launcherPid),
        });
        if (readiness.ready) {
          return { startup, launcherPid: state.launcherPid, reused: true };
        }
        stopSourceRuntime(root, childEnv);
      } else {
        throw new Error(
          `local runtime launcher is already running (pid ${state.launcherPid}); use \`bun fx restart\``,
        );
      }
    }
  }

  const busy = sourceRuntimePorts(startup)
    .map(([name, port]) => ({ name, port, pids: listenPids(port) }))
    .filter((entry) => entry.pids.length > 0);
  if (busy.length > 0) {
    if (options.existing === 'ensure') {
      // A healthy-looking set of ports without a live runtime state is not a
      // managed ForgeaX stack. Reap it before starting the one launcher.
      stopSourceRuntime(root, childEnv);
    } else {
      throw new Error(
        `dev stack ports are already occupied: ${busy
          .map(({ name, port, pids }) => `${name}=:${port} pid=${pids.join(',')}`)
          .join('; ')}`,
      );
    }
  }

  rotateLog(startup.logFile);
  const logFd = openSync(startup.logFile, 'w');
  const startupLogCursor = { offset: 0, partialLine: false };
  console.log(`[start] streaming startup logs from ${startup.logFile}`);
  const launcher = spawnService(
    'bun',
    [
      join(root, 'scripts', 'local-runtime.ts'),
      '--profile',
      startup.profile,
      ...(options.runArgs ?? []),
    ],
    {
      cwd: root,
      detach: true,
      logFd,
      env: childEnv,
    },
  );
  closeSync(logFd);
  const launcherPid = launcher.pid ?? 0;
  if (!launcherPid) throw new Error('local runtime launcher did not return a pid');

  const readiness = await waitForRuntime(startup, {
    launcherAlive: () => isAlive(launcherPid),
    onCheck: () => streamNewLog(startup.logFile, startupLogCursor),
  });
  streamNewLog(startup.logFile, startupLogCursor);
  if (startupLogCursor.partialLine) process.stdout.write('\n');
  if (!readiness.ready) {
    if (isAlive(launcherPid)) killTree(launcherPid, true);
    throw new Error(
      `local runtime failed readiness: ${readinessSummary(readiness)}\n`
      + `last lines of ${startup.logFile}:\n${tailLog(startup.logFile, 40)}`,
    );
  }

  return {
    startup,
    launcherPid,
    reused: false,
  };
}

export function sourceRuntimePorts(
  startup: StartupEnvironment,
): ReadonlyArray<readonly [name: string, port: number]> {
  const ports: Array<readonly [string, number]> = [
    ['server', startup.server.port],
    ['interface', startup.interface.port],
    ['engine', startup.engine.port],
  ];
  return ports;
}

function stopSourceRuntime(root: string, env: NodeJS.ProcessEnv): void {
  const stopped = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'stop.ts'), '--force'],
    {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if ((stopped.status ?? 1) !== 0) {
    throw new Error(`failed to stop the existing local runtime (exit ${stopped.status ?? 'unknown'})`);
  }
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

function streamNewLog(
  path: string,
  cursor: { offset: number; partialLine: boolean },
): void {
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
