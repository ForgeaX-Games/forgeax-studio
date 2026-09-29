import { join, resolve } from 'node:path';

export const STARTUP_PROFILES = [
  'web-dev',
  'desktop-dev',
  'anydev-web',
] as const;

export type StartupProfile = (typeof STARTUP_PROFILES)[number];
export type UiRuntime = 'vite';
export type RestartPolicy = 'fail-fast' | 'bounded';

export interface StartupEndpoint {
  readonly host: string;
  readonly port: number;
  readonly healthPath: string;
}

export interface StartupEnvironment {
  readonly schemaVersion: 1;
  readonly profile: StartupProfile;
  readonly sourceLayout: 'source';
  readonly resourceRoot: string;
  readonly projectRoot: string;
  readonly envFile: string;
  readonly stateFile: string;
  readonly logFile: string;
  readonly server: StartupEndpoint;
  readonly engine: StartupEndpoint;
  readonly mcp: StartupEndpoint & {
    readonly enabled: boolean;
    readonly publicPath: string;
  };
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
  /** Source-runtime-only ports and URLs projected from the current instance. */
  readonly optional: {
    readonly narrativePort: number;
    readonly faceMaskPort: number;
    readonly rhiReviewerPort: number;
    readonly reelUrl: string;
    readonly pluginPortOffset: number;
  };
  /** The actual UI origin plus every loopback spelling accepted by Play assets. */
  readonly assetCorsOrigins: readonly string[];
  /** Explicit override wins; source defaults remain scoped to the project runtime. */
  readonly agentHostSocket: string;
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
}

const SOURCE_SERVER_PORT = 18900;
const SOURCE_INTERFACE_PORT = 18920;
const SOURCE_ENGINE_PORT = 15173;
const SOURCE_MCP_PORT = 18940;

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
  // assetRoot() is anchored at the `packages/` layout in source mode. Keep
  // the project root separate: it owns writable `.forgeax/` state, while the
  // resource root owns read-only editor templates, interface assets, and
  // marketplace extensions. Passing the repo root here makes game creation
  // look under `<repo>/games` and fail with "game template not found" even
  // though the engine-owned template exists under `<repo>/packages/editor`.
  const resourceRoot = resolve(root, 'packages');
  const projectRoot = resolve(env.FORGEAX_PROJECT_ROOT ?? root);
  const envFile = resolve(env.FORGEAX_ENV_FILE ?? join(projectRoot, '.env'));

  const serverPort = port(env.FORGEAX_SERVER_PORT, SOURCE_SERVER_PORT, 'FORGEAX_SERVER_PORT');
  const enginePort = port(env.FORGEAX_ENGINE_PORT, SOURCE_ENGINE_PORT, 'FORGEAX_ENGINE_PORT');
  const interfacePort = port(env.FORGEAX_INTERFACE_PORT, SOURCE_INTERFACE_PORT, 'FORGEAX_INTERFACE_PORT');
  const bridgeEnabled = env.FORGEAX_BRIDGE === '1';
  const bridgePort = port(env.FORGEAX_BRIDGE_PORT ?? env.FORGEAX_BRIDGE_CONFIG_PORT, 15295, env.FORGEAX_BRIDGE_PORT === undefined ? 'FORGEAX_BRIDGE_CONFIG_PORT' : 'FORGEAX_BRIDGE_PORT');
  const mcpEnabled = env.FORGEAX_MCP_HTTP === '1';
  const mcpPort = port(env.FORGEAX_MCP_PORT, SOURCE_MCP_PORT, 'FORGEAX_MCP_PORT');

  if (new Set([serverPort, enginePort, interfacePort]).size !== 3) {
    throw new Error(
      `startup profile '${profile}' resolves colliding core ports: server=${serverPort}, interface=${interfacePort}, engine=${enginePort}`,
    );
  }
  if (bridgeEnabled && [serverPort, interfacePort, enginePort].includes(bridgePort)) {
    throw new Error(
      `startup profile '${profile}' resolves gateway bridge :${bridgePort} onto a core service port`,
    );
  }

  const protocol = env.FORGEAX_INTERFACE_HTTPS === '1' ? 'https' : 'http';
  const localOrigin = `${protocol}://127.0.0.1:${interfacePort}`;
  const publicOrigin = env.FORGEAX_PUBLIC_ORIGIN?.trim() || localOrigin;
  const optional = {
    narrativePort: port(env.NARRATIVE_PORT, 8900, 'NARRATIVE_PORT'),
    faceMaskPort: port(env.FACE_MASK_PORT, 18930, 'FACE_MASK_PORT'),
    rhiReviewerPort: port(env.FORGEAX_RHI_REVIEWER_PORT, 15274, 'FORGEAX_RHI_REVIEWER_PORT'),
    reelUrl: env.FORGEAX_REEL_URL?.trim() || 'http://127.0.0.1:15175',
    pluginPortOffset: nonNegativeInteger(env.FORGEAX_PLUGIN_PORT_OFFSET, 0, 'FORGEAX_PLUGIN_PORT_OFFSET'),
  };
  const managedPorts: ReadonlyArray<readonly [name: string, port: number]> = [
    ['server', serverPort],
    ['interface', interfacePort],
    ['engine', enginePort],
    ...(mcpEnabled ? [['engine-mcp', mcpPort] as const] : []),
    ...(bridgeEnabled ? [['bridge', bridgePort] as const] : []),
    ['narrative', optional.narrativePort],
    ['face-mask', optional.faceMaskPort],
    ['rhi-reviewer', optional.rhiReviewerPort],
  ];
  const duplicates = managedPorts.filter((entry, index) =>
    managedPorts.findIndex((candidate) => candidate[1] === entry[1]) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `startup profile '${profile}' resolves colliding managed ports: ${managedPorts
        .filter((entry) => duplicates.some((duplicate) => duplicate[1] === entry[1]))
        .map(([name, port]) => `${name}=${port}`)
        .join(', ')}`,
    );
  }
  const stateFile = resolve(
    env.FORGEAX_RUNTIME_STATE_FILE
      ?? join(projectRoot, '.forgeax', 'runtime', `${profile}.json`),
  );
  const logFile = resolve(
    env.FORGEAX_RUNTIME_LOG_FILE
      ?? join(projectRoot, '.forgeax', 'runtime', 'stack.log'),
  );

  return {
    schemaVersion: 1,
    profile,
    sourceLayout: 'source',
    resourceRoot,
    projectRoot,
    envFile,
    stateFile,
    logFile,
    server: {
      host: env.FORGEAX_SERVER_HOST ?? '0.0.0.0',
      port: serverPort,
      healthPath: '/api/health',
    },
    engine: {
      host: env.FORGEAX_ENGINE_HOST ?? '0.0.0.0',
      port: enginePort,
      healthPath: '/preview/',
    },
    mcp: {
      enabled: mcpEnabled,
      host: '127.0.0.1',
      port: mcpPort,
      healthPath: '/healthz',
      publicPath: '/engine/mcp',
    },
    gatewayBridge: {
      enabled: bridgeEnabled,
      host: '127.0.0.1',
      port: bridgePort,
    },
    interface: {
      runtime: 'vite',
      host: '0.0.0.0',
      port: interfacePort,
      protocol,
      healthPath: '/api/health',
      localOrigin,
      publicOrigin,
    },
    hmrClientPort: port(
      env.FORGEAX_HMR_CLIENT_PORT,
      interfacePort,
      'FORGEAX_HMR_CLIENT_PORT',
    ),
    optional,
    assetCorsOrigins: assetCorsOrigins(interfacePort, publicOrigin),
    agentHostSocket: resolve(env.FORGEAX_AGENT_HOST_SOCK ?? join(projectRoot, '.forgeax', 'runtime', 'agent-host.sock')),
    standaloneProxy: env.FORGEAX_STANDALONE_PROXY === '1',
    ...(env.FORGEAX_INTERFACE_ALLOWED_HOSTS === undefined
      ? {}
      : { allowedHosts: env.FORGEAX_INTERFACE_ALLOWED_HOSTS }),
    supervision: { restartPolicy: 'fail-fast', maxRestarts: 0 },
    startupTimeoutMs: positiveInteger(
      env.FORGEAX_STARTUP_TIMEOUT_MS,
      180_000,
      'FORGEAX_STARTUP_TIMEOUT_MS',
    ),
  };
}

export function startupProcessEnv(
  startup: StartupEnvironment,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
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
    ...(startup.mcp.enabled ? {
      FORGEAX_MCP_HTTP: '1',
      FORGEAX_MCP_HOST: startup.mcp.host,
      FORGEAX_MCP_PORT: String(startup.mcp.port),
      FORGEAX_MCP_URL: `http://127.0.0.1:${startup.mcp.port}`,
    } : {}),
    ...(startup.gatewayBridge.enabled
      ? { FORGEAX_BRIDGE: '1', FORGEAX_BRIDGE_PORT: String(startup.gatewayBridge.port), FORGEAX_EDITOR_RELAY_URL: `http://${startup.gatewayBridge.host}:${startup.gatewayBridge.port}` }
      : { FORGEAX_BRIDGE: '0' }),
    FORGEAX_INTERFACE_PORT: String(startup.interface.port),
    FORGEAX_HMR_CLIENT_PORT: String(startup.hmrClientPort),
    FORGEAX_BRIDGE_CONFIG_PORT: String(startup.gatewayBridge.port),
    NARRATIVE_PORT: String(startup.optional.narrativePort),
    FACE_MASK_PORT: String(startup.optional.faceMaskPort),
    FORGEAX_RHI_REVIEWER_PORT: String(startup.optional.rhiReviewerPort),
    FORGEAX_REEL_URL: startup.optional.reelUrl,
    FORGEAX_PLUGIN_PORT_OFFSET: String(startup.optional.pluginPortOffset),
    FORGEAX_ASSET_CORS_ORIGINS: startup.assetCorsOrigins.join(','),
    FORGEAX_AGENT_HOST_SOCK: startup.agentHostSocket,
    // Source startup readiness must describe the three core services, not an
    // optional project-MCP warmup whose browser server can take minutes to
    // enumerate. The first MCP turn discovers lazily; developers can opt
    // back into eager warmup with `=1`.
    FORGEAX_PROJECT_MCP_PREWARM: base.FORGEAX_PROJECT_MCP_PREWARM ?? '0',
    FORGEAX_SERVE_SPA: '0',
  };
  if (!startup.gatewayBridge.enabled) {
    delete childEnv.FORGEAX_BRIDGE_PORT;
    delete childEnv.FORGEAX_BRIDGE_URL;
    delete childEnv.FORGEAX_EDITOR_RELAY_URL;
  }
  return childEnv;
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

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a non-negative integer, got '${value}'`);
  const resolved = Number(value);
  if (!Number.isSafeInteger(resolved)) {
    throw new Error(`${name} must be a non-negative integer, got '${value}'`);
  }
  return resolved;
}

function assetCorsOrigins(interfacePort: number, publicOrigin: string): readonly string[] {
  return [...new Set([
    publicOrigin,
    `http://localhost:${interfacePort}`,
    `http://127.0.0.1:${interfacePort}`,
    `https://localhost:${interfacePort}`,
    `https://127.0.0.1:${interfacePort}`,
  ])];
}
