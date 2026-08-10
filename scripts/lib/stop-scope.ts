import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeInstance } from './runtime-instance.ts';
import type { RuntimeProcessOwnerRequest } from './runtime-process-owner.ts';
import type { RuntimeOwnerIdentity, RuntimeState } from './runtime-state.ts';
import { runtimeOwnerIdentityBelongsToRoot, runtimeStateBelongsToInstance } from './runtime-state.ts';
import { instanceStopPorts, type StopPort } from './ports.ts';
import { readStartLockOwner, StartLock, type StartLockOwner } from './startlock.ts';

export interface PluginOwner {
  readonly shortId: string;
  readonly dir: string;
  /** Every wrapper command this package actually declares, independent of stop's env. */
  readonly commands: readonly ('dev' | 'serve')[];
}

export interface StopPortTarget extends StopPort {
  readonly key: string;
  readonly owner: RuntimeProcessOwnerRequest;
}

/** A PID record is trusted only when one of its exact service contracts fits. */
export interface StopPidTarget {
  readonly pid: number;
  readonly key: string;
  readonly owners: readonly RuntimeProcessOwnerRequest[];
}

export interface StopScope {
  readonly state: RuntimeState | null;
  readonly ports: readonly StopPortTarget[];
  readonly pids: readonly StopPidTarget[];
  readonly unprovenPorts: readonly number[];
  readonly unprovenPids: readonly number[];
  readonly untrusted: boolean;
  /** A valid state and a valid lock name different launchers: do not act. */
  readonly lockConflict: boolean;
  /** Snapshot used for discovery; final cleanup must read the lock again. */
  readonly lockOwner: StartLockOwner | null;
}

export interface StopCleanupOptions {
  /** Re-run all owner/port checks after the cleanup lease has been acquired. */
  readonly canFinalize: () => boolean;
  readonly clearPidfiles: (projectRoot: string) => void;
  /** Narrow test seam for exercising a start that wins immediately before acquire. */
  readonly beforeAcquire?: () => void | Promise<void>;
  /** Narrow test seam for exercising a concurrent cleanup after this lease wins. */
  readonly onLeaseAcquired?: () => void | Promise<void>;
}

export type StopCleanupResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

type StopScopeOptions = {
  activeServer: { packageDir: string; entry: string };
  interfaceDir: string;
  plugins?: ReadonlyMap<string, PluginOwner>;
};

export function instanceStopCleanupPaths(instance: RuntimeInstance) {
  const forgeax = join(instance.projectRoot, '.forgeax');
  return {
    devStack: join(forgeax, 'dev-stack.env'),
    extensionPortMap: join(forgeax, 'extension-dev-ports.json'),
    state: instance.stateFile,
    runDir: join(forgeax, 'run'),
    runLock: join(forgeax, 'run.lock'),
  } as const;
}

export function discoverPluginOwners(root: string): ReadonlyMap<string, PluginOwner> {
  const owners = new Map<string, PluginOwner>();
  const extensions = join(root, 'packages/marketplace/extensions');
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(extensions, { withFileTypes: true });
  } catch {
    return owners;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifest = join(extensions, entry.name, 'forgeax-extension.json');
    try {
      const value = JSON.parse(readFileSync(manifest, 'utf8')) as {
        id?: unknown;
        entry?: { standalone?: { embeddedAlso?: unknown; start?: unknown } };
      };
      if (value.entry?.standalone?.embeddedAlso !== false || typeof value.entry.standalone.start !== 'string') continue;
      const shortId = String(value.id ?? entry.name).replace(/^@[^/]+\//, '');
      if (!/^[a-z0-9-]+$/.test(shortId)) continue;
      const dir = realpathSync(join(extensions, entry.name));
      const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const commands = (['dev', 'serve'] as const).filter((command) => Boolean(scripts.scripts?.[command]));
      if (commands.length > 0) owners.set(shortId, { shortId, dir, commands });
    } catch {
      // A malformed extension definition is never ownership evidence.
    }
  }
  return owners;
}

export function resolveInstanceStopScope(
  instance: RuntimeInstance,
  state: RuntimeState | null,
  options: StopScopeOptions,
): StopScope {
  const plugins = options.plugins ?? discoverPluginOwners(instance.root);
  const lockOwner = readStartLockOwner(instance.root);
  const trustedState = runtimeStateBelongsToInstance(instance, state);
  // A live state is the launcher's signed-in-memory replacement after a
  // SIGKILL.  Its owner identities are part of the persisted contract, so do
  // not let the stop shell's STUDIO/server profile reinterpret its children.
  const stateOptions = trustedState
    ? {
      ...options,
      activeServer: state.owners.server,
      interfaceDir: state.owners.interface.dir,
    }
    : options;
  const launcher = requestForKey('launcher', instance, stateOptions, plugins, 'state')!;
  if (!trustedState) {
    const recovery = fallbackRecovery(instance, options, plugins);
    const recoveryOptions = recovery.owners
      ? { ...options, activeServer: recovery.owners.server, interfaceDir: recovery.owners.interface.dir }
      : options;
    const ports = (recovery.ownerEvidence && !recovery.owners ? [] : instanceStopPorts(instance))
      .flatMap((candidate) => {
        const key = fallbackKey(candidate.port, instance);
        const owner = key ? requestForKey(key, instance, recoveryOptions, plugins, 'managed') : null;
        return owner ? [{ ...candidate, key, owner }] : [];
      });
    const pids = recovery.pids;
    if (lockOwner) addPidTarget(pids, lockOwner.pid, 'launcher (run.lock)', [launcher]);
    return {
      state: null,
      ports: [...ports, ...recovery.ports],
      pids,
      unprovenPorts: recovery.unprovenPorts,
      unprovenPids: recovery.unprovenPids,
      untrusted: recovery.untrusted,
      lockConflict: false,
      lockOwner,
    };
  }

  const ports: StopPortTarget[] = [];
  const unprovenPorts: number[] = [];
  for (const [key, port] of Object.entries(state.managedPorts)) {
    const owner = requestForKey(key, instance, stateOptions, plugins, 'managed');
    if (owner) ports.push({ port, key, service: `${key} (runtime state)`, owner });
    else unprovenPorts.push(port);
  }
  const pids: StopPidTarget[] = [];
  const unprovenPids: number[] = [];
  addPidTarget(pids, state.launcherPid, 'launcher', [launcher]);
  for (const [key, pid] of Object.entries(state.servicePids)) {
    const owners = requestsForKey(key, instance, stateOptions, plugins, 'state');
    if (owners.length > 0) addPidTarget(pids, pid, key, owners);
    else unprovenPids.push(pid);
  }

  // A valid state and a published owner must agree about the launcher.  A
  // disagreement is not a stale-file hint: it could be a concurrent handoff.
  const lockConflict = lockOwner !== null && lockOwner.pid !== state.launcherPid;
  return {
    state,
    ports,
    pids,
    unprovenPorts,
    unprovenPids,
    untrusted: lockConflict,
    lockConflict,
    lockOwner,
  };
}

/**
 * The finalizer must use this fresh check immediately before removing run.lock.
 * A live lock owner is always a reason to retain every recovery artifact: the
 * owner may have handed off after discovery, even when its token stayed stable.
 */
/**
 * Serializes cleanup with start/init. The lease directory itself is never
 * removed here: its token-guarded release is the only release operation.
 */
export async function cleanupStopArtifacts(
  instance: RuntimeInstance,
  options: StopCleanupOptions,
): Promise<StopCleanupResult> {
  let lease: StartLock | null = null;
  let result: StopCleanupResult;
  try {
    await options.beforeAcquire?.();
    lease = await StartLock.acquireForCleanup(instance.root, { guardPort: instance.ports.server });
    await options.onLeaseAcquired?.();
    if (!options.canFinalize()) {
      result = { ok: false, error: new Error('scoped resources changed while acquiring cleanup lease') };
    } else {
      const paths = instanceStopCleanupPaths(instance);
      rmSync(paths.devStack, { force: true });
      rmSync(paths.extensionPortMap, { force: true });
      rmSync(paths.state, { force: true });
      options.clearPidfiles(instance.projectRoot);
      result = { ok: true };
    }
  } catch (error) {
    result = { ok: false, error };
  } finally {
    try {
      lease?.release();
    } catch (error) {
      result = { ok: false, error };
    }
  }
  return result!;
}

function fallbackRecovery(
  instance: RuntimeInstance,
  options: StopScopeOptions,
  plugins: ReadonlyMap<string, PluginOwner>,
) {
  const paths = instanceStopCleanupPaths(instance);
  const ports: StopPortTarget[] = [];
  const pids: StopPidTarget[] = [];
  const unprovenPorts: number[] = [];
  const unprovenPids: number[] = [];
  let untrusted = false;
  let owners: RuntimeOwnerIdentity | undefined;
  let ownerEvidence = false;
  if (existsSync(paths.extensionPortMap)) {
    try {
      const value = JSON.parse(readFileSync(paths.extensionPortMap, 'utf8')) as {
        generatedBy?: unknown;
        plugins?: Record<string, { frontendPort?: unknown; backendPort?: unknown }>;
      };
      if (
        Object.keys(value).some((key) => key !== 'generatedBy' && key !== 'plugins')
        || value.generatedBy !== 'scripts/local-runtime.ts'
        || !value.plugins
        || typeof value.plugins !== 'object'
      ) throw new Error('invalid extension map');
      const seen = new Set<number>();
      for (const [id, entry] of Object.entries(value.plugins)) {
        if (Object.keys(entry).some((key) => key !== 'frontendPort' && key !== 'backendPort')) throw new Error('invalid extension entry');
        const shortId = id.replace(/^@[^/]+\//, '');
        const plugin = plugins.get(shortId);
        for (const [kind, port] of [['frontend', entry.frontendPort], ['backend', entry.backendPort]] as const) {
          if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535 || seen.has(port as number)) {
            untrusted = true;
            continue;
          }
          seen.add(port as number);
          if (!plugin) {
            unprovenPorts.push(port as number);
            continue;
          }
          const key = `plugin-${shortId}-${kind}`;
          const owner = requestForKey(key, instance, options, plugins, 'managed');
          if (owner) ports.push({ port: port as number, key, service: `${key} (fallback evidence)`, owner });
          else unprovenPorts.push(port as number);
        }
      }
    } catch {
      untrusted = true;
    }
  }
  if (existsSync(paths.devStack)) {
    try {
      const env = parseEnv(readFileSync(paths.devStack, 'utf8'));
      const ownerRecovery = readRecoveryOwners(instance, env);
      ownerEvidence = ownerRecovery.present;
      if (ownerRecovery.present && !ownerRecovery.owners) untrusted = true;
      owners = ownerRecovery.owners;
      for (const port of list(env.FORGEAX_RUN_PORTS, 65_535)) {
        if (!ports.some((target) => target.port === port)) unprovenPorts.push(port);
      }
      const ownerOptions = owners
        ? { ...options, activeServer: owners.server, interfaceDir: owners.interface.dir }
        : options;
      const candidates = ownerEvidence && !owners ? [] : recoveryPidOwners(instance, ownerOptions, plugins);
      for (const pid of list(env.FORGEAX_RUN_PIDS, Number.MAX_SAFE_INTEGER)) addPidTarget(pids, pid, 'dev-stack.env', candidates);
    } catch {
      untrusted = true;
    }
  }
  return {
    ports,
    pids,
    unprovenPorts: [...new Set(unprovenPorts)],
    unprovenPids: [...new Set(unprovenPids)],
    untrusted,
    owners,
    ownerEvidence,
  };
}

function readRecoveryOwners(
  instance: RuntimeInstance,
  env: Record<string, string>,
): { readonly present: boolean; readonly owners?: RuntimeOwnerIdentity } {
  const values = [env.FORGEAX_RUN_SERVER_PACKAGE_DIR, env.FORGEAX_RUN_SERVER_ENTRY, env.FORGEAX_RUN_INTERFACE_DIR];
  const present = values.some((value) => value !== undefined);
  if (!present || values.some((value) => value === undefined)) return { present };
  const owners: RuntimeOwnerIdentity = {
    server: { packageDir: values[0]!, entry: values[1]! },
    interface: { dir: values[2]! },
  };
  return runtimeOwnerIdentityBelongsToRoot(instance.root, owners) ? { present, owners } : { present };
}

function recoveryPidOwners(
  instance: RuntimeInstance,
  options: StopScopeOptions,
  plugins: ReadonlyMap<string, PluginOwner>,
): RuntimeProcessOwnerRequest[] {
  const keys = ['launcher', 'server', 'interface', 'engine', 'narrative', 'rhi-reviewer'];
  for (const shortId of plugins.keys()) {
    keys.push(`plugin-${shortId}`, `plugin-${shortId}-headless`);
  }
  return keys.flatMap((key) => {
    return requestsForKey(key, instance, options, plugins, 'state');
  });
}

function addPidTarget(
  targets: StopPidTarget[],
  pid: number,
  key: string,
  owners: readonly RuntimeProcessOwnerRequest[],
): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || owners.length === 0) return;
  const existing = targets.find((target) => target.pid === pid);
  if (existing) {
    const merged = [...existing.owners, ...owners.filter((owner) => !existing.owners.some((item) => JSON.stringify(item) === JSON.stringify(owner)))];
    const index = targets.indexOf(existing);
    targets[index] = { ...existing, owners: merged };
    return;
  }
  targets.push({ pid, key, owners: [...owners] });
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(?:"([^"]*)"|(.*))$/);
    if (match) out[match[1]!] = match[2] ?? match[3] ?? '';
    else if (line.trim() && !line.trim().startsWith('#')) throw new Error('invalid env');
  }
  return out;
}

function list(value: string | undefined, maximum: number): number[] {
  if (!value) return [];
  const values = value.split(/\s+/).map(Number);
  if (values.some((item) => !Number.isSafeInteger(item) || item < 1 || item > maximum)) throw new Error('invalid numeric record');
  return values;
}

function fallbackKey(port: number, instance: RuntimeInstance): string | null {
  if (port === instance.ports.server) return 'server';
  if (port === instance.ports.interface) return 'interface';
  if (port === instance.ports.engine) return 'engine';
  if (port === instance.ports.narrative) return 'narrative';
  if (port === instance.ports.rhiReviewer) return 'rhi-reviewer';
  return null;
}

function requestForKey(
  key: string,
  instance: RuntimeInstance,
  options: StopScopeOptions,
  plugins: ReadonlyMap<string, PluginOwner>,
  source: 'state' | 'managed',
): RuntimeProcessOwnerRequest | null {
  const basic: Record<string, RuntimeProcessOwnerRequest> = {
    launcher: { root: instance.root, service: 'launcher', ...(source === 'state' ? { stateServiceKey: 'launcher' } : {}) },
    server: { root: instance.root, service: 'server', activeServer: options.activeServer, ...(source === 'state' ? { stateServiceKey: 'server' } : { managedPortKey: 'server' }) },
    interface: { root: instance.root, service: 'interface', interfaceDir: options.interfaceDir, ...(source === 'state' ? { stateServiceKey: 'interface' } : { managedPortKey: 'interface' }) },
    engine: { root: instance.root, service: 'engine', ...(source === 'state' ? { stateServiceKey: 'engine' } : { managedPortKey: 'engine' }) },
    narrative: { root: instance.root, service: 'narrative', ...(source === 'state' ? { stateServiceKey: 'narrative' } : { managedPortKey: 'narrative' }) },
    'rhi-debug-reviewer': { root: instance.root, service: 'rhi-debug-reviewer', ...(source === 'state' ? { stateServiceKey: 'rhi-debug-reviewer' } : { managedPortKey: 'rhi-reviewer' }) },
    'rhi-reviewer': { root: instance.root, service: 'rhi-debug-reviewer', managedPortKey: 'rhi-reviewer' },
  };
  if (basic[key]) return basic[key];
  const headless = key.match(/^plugin-([a-z0-9-]+)-headless$/);
  const port = key.match(/^plugin-([a-z0-9-]+)-(frontend|backend)$/);
  const wrapper = key.match(/^plugin-([a-z0-9-]+)$/);
  const shortId = headless?.[1] ?? port?.[1] ?? wrapper?.[1];
  const plugin = shortId ? plugins.get(shortId) : undefined;
  if (!plugin) return null;
  if (headless) return { root: instance.root, service: 'plugin-headless', pluginDir: plugin.dir, pluginShortId: shortId!, ...(source === 'state' ? { stateServiceKey: key } : {}) };
  const pluginCommand = plugin.commands[0];
  if (!pluginCommand) return null;
  if (port) return { root: instance.root, service: port[2] === 'frontend' ? 'plugin-frontend' : 'plugin-backend', pluginDir: plugin.dir, pluginShortId: shortId!, pluginCommand, ...(source === 'state' ? { stateServiceKey: `plugin-${shortId}` } : { managedPortKey: key }) };
  if (wrapper && source === 'state') return { root: instance.root, service: 'plugin-frontend', pluginDir: plugin.dir, pluginShortId: shortId!, pluginCommand, stateServiceKey: key };
  return null;
}

/** State/dev-stack wrapper records have no persisted HMR mode, so try only declared commands. */
function requestsForKey(
  key: string,
  instance: RuntimeInstance,
  options: StopScopeOptions,
  plugins: ReadonlyMap<string, PluginOwner>,
  source: 'state' | 'managed',
): RuntimeProcessOwnerRequest[] {
  const wrapper = key.match(/^plugin-([a-z0-9-]+)$/);
  const plugin = wrapper ? plugins.get(wrapper[1]!) : undefined;
  if (!plugin || source !== 'state') {
    const owner = requestForKey(key, instance, options, plugins, source);
    return owner ? [owner] : [];
  }
  return plugin.commands.map((pluginCommand) => ({
    root: instance.root,
    service: 'plugin-frontend' as const,
    pluginDir: plugin.dir,
    pluginShortId: plugin.shortId,
    pluginCommand,
    stateServiceKey: key,
  }));
}
