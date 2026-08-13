import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import type { RuntimeInstance } from './runtime-instance.ts';
import type { RuntimeReadiness } from './runtime-readiness.ts';
import { isDeclaredServerRole } from './server-role.ts';
import {
  isStartupProfile,
  type StartupEnvironment,
  sanitizedStartupEnvironment,
} from './startup-environment.ts';

/**
 * Runtime state is deliberately versioned independently from StartupEnvironment.
 * A reader accepts exactly this version; state has no compatibility fallback.
 */
export const RUNTIME_STATE_SCHEMA_VERSION = 1 as const;

export type RuntimeStatus = 'starting' | 'ready' | 'failed' | 'stopping';
export type ManagedRuntimePorts = Readonly<Record<string, number>>;

/**
 * Exact source-process identities selected by the launcher.  These are
 * deliberately paths and entry names only: state must let a later stop prove
 * an orphan, but must never persist launch environment or credentials.
 */
export interface RuntimeOwnerIdentity {
  readonly server: {
    readonly packageDir: string;
    readonly entry: string;
  };
  readonly interface: {
    readonly dir: string;
  };
}

export interface RuntimeState {
  readonly schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  readonly profile: StartupEnvironment['profile'];
  readonly status: RuntimeStatus;
  readonly launcherPid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly publicOrigin: string;
  readonly startup: StartupEnvironment;
  readonly owners: RuntimeOwnerIdentity;
  /** Every listener that this Studio launcher owns, including extensions. */
  readonly managedPorts: ManagedRuntimePorts;
  readonly servicePids: Readonly<Record<string, number>>;
  readonly readiness?: RuntimeReadiness;
  readonly error?: string;
}

export class RuntimeStateStore {
  private readonly startedAt = new Date().toISOString();
  private status: RuntimeStatus = 'starting';
  private servicePids: Record<string, number> = {};
  private readiness?: RuntimeReadiness;
  private error?: string;
  private readonly managedPorts: ManagedRuntimePorts;

  constructor(
    private readonly startup: StartupEnvironment,
    private readonly launcherPid: number = process.pid,
    managedPorts: ManagedRuntimePorts = coreManagedPorts(startup),
    private readonly owners: RuntimeOwnerIdentity = defaultRuntimeOwnerIdentity(startup),
  ) {
    this.managedPorts = validatedManagedPorts(managedPorts);
    requireCoreManagedPorts(this.managedPorts, startup);
    if (!validRuntimeOwnerIdentity(this.owners)) throw new Error('owners must contain exact server and interface identities');
  }

  writeStarting(): RuntimeState {
    this.status = 'starting';
    return this.write();
  }

  setServicePid(name: string, pid: number): RuntimeState {
    if (pid > 0) this.servicePids[name] = pid;
    else delete this.servicePids[name];
    return this.write();
  }

  setReadiness(readiness: RuntimeReadiness): RuntimeState {
    this.readiness = readiness;
    return this.write();
  }

  markReady(readiness: RuntimeReadiness): RuntimeState {
    this.status = 'ready';
    this.readiness = readiness;
    this.error = undefined;
    return this.write();
  }

  markFailed(error: string, readiness?: RuntimeReadiness): RuntimeState {
    this.status = 'failed';
    this.error = error;
    if (readiness) this.readiness = readiness;
    return this.write();
  }

  markStopping(): RuntimeState {
    this.status = 'stopping';
    return this.write();
  }

  remove(): void {
    rmSync(this.startup.stateFile, { force: true });
  }

  private write(): RuntimeState {
    const state: RuntimeState = {
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      profile: this.startup.profile,
      status: this.status,
      launcherPid: this.launcherPid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      publicOrigin: this.startup.interface.publicOrigin,
      startup: sanitizedStartupEnvironment(this.startup),
      owners: cloneRuntimeOwnerIdentity(this.owners),
      managedPorts: { ...this.managedPorts },
      servicePids: { ...this.servicePids },
      ...(this.readiness ? { readiness: this.readiness } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
    mkdirSync(dirname(this.startup.stateFile), { recursive: true });
    const temporary = `${this.startup.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, this.startup.stateFile);
    return state;
  }
}

/**
 * Parses only the current, complete on-disk contract. Invalid, stale, or
 * future-version state is untrusted and therefore unavailable to consumers.
 */
export function readRuntimeState(path: string): RuntimeState | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRuntimeState(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The one ownership predicate for lifecycle consumers. A state document may
 * name arbitrary public origins (AnyDev can be remote) and an explicit HMR
 * proxy port, but every instance-derived source resource and CORS projection
 * must match this exact instance.
 */
export function runtimeStateBelongsToInstance(
  instance: RuntimeInstance,
  state: RuntimeState | null,
): state is RuntimeState {
  if (state === null || state.startup.sourceLayout !== 'source') return false;
  const { startup } = state;
  if (
    !sourceResourceRootBelongsToInstance(startup.resourceRoot, instance.root)
    || startup.projectRoot !== instance.projectRoot
    || startup.stateFile !== instance.stateFile
    || startup.envFile !== instance.envFile
    || startup.logFile !== instance.logFile
    || !runtimeOwnerIdentityBelongsToResourceRoot(startup.resourceRoot, state.owners)
  ) return false;

  if (
    startup.server.port !== instance.ports.server
    || startup.interface.port !== instance.ports.interface
    || startup.engine.port !== instance.ports.engine
    || startup.gatewayBridge.port !== instance.ports.bridge
    || startup.optional.narrativePort !== instance.ports.narrative
    || startup.optional.faceMaskPort !== instance.ports.faceMask
    || startup.optional.rhiReviewerPort !== instance.ports.rhiReviewer
    || startup.optional.reelUrl !== instance.reelUrl
    || startup.optional.pluginPortOffset !== instance.pluginPortOffset
  ) return false;

  // `publicOrigin` can be a remote AnyDev endpoint. It is still the sole
  // permitted non-instance entry in the asset CORS projection.
  if (!sameStringSet(
    startup.assetCorsOrigins,
    [...new Set([startup.interface.publicOrigin, ...instance.assetCorsOrigins])],
  )) return false;

  // `gatewayBridge` is configuration for an external peer. Its enabled flag
  // is meaningful and its port is instance-derived above, but it never turns
  // that peer into a Studio-managed listener.
  return coreManagedPortsMatch(state.managedPorts, startup)
    && (state.managedPorts.narrative === undefined
      || state.managedPorts.narrative === startup.optional.narrativePort)
    && (state.managedPorts['rhi-reviewer'] === undefined
      || state.managedPorts['rhi-reviewer'] === startup.optional.rhiReviewerPort);
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((value) => expected.includes(value));
}

function sourceResourceRootBelongsToInstance(resourceRoot: string, instanceRoot: string): boolean {
  // Canonicalize only the resource root's parent. This preserves the lexical
  // instance mount boundary while tolerating macOS `/var` aliases and letting
  // the package directory itself be a deliberate source mount.
  try {
    const resolvedResourceRoot = resolvePath(resourceRoot);
    return join(realpathSync(dirname(resolvedResourceRoot)), basename(resolvedResourceRoot))
      === join(resolvePath(instanceRoot), 'packages');
  } catch {
    return false;
  }
}

function canonicalSourceResourceRoot(resourceRoot: string): string | null {
  // Source resourceRoot is `<checkout>/packages`. The lexical instance-root
  // check in runtimeStateBelongsToInstance runs before this canonicalization;
  // once that binding is proven, resolve the package mount itself so a CI
  // workspace may symlink `packages/` to the source checkout without making
  // its declared owners look cross-instance.
  try {
    return realpathSync(resourceRoot);
  } catch {
    return null;
  }
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!isRecord(value) || value.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION) return false;
  const allowed = new Set([
    'schemaVersion', 'profile', 'status', 'launcherPid', 'startedAt', 'updatedAt',
    'publicOrigin', 'startup', 'owners', 'managedPorts', 'servicePids', 'readiness', 'error',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  const profile = stringValue(value.profile);
  if (!isStartupProfile(profile)) return false;
  if (
    !isRuntimeStatus(value.status)
    || !positiveInteger(value.launcherPid)
    || !validTimestamp(value.startedAt)
    || !validTimestamp(value.updatedAt)
    || typeof value.publicOrigin !== 'string'
    || value.publicOrigin.trim() === ''
    || !validStartup(value.startup, profile)
    || value.publicOrigin !== value.startup.interface.publicOrigin
    || !validRuntimeOwnerIdentity(value.owners)
    || !validManagedPorts(value.managedPorts, value.startup)
    || !validServicePids(value.servicePids)
    || (value.readiness !== undefined && !validReadiness(value.readiness))
    || (value.error !== undefined && typeof value.error !== 'string')
  ) return false;
  return true;
}

function defaultRuntimeOwnerIdentity(startup: StartupEnvironment): RuntimeOwnerIdentity {
  const root = dirname(startup.resourceRoot);
  return startup.sourceLayout === 'source'
    ? {
      server: { packageDir: join(root, 'packages/server'), entry: 'src/main.ts' },
      interface: { dir: join(root, 'packages/studio') },
    }
    : {
      server: { packageDir: join(startup.resourceRoot, 'server'), entry: 'src/main.ts' },
      interface: { dir: join(startup.resourceRoot, 'interface') },
    };
}

function cloneRuntimeOwnerIdentity(owners: RuntimeOwnerIdentity): RuntimeOwnerIdentity {
  return {
    server: { packageDir: owners.server.packageDir, entry: owners.server.entry },
    interface: { dir: owners.interface.dir },
  };
}

function validRuntimeOwnerIdentity(value: unknown): value is RuntimeOwnerIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ['server', 'interface']) || !isRecord(value.server) || !isRecord(value.interface)) return false;
  if (!hasExactKeys(value.server, ['packageDir', 'entry']) || !hasExactKeys(value.interface, ['dir'])) return false;
  return typeof value.server.packageDir === 'string' && value.server.packageDir.trim() !== ''
    && validServerEntry(value.server.entry)
    && typeof value.interface.dir === 'string' && value.interface.dir.trim() !== '';
}

function validServerEntry(entry: unknown): entry is string {
  return typeof entry === 'string'
    && /^src\/[A-Za-z0-9._/-]+$/.test(entry)
    && !entry.includes('..')
    && !entry.includes('\\')
    && !entry.startsWith('/');
}

function runtimeOwnerIdentityBelongsToResourceRoot(
  resourceRoot: string,
  owners: RuntimeOwnerIdentity,
): boolean {
  const packages = canonicalSourceResourceRoot(resourceRoot);
  if (!packages) return false;
  let serverDir: string;
  try {
    serverDir = realpathSync(owners.server.packageDir);
  } catch {
    return false;
  }
  const lexicalPackages = resolvePath(resourceRoot);
  const serverEntry = runtimePathResolve(serverDir, owners.server.entry);
  return isDeclaredServerRole(dirname(packages), owners.server)
    && runtimePathRelation(packages, serverDir) === 'within'
    && serverEntry !== null
    && runtimePathRelation(serverDir, serverEntry) === 'within'
    && (
      runtimePathRelation(join(packages, 'studio'), owners.interface.dir) === 'same'
      || runtimePathRelation(join(packages, 'interface'), owners.interface.dir) === 'same'
      || runtimePathRelation(join(lexicalPackages, 'studio'), owners.interface.dir) === 'same'
      || runtimePathRelation(join(lexicalPackages, 'interface'), owners.interface.dir) === 'same'
    );
}

/** Validates root-local recovery evidence with the same identity invariant as state. */
export function runtimeOwnerIdentityBelongsToRoot(root: string, owners: RuntimeOwnerIdentity): boolean {
  return runtimeOwnerIdentityBelongsToResourceRoot(join(resolve(root), 'packages'), owners);
}

function resolvePath(path: string): string {
  return resolve(path);
}

type RuntimePathRelation = 'same' | 'within' | 'outside';

/**
 * Compares two persisted paths by components, never by string prefix. Select
 * the path grammar from the values themselves so Windows-format contract
 * values can be tested on POSIX, while mixed POSIX/Windows paths fail closed.
 */
export function runtimePathRelation(parent: string, candidate: string): RuntimePathRelation {
  const path = runtimePathApi(parent, candidate);
  if (!path) return 'outside';
  const normalizedParent = normalizeRuntimePath(path.resolve(parent), path === win32);
  const normalizedCandidate = normalizeRuntimePath(path.resolve(candidate), path === win32);
  const relativePath = path.relative(normalizedParent, normalizedCandidate);
  if (relativePath === '') return 'same';
  return relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath)
    ? 'within'
    : 'outside';
}

function runtimePathResolve(parent: string, child: string): string | null {
  const path = runtimePathApi(parent, child);
  return path ? path.resolve(parent, child) : null;
}

function runtimePathApi(...paths: readonly string[]): typeof posix | typeof win32 | null {
  const windows = paths.some((path) => isWindowsRuntimePath(path));
  if (windows && paths.some((path) => path.startsWith('/'))) return null;
  return windows ? win32 : posix;
}

function isWindowsRuntimePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.includes('\\');
}

function normalizeRuntimePath(path: string, windows: boolean): string {
  return windows ? path.toLowerCase() : path;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validStartup(value: unknown, profile: string): value is StartupEnvironment {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.profile !== profile) return false;
  const allowed = new Set([
    'schemaVersion', 'profile', 'sourceLayout', 'resourceRoot', 'projectRoot',
    'envFile', 'stateFile', 'logFile', 'server', 'engine', 'gatewayBridge',
    'interface', 'hmrClientPort', 'optional', 'assetCorsOrigins',
    'agentHostSocket', 'standaloneProxy', 'allowedHosts', 'supervision',
    'startupTimeoutMs',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.sourceLayout !== 'source' && value.sourceLayout !== 'bundled') return false;
  return validPathFields(value)
    && validEndpoint(value.server)
    && validInterface(value.interface)
    && validEndpoint(value.engine)
    && validBridge(value.gatewayBridge)
    && port(value.hmrClientPort)
    && validOptional(value.optional)
    && Array.isArray(value.assetCorsOrigins) && value.assetCorsOrigins.every((origin) => typeof origin === 'string' && origin.trim() !== '')
    && typeof value.agentHostSocket === 'string' && value.agentHostSocket.trim() !== ''
    && typeof value.standaloneProxy === 'boolean'
    && (value.allowedHosts === undefined || typeof value.allowedHosts === 'string')
    && validSupervision(value.supervision)
    && positiveInteger(value.startupTimeoutMs);
}

function validPathFields(startup: Record<string, unknown>): boolean {
  return ['resourceRoot', 'projectRoot', 'envFile', 'stateFile', 'logFile']
    .every((key) => typeof startup[key] === 'string' && startup[key].trim() !== '');
}

function validEndpoint(value: unknown): value is StartupEnvironment['server'] {
  if (!isRecord(value)) return false;
  return typeof value.host === 'string'
    && value.host.trim() !== ''
    && port(value.port)
    && typeof value.healthPath === 'string'
    && value.healthPath.startsWith('/');
}

function validBridge(value: unknown): boolean {
  return isRecord(value)
    && typeof value.enabled === 'boolean'
    && typeof value.host === 'string'
    && value.host.trim() !== ''
    && port(value.port);
}

function validInterface(value: unknown): boolean {
  return validEndpoint(value)
    && isRecord(value)
    && (value.runtime === 'vite' || value.runtime === 'server-spa')
    && (value.protocol === 'http' || value.protocol === 'https')
    && typeof value.localOrigin === 'string' && value.localOrigin.trim() !== ''
    && typeof value.publicOrigin === 'string' && value.publicOrigin.trim() !== '';
}

function validOptional(value: unknown): boolean {
  return isRecord(value)
    && port(value.narrativePort)
    && port(value.faceMaskPort)
    && port(value.rhiReviewerPort)
    && typeof value.reelUrl === 'string' && value.reelUrl.trim() !== ''
    && nonNegativeInteger(value.pluginPortOffset);
}

function validSupervision(value: unknown): boolean {
  return isRecord(value)
    && (value.restartPolicy === 'fail-fast' || value.restartPolicy === 'bounded')
    && nonNegativeInteger(value.maxRestarts);
}

function validReadiness(value: unknown): boolean {
  if (!isRecord(value) || typeof value.ready !== 'boolean' || !validTimestamp(value.checkedAt) || !isRecord(value.services)) return false;
  const services = value.services;
  return ['server', 'interface', 'engine'].every((name) => validServiceReadiness(services[name]));
}

function validServiceReadiness(value: unknown): boolean {
  return isRecord(value)
    && typeof value.ready === 'boolean'
    && typeof value.url === 'string' && value.url.trim() !== ''
    && (value.status === undefined || nonNegativeInteger(value.status))
    && (value.error === undefined || typeof value.error === 'string');
}

function validManagedPorts(value: unknown, startup: StartupEnvironment): value is ManagedRuntimePorts {
  try {
    const ports = validatedManagedPorts(value);
    requireCoreManagedPorts(ports, startup);
    return true;
  } catch {
    return false;
  }
}

function validatedManagedPorts(value: unknown): ManagedRuntimePorts {
  if (!isRecord(value)) throw new Error('managedPorts must be a JSON object');
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error('managedPorts must not be empty');
  if (entries.some(([name, portValue]) => !validManagedPortName(name) || !port(portValue))) {
    throw new Error('managedPorts contains an invalid name or port');
  }
  const ports = entries.map(([, portValue]) => portValue as number);
  if (new Set(ports).size !== ports.length) throw new Error('managedPorts contains duplicate ports');
  return Object.fromEntries(entries) as ManagedRuntimePorts;
}

function requireCoreManagedPorts(ports: ManagedRuntimePorts, startup: StartupEnvironment): void {
  if (!coreManagedPortsMatch(ports, startup)) {
    throw new Error('managedPorts must contain the exact server, interface, and engine ports');
  }
  // An external bridge may be configured for Studio to reach, but it is never
  // a listener owned by the Studio launcher and must not enlarge stop authority.
  if (ports.bridge !== undefined) throw new Error('managedPorts must not contain the external bridge port');
}

function coreManagedPortsMatch(ports: ManagedRuntimePorts, startup: Pick<StartupEnvironment, 'server' | 'interface' | 'engine'>): boolean {
  if (ports.server !== startup.server.port || ports.engine !== startup.engine.port) return false;
  // desktop-prod serves the SPA from the server listener; recording a second
  // interface key for the same port would violate the no-duplicate contract.
  return 'sourceLayout' in startup && startup.sourceLayout === 'bundled'
    ? ports.interface === undefined
    : ports.interface === startup.interface.port;
}

function coreManagedPorts(startup: StartupEnvironment): ManagedRuntimePorts {
  return {
    server: startup.server.port,
    engine: startup.engine.port,
    ...(startup.sourceLayout === 'source' ? { interface: startup.interface.port } : {}),
  };
}

function validServicePids(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([name, pid]) => validManagedPortName(name) && positiveInteger(pid));
}

function validManagedPortName(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value) && value !== 'bridge';
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return value === 'starting' || value === 'ready' || value === 'failed' || value === 'stopping';
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function port(value: unknown): value is number {
  return positiveInteger(value) && value <= 65_535;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
