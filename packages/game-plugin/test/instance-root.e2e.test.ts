import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runCurrentGame } from '../src/run/run-game';
import { collectStatus } from '../src/status/collect';
import { acquireStartLock } from '../src/run/log-paths';

const packageRoot = resolve(import.meta.dir, '..');
const sourceEntry = join(packageRoot, 'src', 'main.ts');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'forgeax-game-root-gate-'));
const projectRoot = join(fixtureRoot, 'project');
const otherRoot = join(fixtureRoot, 'other-instance');
let stopServer: () => void;
let port: number;

beforeAll(() => {
  mkdirSync(join(projectRoot, '.forgeax', 'games', 'demo'), { recursive: true });
  mkdirSync(otherRoot, { recursive: true });
  const listener = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/api/health') {
        return Response.json({
          status: 'ok',
          name: '@forgeax/server',
          instanceRootAbs: otherRoot,
        });
      }
      return Response.json({ error: 'mutation must not be reached' }, { status: 500 });
    },
  });
  port = listener.port!;
  stopServer = () => listener.stop(true);
});

afterAll(() => {
  stopServer();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('CLI instance-root safety gate', () => {
  test('refuses use before mutating a different running Studio instance', async () => {
    const child = spawn(process.execPath, [sourceEntry, 'use', 'demo'], {
      cwd: projectRoot,
      env: { ...process.env, FORGEAX_SERVER_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
    expect(code).toBe(1);
    expect(stderr).toContain('belongs to');
    expect(stderr).toContain('but this command is bound to');
  });

  test('refuses to preview through a runtime owned by another project', async () => {
    const previous = process.env.FORGEAX_SERVER_PORT;
    process.env.FORGEAX_SERVER_PORT = String(port);
    try {
      const result = await runCurrentGame(
        { game: 'demo', target_dir: projectRoot, start_services: false },
        projectRoot,
      );
      expect(result).toStartWith('error: ForgeaX server');
      expect(result).toContain('belongs to');
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_SERVER_PORT;
      else process.env.FORGEAX_SERVER_PORT = previous;
    }
  });

  test('reports a different project runtime as unavailable', async () => {
    const previous = process.env.FORGEAX_SERVER_PORT;
    process.env.FORGEAX_SERVER_PORT = String(port);
    try {
      const status = await collectStatus(projectRoot);
      expect(status.capabilities.tier).toBe('local');
      expect(status.capabilities.services.every((service) => !service.reachable)).toBeTrue();
      expect(status.capabilities.services[0]?.reason).toContain('belongs to');
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_SERVER_PORT;
      else process.env.FORGEAX_SERVER_PORT = previous;
    }
  });

  test('reports no live log when a matching stack was already running', async () => {
    const matchingServer = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/api/health') {
          return Response.json({
            status: 'ok',
            name: '@forgeax/server',
            instanceRootAbs: projectRoot,
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const engine = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/preview/__forgeax_health') {
          return Response.json({
            status: 'ok',
            name: '@forgeax/play-runtime',
            instanceRootAbs: projectRoot,
          });
        }
        return new Response(null, { status: 302, headers: { location: '/preview/' } });
      },
    });
    const studio = Bun.serve({ port: 0, fetch: () => new Response('studio') });
    const previous = {
      server: process.env.FORGEAX_SERVER_PORT,
      engine: process.env.FORGEAX_ENGINE_PORT,
      interface: process.env.FORGEAX_INTERFACE_PORT,
    };
    process.env.FORGEAX_SERVER_PORT = String(matchingServer.port);
    process.env.FORGEAX_ENGINE_PORT = String(engine.port);
    process.env.FORGEAX_INTERFACE_PORT = String(studio.port);
    try {
      const result = await runCurrentGame(
        { game: 'demo', target_dir: projectRoot, start_services: false },
        projectRoot,
      );
      expect(result).toContain('tier: runtime');
      expect(result).toContain('runtime_logs.local_file: unavailable');
      expect(result).toContain('cannot capture its existing process output retroactively');
    } finally {
      matchingServer.stop(true);
      engine.stop(true);
      studio.stop(true);
      for (const [name, value] of Object.entries(previous)) {
        const key = `FORGEAX_${name.toUpperCase()}_PORT`;
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('allows only one concurrent cold-start owner', () => {
    const first = acquireStartLock(projectRoot);
    const second = acquireStartLock(projectRoot);
    expect(first.acquired).toBeTrue();
    expect(second.acquired).toBeFalse();
    first.release();
    const third = acquireStartLock(projectRoot);
    expect(third.acquired).toBeTrue();
    third.release();
  });
});
