import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRuntime, readinessSummary, waitForRuntime } from './runtime-readiness.ts';
import { readRuntimeState, RuntimeStateStore } from './runtime-state.ts';
import { resolveStartupEnvironment } from './startup-environment.ts';

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime readiness', () => {
  test('requires real HTTP success from server, interface proxy, and engine', async () => {
    const serverPort = await listen('/api/health');
    const interfacePort = await listen('/api/health');
    const enginePort = await listen('/preview/');
    const startup = sourceStartup(serverPort, interfacePort, enginePort);

    const readiness = await probeRuntime(startup);

    expect(readiness.ready).toBe(true);
    expect(readinessSummary(readiness)).toBe('server=ready, interface=ready, engine=ready');
  });

  test('does not treat a bound port or a non-success response as ready', async () => {
    const serverPort = await listen('/api/health');
    const interfacePort = await listen('/not-the-health-route');
    const enginePort = await listen('/preview/');
    const startup = sourceStartup(serverPort, interfacePort, enginePort);

    const readiness = await probeRuntime(startup);

    expect(readiness.ready).toBe(false);
    expect(readiness.services.interface.status).toBe(404);
    expect(readinessSummary(readiness)).toContain('interface=failed (HTTP 404)');
  });

  test('stops waiting when the launcher exits', async () => {
    const startup = sourceStartup(40101, 40102, 40103);
    const readiness = await waitForRuntime(startup, {
      timeoutMs: 5_000,
      launcherAlive: () => false,
    });

    expect(readiness.ready).toBe(false);
    expect(readinessSummary(readiness)).toContain('launcher exited before readiness');
  });

  test('times out a peer that accepts HTTP but never sends headers', async () => {
    const serverPort = await listen('/api/health');
    const interfacePort = await listenStalled();
    const enginePort = await listen('/preview/');
    const startup = sourceStartup(serverPort, interfacePort, enginePort);

    const readiness = await probeRuntime(startup);

    expect(readiness.ready).toBe(false);
    expect(readiness.services.interface.error).toBe('request timed out');
  });
});

describe('runtime state', () => {
  test('writes one atomic, sanitized state contract for every surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-state-'));
    roots.push(root);
    const startup = resolveStartupEnvironment({
      root,
      homeDir: root,
      profile: 'desktop-prod',
      env: {
        FORGEAX_RESOURCE_ROOT: join(root, 'resources'),
        FORGEAX_PROJECT_ROOT: join(root, 'projects'),
      },
    });
    const store = new RuntimeStateStore(startup, 321);

    store.writeStarting();
    store.setServicePid('server', 111);
    store.markFailed('engine did not become ready');

    expect(readRuntimeState(startup.stateFile)).toMatchObject({
      schemaVersion: 1,
      profile: 'desktop-prod',
      status: 'failed',
      launcherPid: 321,
      publicOrigin: 'http://127.0.0.1:18810',
      servicePids: { server: 111 },
      error: 'engine did not become ready',
    });
  });

  test('rejects a structurally invalid state document at the disk boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-state-invalid-'));
    roots.push(root);
    const path = join(root, 'runtime.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      profile: 'web-dev',
      status: 'ready',
      launcherPid: 123,
      publicOrigin: 'http://127.0.0.1:18920',
      startup: {},
      servicePids: {},
    }));

    expect(readRuntimeState(path)).toBeNull();
  });
});

async function listen(okPath: string): Promise<number> {
  const server = createServer((request, response) => {
    response.statusCode = request.url === okPath ? 200 : 404;
    response.end(request.url === okPath ? 'ok' : 'not found');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server port');
  return address.port;
}

async function listenStalled(): Promise<number> {
  const server = createServer(() => {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server port');
  return address.port;
}

function sourceStartup(serverPort: number, interfacePort: number, enginePort: number) {
  return resolveStartupEnvironment({
    root: '/tmp/forgeax-runtime-readiness',
    profile: 'web-dev',
    env: {
      FORGEAX_SERVER_PORT: String(serverPort),
      FORGEAX_INTERFACE_PORT: String(interfacePort),
      FORGEAX_ENGINE_PORT: String(enginePort),
    },
  });
}
