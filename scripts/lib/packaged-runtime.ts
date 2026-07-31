import {
  cpSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { materializePackagedEngineWorkspace } from './engine-workspace.ts';
import { readinessSummary, waitForRuntime } from './runtime-readiness.ts';
import { RuntimeStateStore } from './runtime-state.ts';
import { seedSharedGames } from './seed-games.ts';
import { ServiceSupervisor, type ServiceEvent } from './service-supervisor.ts';
import {
  startupProcessEnv,
  type StartupEnvironment,
} from './startup-environment.ts';

export async function runPackagedRuntime(startup: StartupEnvironment): Promise<never> {
  if (startup.profile !== 'desktop-prod' || startup.sourceLayout !== 'bundled') {
    throw new Error(`packaged runtime requires desktop-prod, got ${startup.profile}`);
  }
  const state = new RuntimeStateStore(startup);
  state.writeStarting();
  let supervisor: ServiceSupervisor | undefined;
  try {
    preparePackagedProject(startup);
    let fatal: (error: Error) => void = () => {};
    const fatalService = new Promise<Error>((resolve) => {
      fatal = resolve;
    });
    supervisor = new ServiceSupervisor({
      onEvent: (event) => {
        recordServiceEvent(state, event);
        emitRuntimeEvent(event);
      },
      onFatal: (error) => {
        state.markFailed(error.message);
        fatal(error);
      },
    });

    const shutdown = (exitCode: number): never => {
      state.markStopping();
      supervisor?.shutdown(exitCode !== 0);
      process.exit(exitCode);
    };
    process.once('SIGINT', () => shutdown(130));
    process.once('SIGTERM', () => shutdown(143));

    const baseEnv = startupProcessEnv(startup, {
      ...process.env,
      NODE_ENV: 'production',
    });
    const agentHostSocket = join(homedir(), '.forgeax', `agent-host-${startup.server.port}.sock`);
    const serverEntry = join(startup.resourceRoot, 'server', 'src', 'main.ts');
    if (!existsSync(serverEntry)) throw new Error(`packaged server entry is missing: ${serverEntry}`);
    supervisor.launch({
      name: 'server',
      command: process.execPath,
      args: ['run', serverEntry],
      spawn: {
        cwd: join(startup.resourceRoot, 'server'),
        env: {
          ...baseEnv,
          FORGEAX_AGENT_HOST_SOCK: agentHostSocket,
        },
      },
      required: true,
      restartPolicy: startup.supervision.restartPolicy,
      maxRestarts: startup.supervision.maxRestarts,
    });

    const engineWork = join(startup.projectRoot, '.engine-runtime');
    const engineEntry = join(engineWork, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!existsSync(engineEntry)) throw new Error(`packaged engine entry is missing: ${engineEntry}`);
    supervisor.launch({
      name: 'engine',
      command: process.execPath,
      args: ['run', engineEntry],
      spawn: {
        cwd: engineWork,
        env: {
          ...baseEnv,
          FORGEAX_INTERFACE_PORT: String(startup.interface.port),
          FORGEAX_PREVIEW_GAMES_DIR: join(engineWork, '.forgeax', 'games'),
          FORGEAX_GAMES_URL_PREFIX: '.forgeax/games',
        },
      },
      required: true,
      restartPolicy: startup.supervision.restartPolicy,
      maxRestarts: startup.supervision.maxRestarts,
    });

    const initial = await Promise.race([
      waitForRuntime(startup, {
        onCheck: (readiness) => state.setReadiness(readiness),
      }),
      fatalService,
    ]);
    if (initial instanceof Error) throw initial;
    if (!initial.ready) {
      const error = new Error(`local runtime failed readiness: ${readinessSummary(initial)}`);
      state.markFailed(error.message, initial);
      throw error;
    }

    state.markReady(initial);
    emitRuntimeEvent({
      name: 'runtime',
      status: 'running',
      pid: process.pid,
    });

    const terminal = await fatalService;
    supervisor.shutdown(true);
    throw terminal;
  } catch (error) {
    const resolved = error instanceof Error ? error : new Error(String(error));
    state.markFailed(resolved.message);
    supervisor?.shutdown(true);
    throw resolved;
  }
}

function preparePackagedProject(startup: StartupEnvironment): void {
  mkdirSync(startup.projectRoot, { recursive: true });
  const templateSource = join(startup.resourceRoot, 'game-template');
  const templateDestination = join(
    startup.projectRoot,
    '.forgeax',
    'games',
    '_template',
  );
  if (existsSync(templateSource) && !existsSync(templateDestination)) {
    mkdirSync(dirname(templateDestination), { recursive: true });
    cpSync(templateSource, templateDestination, {
      recursive: true,
      dereference: true,
      force: true,
    });
  }

  seedSharedGames({
    source: join(startup.resourceRoot, 'games'),
    destination: join(startup.projectRoot, '.forgeax', 'games'),
    log: (message) => console.log(`[local-runtime][games] ${message}`),
    warn: (message) => console.error(`[local-runtime][games] ${message}`),
  });
  materializePackagedEngineWorkspace(
    join(startup.resourceRoot, 'engine'),
    join(startup.projectRoot, '.engine-runtime'),
    startup.projectRoot,
  );
}

function recordServiceEvent(state: RuntimeStateStore, event: ServiceEvent): void {
  if (event.pid) state.setServicePid(event.name, event.pid);
  else if (event.status === 'failed' || event.status === 'stopped') state.setServicePid(event.name, 0);
}

function emitRuntimeEvent(event: ServiceEvent): void {
  console.log(`[forgeax-runtime] ${JSON.stringify(event)}`);
}
