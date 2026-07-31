import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const STARTUP_PROFILES = [
  'web-dev',
  'desktop-dev',
  'anydev-web',
  'desktop-prod',
] as const;

export type StartupProfile = (typeof STARTUP_PROFILES)[number];
export type UiRuntime = 'vite' | 'server-spa';
export type RestartPolicy = 'fail-fast' | 'bounded';

export interface StartupEndpoint {
  readonly host: string;
  readonly port: number;
  readonly healthPath: string;
}

export interface StartupEnvironment {
  readonly schemaVersion: 1;
  readonly profile: StartupProfile;
  readonly sourceLayout: 'source' | 'bundled';
  readonly resourceRoot: string;
  readonly projectRoot: string;
  readonly envFile: string;
  readonly stateFile: string;
  readonly logFile: string;
  readonly server: StartupEndpoint;
  readonly engine: StartupEndpoint;
  readonly gatewayBridge: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
  };
  readonly interface: StartupEndpoint & {
    readonly runtime: UiRuntime;
    readonly protocol: 'http' | 'https';
    readonly localOrigin: string;
    readonly publicOrigin: string;
  };
  readonly hmrClientPort: number;
  readonly standaloneProxy: boolean;
  readonly allowedHosts?: string;
  readonly supervision: {
    readonly restartPolicy: RestartPolicy;
    readonly maxRestarts: number;
  };
  readonly startupTimeoutMs: number;
}

interface ResolveStartupEnvironmentOptions {
  readonly root: string;
  readonly profile?: StartupProfile | string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

const SOURCE_SERVER_PORT = 18900;
const SOURCE_INTERFACE_PORT = 18920;
const SOURCE_ENGINE_PORT = 15173;
const DESKTOP_SERVER_PORT = 18810;
const DESKTOP_ENGINE_PORT = 15273;

export function isStartupProfile(value: string | undefined): value is StartupProfile {
  return STARTUP_PROFILES.includes(value as StartupProfile);
}

export function resolveStartupEnvironment(options: ResolveStartupEnvironmentOptions): StartupEnvironment {
  const env = options.env ?? process.env;
  const profileValue = options.profile ?? env.FORGEAX_STARTUP_PROFILE ?? 'web-dev';
  if (!isStartupProfile(profileValue)) {
    throw new Error(
      `invalid FORGEAX_STARTUP_PROFILE '${profileValue}'; expected one of ${STARTUP_PROFILES.join(', ')}`,
    );
  }

  const profile = profileValue;
  const root = resolve(options.root);
  const home = resolve(options.homeDir ?? homedir());
  const bundled = profile === 'desktop-prod';
  // assetRoot() is anchored at the `packages/` layout in source mode. Keep
  // the project root separate: it owns writable `.forgeax/` state, while the
  // resource root owns read-only games, editor templates, interface assets,
  // and marketplace extensions. Passing the repo root here makes game
  // creation look under `<repo>/games` and fail with "game template not
  // found" even though `<repo>/packages/games` and the editor template exist.
  const resourceRoot = bundled
    ? resolve(env.FORGEAX_RESOURCE_ROOT ?? root)
    : resolve(root, 'packages');
  const projectRoot = bundled
    ? resolve(env.FORGEAX_PROJECT_ROOT ?? join(home, 'ForgeaxProjects'))
    : resolve(env.FORGEAX_PROJECT_ROOT ?? root);
  const envFile = resolve(env.FORGEAX_ENV_FILE ?? join(projectRoot, '.env'));

  const serverPort = bundled
    ? port(env.FORGEAX_DESKTOP_SERVER_PORT, DESKTOP_SERVER_PORT, 'FORGEAX_DESKTOP_SERVER_PORT')
    : port(env.FORGEAX_SERVER_PORT, SOURCE_SERVER_PORT, 'FORGEAX_SERVER_PORT');
  const enginePort = bundled
    ? port(env.FORGEAX_DESKTOP_ENGINE_PORT, DESKTOP_ENGINE_PORT, 'FORGEAX_DESKTOP_ENGINE_PORT')
    : port(env.FORGEAX_ENGINE_PORT, SOURCE_ENGINE_PORT, 'FORGEAX_ENGINE_PORT');
  const interfacePort = bundled
    ? serverPort
    : port(env.FORGEAX_INTERFACE_PORT, SOURCE_INTERFACE_PORT, 'FORGEAX_INTERFACE_PORT');
  const bridgeEnabled = !bundled && env.FORGEAX_BRIDGE !== '0';
  const bridgePort = port(env.FORGEAX_BRIDGE_PORT, 15295, 'FORGEAX_BRIDGE_PORT');

  if (serverPort === enginePort || (!bundled && new Set([serverPort, enginePort, interfacePort]).size !== 3)) {
    throw new Error(
      `startup profile '${profile}' resolves colliding core ports: server=${serverPort}, interface=${interfacePort}, engine=${enginePort}`,
    );
  }
  if (bridgeEnabled && [serverPort, interfacePort, enginePort].includes(bridgePort)) {
    throw new Error(
      `startup profile '${profile}' resolves gateway bridge :${bridgePort} onto a core service port`,
    );
  }

  const protocol = !bundled && env.FORGEAX_INTERFACE_HTTPS === '1' ? 'https' : 'http';
  const localOrigin = `${protocol}://127.0.0.1:${interfacePort}`;
  const stateFile = resolve(
    env.FORGEAX_RUNTIME_STATE_FILE
      ?? join(projectRoot, '.forgeax', 'runtime', `${profile}.json`),
  );
  const logFile = resolve(
    env.FORGEAX_RUNTIME_LOG_FILE
      ?? (bundled
        ? join(projectRoot, '.logs', 'local-runtime.log')
        : join(tmpdir(), 'forgeax-stack.log')),
  );

  return {
    schemaVersion: 1,
    profile,
    sourceLayout: bundled ? 'bundled' : 'source',
    resourceRoot,
    projectRoot,
    envFile,
    stateFile,
    logFile,
    server: {
      host: bundled ? '127.0.0.1' : (env.FORGEAX_SERVER_HOST ?? '0.0.0.0'),
      port: serverPort,
      healthPath: '/api/health',
    },
    engine: {
      host: bundled ? '127.0.0.1' : (env.FORGEAX_ENGINE_HOST ?? '0.0.0.0'),
      port: enginePort,
      healthPath: '/preview/',
    },
    gatewayBridge: {
      enabled: bridgeEnabled,
      host: '127.0.0.1',
      port: bridgePort,
    },
    interface: {
      runtime: bundled ? 'server-spa' : 'vite',
      host: bundled ? '127.0.0.1' : '0.0.0.0',
      port: interfacePort,
      protocol,
      healthPath: '/api/health',
      localOrigin,
      publicOrigin: bundled
        ? localOrigin
        : env.FORGEAX_PUBLIC_ORIGIN?.trim() || localOrigin,
    },
    hmrClientPort: port(
      env.FORGEAX_HMR_CLIENT_PORT,
      interfacePort,
      'FORGEAX_HMR_CLIENT_PORT',
    ),
    standaloneProxy: env.FORGEAX_STANDALONE_PROXY === '1',
    ...(env.FORGEAX_INTERFACE_ALLOWED_HOSTS === undefined
      ? {}
      : { allowedHosts: env.FORGEAX_INTERFACE_ALLOWED_HOSTS }),
    supervision: bundled
      ? { restartPolicy: 'bounded', maxRestarts: 5 }
      : { restartPolicy: 'fail-fast', maxRestarts: 0 },
    startupTimeoutMs: positiveInteger(
      env.FORGEAX_STARTUP_TIMEOUT_MS,
      bundled ? 60_000 : 180_000,
      'FORGEAX_STARTUP_TIMEOUT_MS',
    ),
  };
}

export function startupProcessEnv(
  startup: StartupEnvironment,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    FORGEAX_STARTUP_PROFILE: startup.profile,
    FORGEAX_RESOURCE_ROOT: startup.resourceRoot,
    FORGEAX_PROJECT_ROOT: startup.projectRoot,
    FORGEAX_ENV_FILE: startup.envFile,
    FORGEAX_RUNTIME_STATE_FILE: startup.stateFile,
    FORGEAX_RUNTIME_LOG_FILE: startup.logFile,
    FORGEAX_SERVER_HOST: startup.server.host,
    FORGEAX_SERVER_PORT: String(startup.server.port),
    FORGEAX_SERVER_URL: `http://127.0.0.1:${startup.server.port}`,
    FORGEAX_ENGINE_HOST: startup.engine.host,
    FORGEAX_ENGINE_PORT: String(startup.engine.port),
    FORGEAX_ENGINE_URL: `http://127.0.0.1:${startup.engine.port}`,
    FORGEAX_BRIDGE_PORT: String(startup.gatewayBridge.port),
    FORGEAX_INTERFACE_PORT: String(startup.interface.port),
    FORGEAX_HMR_CLIENT_PORT: String(startup.hmrClientPort),
    FORGEAX_SERVE_SPA: startup.interface.runtime === 'server-spa' ? '1' : '0',
  };
}

export function sanitizedStartupEnvironment(startup: StartupEnvironment): StartupEnvironment {
  return structuredClone(startup);
}

function port(value: string | undefined, fallback: number, name: string): number {
  const resolved = positiveInteger(value, fallback, name);
  if (resolved > 65_535) throw new Error(`${name} must be <= 65535, got ${resolved}`);
  return resolved;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer, got '${value}'`);
  const resolved = Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer, got '${value}'`);
  }
  return resolved;
}
