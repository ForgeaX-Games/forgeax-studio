/**
 * Probe the ForgeaX services and derive what the plugin can actually do right now.
 *
 * Capability is reported honestly rather than optimistically. A tool that advertises
 * itself as available and then blocks on an unreachable backend costs the model a
 * full round trip plus a timeout, and it will retry — the observed failure mode is a
 * single turn stretching to a minute or more.
 */
import { get as httpsGet } from 'node:https';
import { realpathSync } from 'node:fs';

/** Default ports. Kept in sync with docs/PORTS.md; overridable for non-default stacks. */
export const DEFAULT_PORTS = {
  /** forgeax-server: chat, sessions, workbench, files. http. */
  server: 18900,
  /** Studio UI vite. HTTP by default; HTTPS is opt-in for non-localhost use. */
  interface: 18920,
  /** play-runtime vite: serves and transforms game code. http. */
  engine: 15173,
} as const;

export type ServiceName = keyof typeof DEFAULT_PORTS;

export interface ServiceHealth {
  readonly name: ServiceName;
  readonly port: number;
  readonly url: string;
  readonly reachable: boolean;
  /** Why the probe failed, when it did. */
  readonly reason?: string;
}

/**
 * Capability tiers, ordered. Each tier strictly contains the previous one.
 *
 * - `local`   filesystem only: memory, project inspection, listing games
 * - `backend` server reachable: scaffold, files, static verify, sessions
 * - `runtime` engine reachable too: the game can actually run and be previewed
 */
export type CapabilityTier = 'local' | 'backend' | 'runtime';

export interface Capabilities {
  readonly tier: CapabilityTier;
  readonly services: readonly ServiceHealth[];
}

export interface EngineRuntimeIdentity {
  readonly instanceRootAbs: string;
  readonly runtimeVersion?: string;
  readonly engineVersion?: string;
}

function portOf(name: ServiceName): number {
  // These are the names consumed by forgeax-server, Vite and scripts/run.ts.
  const env = process.env[`FORGEAX_${name.toUpperCase()}_PORT`];
  const n = env ? Number.parseInt(env, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORTS[name];
}

function urlOf(name: ServiceName, port: number): string {
  // localhost is a secure browser context, so web-dev intentionally defaults to HTTP.
  // The Vite config enables its self-signed HTTPS mode only when this flag is set.
  const scheme =
    name === 'interface' && process.env.FORGEAX_INTERFACE_HTTPS === '1' ? 'https' : 'http';
  return `${scheme}://127.0.0.1:${port}`;
}

const PROBE_TIMEOUT_MS = 1500;

async function identityAt(
  url: string,
  expectedName: string,
  signal: AbortSignal,
): Promise<EngineRuntimeIdentity | undefined> {
  if (!url.startsWith('https://')) {
    const response = await fetch(url, { signal });
    if (!response.ok) return undefined;
    const value = (await response.json()) as {
      status?: unknown;
      name?: unknown;
      instanceRootAbs?: unknown;
      runtimeVersion?: unknown;
      engineVersion?: unknown;
    };
    return value.status === 'ok' &&
      value.name === expectedName &&
      typeof value.instanceRootAbs === 'string'
      ? {
        instanceRootAbs: value.instanceRootAbs,
        ...(typeof value.runtimeVersion === 'string' ? { runtimeVersion: value.runtimeVersion } : {}),
        ...(typeof value.engineVersion === 'string' ? { engineVersion: value.engineVersion } : {}),
      }
      : undefined;
  }

  return await new Promise((resolve, reject) => {
    const request = httpsGet(url, { rejectUnauthorized: false, signal }, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk: string) => {
        body = `${body}${chunk}`.slice(0, 16_384);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(body) as {
            status?: unknown;
            name?: unknown;
            instanceRootAbs?: unknown;
            runtimeVersion?: unknown;
            engineVersion?: unknown;
          };
          resolve(
            value.status === 'ok' &&
              value.name === expectedName &&
              typeof value.instanceRootAbs === 'string'
              ? {
                instanceRootAbs: value.instanceRootAbs,
                ...(typeof value.runtimeVersion === 'string' ? { runtimeVersion: value.runtimeVersion } : {}),
                ...(typeof value.engineVersion === 'string' ? { engineVersion: value.engineVersion } : {}),
              }
              : undefined,
          );
        } catch {
          resolve(undefined);
        }
      });
    });
    request.on('error', reject);
  });
}

async function isExpectedService(
  name: ServiceName,
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (name === 'server') {
    const response = await fetch(`${url}/api/health`, { signal });
    if (!response.ok) return false;
    const health = (await response.json()) as { status?: unknown; name?: unknown };
    return health.status === 'ok' && health.name === '@forgeax/server';
  }
  if (name === 'engine') {
    return (
      (await identityAt(
        `${url}/preview/__forgeax_health`,
        '@forgeax/play-runtime',
        signal,
      )) !== undefined
    );
  }
  return (
    (await identityAt(`${url}/api/health`, '@forgeax/server', signal)) !== undefined
  );
}

async function probeOne(name: ServiceName): Promise<ServiceHealth> {
  const port = portOf(name);
  const url = urlOf(name, port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const reachable = await isExpectedService(name, url, controller.signal);
    return {
      name,
      port,
      url,
      reachable,
      ...(reachable ? {} : { reason: `endpoint did not identify as ForgeaX ${name}` }),
    };
  } catch (e) {
    const reason = controller.signal.aborted
      ? `no response within ${PROBE_TIMEOUT_MS}ms`
      : (e as Error).message;
    return { name, port, url, reachable: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every service in parallel; never throws. */
export async function probeServices(): Promise<Capabilities> {
  const services = await Promise.all(
    (Object.keys(DEFAULT_PORTS) as ServiceName[]).map((n) => probeOne(n)),
  );
  const up = (n: ServiceName): boolean => services.find((s) => s.name === n)?.reachable === true;

  // The interface is deliberately not required for `runtime`: a headless carrier or a
  // plain browser tab can host the preview, so engine reachability is the real gate.
  const tier: CapabilityTier = !up('server') ? 'local' : up('engine') ? 'runtime' : 'backend';
  return { tier, services };
}

const TIER_ORDER: Record<CapabilityTier, number> = { local: 0, backend: 1, runtime: 2 };

export function tierAtLeast(actual: CapabilityTier, wanted: CapabilityTier): boolean {
  return TIER_ORDER[actual] >= TIER_ORDER[wanted];
}

/**
 * Poll until the stack reaches `wanted`, or give up.
 *
 * A cold vite start is seconds, not milliseconds, so the caller has to wait for
 * something. Polling the same health endpoints the status read uses means "ready"
 * here and "up" there can never disagree.
 */
export async function waitForTier(
  wanted: CapabilityTier,
  timeoutMs: number,
  intervalMs = 700,
): Promise<Capabilities> {
  const deadline = Date.now() + timeoutMs;
  let last = await probeServices();
  while (!tierAtLeast(last.tier, wanted) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await probeServices();
  }
  return last;
}

/** Preview URL for a game once the engine is up. */
export function previewUrl(slug: string): string {
  return `${urlOf('engine', portOf('engine'))}/?game=${encodeURIComponent(slug)}`;
}

export function serverBaseUrl(): string {
  return urlOf('server', portOf('server'));
}

/**
 * Refuse to use a healthy server that belongs to another checkout.
 *
 * Ports are machine-global while projects are not. Without this gate, two Studio
 * checkouts can make a command preview or mutate the wrong game's state.
 */
export async function assertServerProjectRoot(root: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${serverBaseUrl()}/api/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    const health = (await response.json()) as {
      status?: unknown;
      name?: unknown;
      instanceRootAbs?: unknown;
    };
    if (
      health.status !== 'ok' ||
      health.name !== '@forgeax/server' ||
      typeof health.instanceRootAbs !== 'string'
    ) {
      throw new Error('health response did not identify a ForgeaX server with instanceRootAbs');
    }
    const expected = realpathSync(root);
    const actual = realpathSync(health.instanceRootAbs);
    if (actual !== expected) {
      throw new Error(
        `ForgeaX server at ${serverBaseUrl()} belongs to ${health.instanceRootAbs}, but this command is bound to ${root}; start the server for this project before continuing`,
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${serverBaseUrl()} did not answer /api/health within ${PROBE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function assertEngineProjectRoot(root: string): Promise<void> {
  const port = portOf('engine');
  const url = urlOf('engine', port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const identity = await identityAt(
      `${url}/preview/__forgeax_health`,
      '@forgeax/play-runtime',
      controller.signal,
    );
    if (!identity) {
      throw new Error('health response did not identify a ForgeaX play runtime with instanceRootAbs');
    }
    const expected = realpathSync(root);
    const actual = realpathSync(identity.instanceRootAbs);
    if (actual !== expected) {
      throw new Error(
        `ForgeaX engine at ${url} belongs to ${identity.instanceRootAbs}, but this command is bound to ${root}; start the engine for this project before continuing`,
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${url} did not answer runtime health within ${PROBE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchEngineRuntimeIdentity(): Promise<EngineRuntimeIdentity | undefined> {
  const port = portOf('engine');
  const url = urlOf('engine', port);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await identityAt(`${url}/preview/__forgeax_health`, '@forgeax/play-runtime', controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
