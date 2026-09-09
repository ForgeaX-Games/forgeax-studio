import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const RUNTIME_INSTANCE_SCHEMA_VERSION = 1 as const;
export const RUNTIME_INSTANCE_SLOTS = [0, 1, 2, 3, 4] as const;

const PORT_OFFSET = 10_000;
const CONFIG_RELATIVE_PATH = join('.forgeax', 'runtime', 'instance.json');
const MANIFEST_RELATIVE_PATH = join('.forgeax', 'runtime', 'manifest.json');
export const RUNTIME_INSTANCE_MANIFEST_SCHEMA = 'forgeax-runtime-instance/v1' as const;

export interface RuntimeInstanceConfig {
  readonly schemaVersion: typeof RUNTIME_INSTANCE_SCHEMA_VERSION;
  readonly id: string;
  readonly slot: number;
  readonly isolateUser: boolean;
  /** A path only. Credentials are deliberately never read or persisted here. */
  readonly envFile?: string;
}

export interface RuntimeInstancePorts {
  readonly server: number;
  readonly interface: number;
  readonly engine: number;
  readonly reel: number;
  readonly rhiReviewer: number;
  readonly bridge: number;
  readonly narrative: number;
  readonly faceMask: number;
}

export interface RuntimeInstance {
  readonly schemaVersion: typeof RUNTIME_INSTANCE_SCHEMA_VERSION;
  readonly root: string;
  readonly configFile: string;
  readonly manifestFile: string;
  readonly config: RuntimeInstanceConfig | null;
  readonly id: string;
  readonly slot: number;
  readonly isolateUser: boolean;
  readonly envFile: string;
  readonly projectRoot: string;
  readonly runtimeDir: string;
  readonly stateFile: string;
  readonly logFile: string;
  readonly agentHostSocket: string;
  readonly userDir?: string;
  readonly ports: RuntimeInstancePorts;
  readonly pluginPortOffset: number;
  readonly interfaceOrigin: string;
  readonly reelUrl: string;
  readonly assetCorsOrigins: readonly string[];
  readonly manifest: RuntimeInstanceManifest;
}

export interface RuntimeInstanceManifest {
  readonly schema: typeof RUNTIME_INSTANCE_MANIFEST_SCHEMA;
  readonly instanceId: string;
  readonly root: string;
  readonly slot: number;
  readonly endpoints: {
    readonly server: { readonly port: number; readonly url: string; readonly healthPath: '/api/health' };
    readonly interface: { readonly port: number; readonly origin: string; readonly healthPath: '/' };
    readonly engine: { readonly port: number; readonly url: string; readonly healthPath: '/preview/' };
  };
  readonly ports: RuntimeInstancePorts;
  readonly pluginPortOffset: number;
  readonly paths: { readonly stateFile: string; readonly logFile: string };
}

export interface ResolveRuntimeInstanceOptions {
  readonly root: string;
}

export interface WriteRuntimeInstanceOptions {
  readonly root: string;
  readonly slot: number;
  readonly isolateUser?: boolean;
  readonly envFile?: string;
  readonly force?: boolean;
}

/** Resolves the sole source-runtime instance contract for one checkout. */
export function resolveRuntimeInstance(options: ResolveRuntimeInstanceOptions): RuntimeInstance {
  const root = realpathSync(resolve(options.root));
  const configFile = runtimeInstanceConfigPath(root);
  const config = existsSync(configFile) ? readRuntimeInstanceConfig(configFile) : null;
  if (config !== null && config.id !== runtimeInstanceId(root)) {
    throw new Error(
      `runtime instance config '${configFile}' has id '${config.id}' but this worktree resolves to '${runtimeInstanceId(root)}'`,
    );
  }
  const slot = config?.slot ?? 0;
  const ports = deriveRuntimeInstancePorts(slot);
  const runtimeDir = join(root, '.forgeax', 'runtime');
  const id = config?.id ?? runtimeInstanceId(root);
  const interfaceOrigin = `http://127.0.0.1:${ports.interface}`;
  const instance = {
    schemaVersion: RUNTIME_INSTANCE_SCHEMA_VERSION,
    root,
    configFile,
    manifestFile: runtimeInstanceManifestPath(root),
    config,
    id,
    slot,
    isolateUser: config?.isolateUser ?? false,
    envFile: config?.envFile ?? join(root, '.env'),
    projectRoot: root,
    runtimeDir,
    stateFile: join(runtimeDir, 'web-dev.json'),
    logFile: join(runtimeDir, 'stack.log'),
    // unix-domain sockets have a small sockaddr_un path limit (notably on
    // macOS). The server port already uniquely derives from slot, so this
    // short user-local path remains instance-isolated without a second SSOT.
    agentHostSocket: runtimeInstanceAgentHostSocket(ports.server),
    ...(config?.isolateUser ? { userDir: join(root, '.forgeax', 'user') } : {}),
    ports,
    pluginPortOffset: slot * PORT_OFFSET,
    interfaceOrigin,
    reelUrl: `http://127.0.0.1:${ports.reel}`,
    assetCorsOrigins: corsOrigins(ports.interface),
  } satisfies Omit<RuntimeInstance, 'manifest'>;
  return { ...instance, manifest: buildRuntimeInstanceManifest(instance) };
}

export function runtimeInstanceId(root: string): string {
  const canonicalRoot = realpathSync(resolve(root));
  const name = basename(canonicalRoot);
  if (!name || name === '.' || name === '/') throw new Error(`cannot derive runtime instance id from '${root}'`);
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
  return `${name}-${digest}`;
}

export function runtimeInstanceConfigPath(root: string): string {
  return join(realpathSync(resolve(root)), CONFIG_RELATIVE_PATH);
}

export function runtimeInstanceManifestPath(root: string): string {
  return join(realpathSync(resolve(root)), MANIFEST_RELATIVE_PATH);
}

export function buildRuntimeInstanceManifest(
  instance: Omit<RuntimeInstance, 'manifest'>,
): RuntimeInstanceManifest {
  return {
    schema: RUNTIME_INSTANCE_MANIFEST_SCHEMA,
    instanceId: instance.id,
    root: instance.root,
    slot: instance.slot,
    endpoints: {
      server: { port: instance.ports.server, url: `http://127.0.0.1:${instance.ports.server}`, healthPath: '/api/health' },
      interface: { port: instance.ports.interface, origin: `http://localhost:${instance.ports.interface}`, healthPath: '/' },
      engine: { port: instance.ports.engine, url: `http://127.0.0.1:${instance.ports.engine}`, healthPath: '/preview/' },
    },
    ports: { ...instance.ports },
    pluginPortOffset: instance.pluginPortOffset,
    paths: { stateFile: instance.stateFile, logFile: instance.logFile },
  };
}

export function validateRuntimeInstanceManifest(
  raw: unknown,
  source = 'runtime instance manifest',
): RuntimeInstanceManifest {
  if (!isRecord(raw)) throw new Error(`${source} must be a JSON object`);
  assertExactKeys(raw, ['schema', 'instanceId', 'root', 'slot', 'endpoints', 'ports', 'pluginPortOffset', 'paths'], source);
  if (raw.schema !== RUNTIME_INSTANCE_MANIFEST_SCHEMA) throw new Error(`${source} has unsupported schema '${String(raw.schema)}'`);
  if (typeof raw.instanceId !== 'string' || raw.instanceId.trim() === '') throw new Error(`${source}.instanceId must be a non-empty string`);
  if (typeof raw.root !== 'string' || !isAbsolute(raw.root)) throw new Error(`${source}.root must be an absolute path`);
  if (!Number.isInteger(raw.slot)) throw new Error(`${source}.slot must be an integer`);
  validateSlot(raw.slot as number);
  if (!isRecord(raw.ports)) throw new Error(`${source}.ports must be an object`);
  assertExactKeys(raw.ports, ['server', 'interface', 'engine', 'reel', 'rhiReviewer', 'bridge', 'narrative', 'faceMask'], `${source}.ports`);
  const ports = raw.ports as unknown as RuntimeInstancePorts;
  for (const [name, port] of Object.entries(ports)) validateManifestPort(port, `${source}.ports.${name}`);
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new Error(`${source}.ports must be unique`);
  if (!Number.isSafeInteger(raw.pluginPortOffset) || (raw.pluginPortOffset as number) < 0) throw new Error(`${source}.pluginPortOffset must be a non-negative integer`);
  if (!isRecord(raw.endpoints)) throw new Error(`${source}.endpoints must be an object`);
  assertExactKeys(raw.endpoints, ['server', 'interface', 'engine'], `${source}.endpoints`);
  const expectedEndpoints = {
    server: { port: ports.server, url: `http://127.0.0.1:${ports.server}`, healthPath: '/api/health' },
    interface: { port: ports.interface, origin: `http://localhost:${ports.interface}`, healthPath: '/' },
    engine: { port: ports.engine, url: `http://127.0.0.1:${ports.engine}`, healthPath: '/preview/' },
  };
  if (JSON.stringify(raw.endpoints) !== JSON.stringify(expectedEndpoints)) throw new Error(`${source}.endpoints must match the declared ports`);
  if (!isRecord(raw.paths)) throw new Error(`${source}.paths must be an object`);
  assertExactKeys(raw.paths, ['stateFile', 'logFile'], `${source}.paths`);
  for (const name of ['stateFile', 'logFile'] as const) {
    if (typeof raw.paths[name] !== 'string' || !isAbsolute(raw.paths[name] as string)) throw new Error(`${source}.paths.${name} must be an absolute path`);
  }
  return raw as unknown as RuntimeInstanceManifest;
}

export function readRuntimeInstanceManifest(file: string): RuntimeInstanceManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid runtime instance manifest '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRuntimeInstanceManifest(raw, file);
}

export function writeRuntimeInstanceManifest(instance: RuntimeInstance): RuntimeInstanceManifest {
  const manifest = validateRuntimeInstanceManifest(instance.manifest);
  atomicWrite(instance.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, true);
  return manifest;
}

export function runtimeInstanceAgentHostSocket(serverPort: number): string {
  return join(homedir(), '.forgeax', `agent-host-${serverPort}.sock`);
}

export function deriveRuntimeInstancePorts(slot: number): RuntimeInstancePorts {
  validateSlot(slot);
  const offset = slot * PORT_OFFSET;
  const ports = {
    server: 18_900 + offset,
    interface: 18_920 + offset,
    engine: 15_173 + offset,
    reel: 15_175 + offset,
    rhiReviewer: 15_274 + offset,
    bridge: 15_295 + offset,
    narrative: slot === 0 ? 8_900 : 18_900 + offset + 30,
    faceMask: slot === 0 ? 18_930 : 18_900 + offset + 31,
  } as const;
  const values = Object.values(ports);
  if (values.some((port) => port < 1 || port > 65_535)) {
    throw new Error(`runtime instance slot ${slot} derives a port outside 1..65535`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`runtime instance slot ${slot} derives colliding ports`);
  }
  return ports;
}

export function readRuntimeInstanceConfig(configFile: string): RuntimeInstanceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`invalid runtime instance config '${configFile}': ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRuntimeInstanceConfig(raw, configFile);
}

export function validateRuntimeInstanceConfig(raw: unknown, source = 'runtime instance config'): RuntimeInstanceConfig {
  if (!isRecord(raw)) throw new Error(`${source} must be a JSON object`);
  const allowed = new Set(['schemaVersion', 'id', 'slot', 'isolateUser', 'envFile']);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${source} has unknown key(s): ${unknown.join(', ')}`);
  if (raw.schemaVersion !== RUNTIME_INSTANCE_SCHEMA_VERSION) {
    throw new Error(`${source} has unsupported schemaVersion '${String(raw.schemaVersion)}'; expected ${RUNTIME_INSTANCE_SCHEMA_VERSION}`);
  }
  if (typeof raw.id !== 'string' || raw.id.trim() === '') throw new Error(`${source}.id must be a non-empty string`);
  if (!Number.isInteger(raw.slot)) throw new Error(`${source}.slot must be an integer`);
  validateSlot(raw.slot);
  if (typeof raw.isolateUser !== 'boolean') throw new Error(`${source}.isolateUser must be a boolean`);
  if (raw.envFile !== undefined && (typeof raw.envFile !== 'string' || raw.envFile.trim() === '')) {
    throw new Error(`${source}.envFile must be a non-empty absolute path when present`);
  }
  if (typeof raw.envFile === 'string' && !isAbsolute(raw.envFile)) {
    throw new Error(`${source}.envFile must be an absolute path when present`);
  }
  return raw as RuntimeInstanceConfig;
}

export function writeRuntimeInstanceConfig(options: WriteRuntimeInstanceOptions): RuntimeInstanceConfig {
  const root = realpathSync(resolve(options.root));
  validateSlot(options.slot);
  const configFile = runtimeInstanceConfigPath(root);
  const envFile = options.envFile === undefined ? undefined : resolve(options.envFile);
  const config: RuntimeInstanceConfig = {
    schemaVersion: RUNTIME_INSTANCE_SCHEMA_VERSION,
    id: runtimeInstanceId(root),
    slot: options.slot,
    isolateUser: options.isolateUser ?? false,
    ...(envFile === undefined ? {} : { envFile }),
  };
  validateRuntimeInstanceConfig(config);
  atomicWrite(configFile, `${JSON.stringify(config, null, 2)}\n`, options.force ?? false);
  writeRuntimeInstanceManifest(resolveRuntimeInstance({ root }));
  return config;
}

/** Projection used by lifecycle launchers; no secret values are materialized. */
export function runtimeInstanceProcessEnv(instance: RuntimeInstance): NodeJS.ProcessEnv {
  return {
    FORGEAX_PROJECT_ROOT: instance.projectRoot,
    FORGEAX_ENV_FILE: instance.envFile,
    FORGEAX_RUNTIME_STATE_FILE: instance.stateFile,
    FORGEAX_RUNTIME_LOG_FILE: instance.logFile,
    FORGEAX_RUNTIME_MANIFEST_FILE: instance.manifestFile,
    FORGEAX_AGENT_HOST_SOCK: instance.agentHostSocket,
    FORGEAX_SERVER_PORT: String(instance.ports.server),
    FORGEAX_INTERFACE_PORT: String(instance.ports.interface),
    FORGEAX_ENGINE_PORT: String(instance.ports.engine),
    FORGEAX_REEL_URL: instance.reelUrl,
    FORGEAX_RHI_REVIEWER_PORT: String(instance.ports.rhiReviewer),
    FORGEAX_BRIDGE_PORT: String(instance.ports.bridge),
    NARRATIVE_PORT: String(instance.ports.narrative),
    FACE_MASK_PORT: String(instance.ports.faceMask),
    FORGEAX_PLUGIN_PORT_OFFSET: String(instance.pluginPortOffset),
    FORGEAX_ASSET_CORS_ORIGINS: instance.assetCorsOrigins.join(','),
    ...(instance.userDir === undefined ? {} : { FORGEAX_USER_DIR: instance.userDir }),
  };
}

function validateSlot(slot: number): void {
  if (!Number.isInteger(slot) || !RUNTIME_INSTANCE_SLOTS.includes(slot as 0 | 1 | 2 | 3 | 4)) {
    throw new Error(`runtime instance slot must be one of ${RUNTIME_INSTANCE_SLOTS.join(', ')}, got '${slot}'`);
  }
}

function atomicWrite(file: string, contents: string, force: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (force) {
      renameSync(temporary, file);
    } else {
      try {
        // link(2) publishes only if the final path does not exist, closing
        // the existsSync/rename race between concurrent `instance init`s.
        linkSync(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`runtime instance config already exists at '${file}'; pass --force to replace it`);
        }
        throw error;
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], source: string): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${source} keys mismatch; missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'}`);
  }
}

function validateManifestPort(value: unknown, source: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }
}

function corsOrigins(port: number): readonly string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
  ];
}
