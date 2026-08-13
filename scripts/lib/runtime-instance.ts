import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const RUNTIME_INSTANCE_SCHEMA_VERSION = 1 as const;
export const RUNTIME_INSTANCE_SLOTS = [0, 1, 2, 3, 4] as const;

const PORT_OFFSET = 10_000;
const CONFIG_RELATIVE_PATH = join('.forgeax', 'runtime', 'instance.json');

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

  return {
    schemaVersion: RUNTIME_INSTANCE_SCHEMA_VERSION,
    root,
    configFile,
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
  };
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
  return config;
}

/** Projection used by lifecycle launchers; no secret values are materialized. */
export function runtimeInstanceProcessEnv(instance: RuntimeInstance): NodeJS.ProcessEnv {
  return {
    FORGEAX_PROJECT_ROOT: instance.projectRoot,
    FORGEAX_ENV_FILE: instance.envFile,
    FORGEAX_RUNTIME_STATE_FILE: instance.stateFile,
    FORGEAX_RUNTIME_LOG_FILE: instance.logFile,
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

function corsOrigins(port: number): readonly string[] {
  return [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
  ];
}
