import http from 'node:http';
import https from 'node:https';
import type { StartupEnvironment } from './startup-environment.ts';

export type CoreServiceName = 'server' | 'interface' | 'engine';

export interface ServiceReadiness {
  readonly ready: boolean;
  readonly url: string;
  readonly status?: number;
  readonly error?: string;
}

export interface RuntimeReadiness {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly services: Record<CoreServiceName, ServiceReadiness>;
}

interface WaitForRuntimeOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly launcherAlive?: () => boolean;
  readonly onCheck?: (readiness: RuntimeReadiness) => void;
}

export async function probeRuntime(startup: StartupEnvironment): Promise<RuntimeReadiness> {
  const serverUrl = `http://127.0.0.1:${startup.server.port}${startup.server.healthPath}`;
  const interfaceUrl = `${startup.interface.localOrigin}${startup.interface.healthPath}`;
  const engineUrl = `http://127.0.0.1:${startup.engine.port}${startup.engine.healthPath}`;
  const [server, runtimeInterface, engine] = await Promise.all([
    probeHttp(serverUrl),
    probeHttp(interfaceUrl),
    probeHttp(engineUrl),
  ]);

  const services = {
    server,
    interface: runtimeInterface,
    engine,
  };
  return {
    ready: Object.values(services).every((service) => service.ready),
    checkedAt: new Date().toISOString(),
    services,
  };
}

export async function waitForRuntime(
  startup: StartupEnvironment,
  options: WaitForRuntimeOptions = {},
): Promise<RuntimeReadiness> {
  const timeoutMs = options.timeoutMs ?? startup.startupTimeoutMs;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = performance.now() + timeoutMs;
  let last = await probeRuntime(startup);
  options.onCheck?.(last);

  while (!last.ready && performance.now() < deadline) {
    if (options.launcherAlive && !options.launcherAlive()) {
      return withLauncherError(last, 'local runtime launcher exited before readiness');
    }
    await Bun.sleep(intervalMs);
    last = await probeRuntime(startup);
    options.onCheck?.(last);
  }
  return last;
}

export function readinessSummary(readiness: RuntimeReadiness): string {
  return (Object.entries(readiness.services) as Array<[CoreServiceName, ServiceReadiness]>)
    .map(([name, result]) => {
      if (result.ready) return `${name}=ready`;
      const detail = result.status ? `HTTP ${result.status}` : result.error ?? 'unreachable';
      return `${name}=failed (${detail})`;
    })
    .join(', ');
}

function probeHttp(url: string): Promise<ServiceReadiness> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ServiceReadiness): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const request = (parsed.protocol === 'https:' ? https : http).request(
      parsed,
      {
        method: 'GET',
        ...(parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        finish({
          ready: status >= 200 && status < 300,
          url,
          status,
        });
      },
    );
    request.once('error', (error) => {
      finish({
        ready: false,
        url,
        error: error.message,
      });
    });
    // Bun's node:http compatibility layer can miss ClientRequest's `timeout`
    // event after a peer accepts the socket but stalls before sending headers.
    // Own the deadline here so one half-booted service cannot freeze the shared
    // runtime state in `starting`.
    timeout = setTimeout(() => {
      finish({
        ready: false,
        url,
        error: 'request timed out',
      });
      request.destroy();
    }, 1_000);
    request.end();
  });
}

function withLauncherError(readiness: RuntimeReadiness, error: string): RuntimeReadiness {
  return {
    ...readiness,
    ready: false,
    services: Object.fromEntries(
      Object.entries(readiness.services).map(([name, service]) => [
        name,
        service.ready ? service : { ...service, error },
      ]),
    ) as Record<CoreServiceName, ServiceReadiness>,
  };
}
