import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  resolveStartupEnvironment,
  startupProcessEnv,
} from './startup-environment.ts';
import { requestedStartupProfile } from '../local-runtime.ts';

const root = '/tmp/forgeax-startup-contract/repo';
const homeDir = '/tmp/forgeax-startup-contract/home';

describe('startup environment', () => {
  test('derives the source profiles from one contract', () => {
    for (const profile of ['web-dev', 'desktop-dev', 'anydev-web'] as const) {
      const startup = resolveStartupEnvironment({ root, homeDir, profile, env: {} });

      expect(startup).toMatchObject({
        schemaVersion: 1,
        profile,
        sourceLayout: 'source',
        resourceRoot: join(root, 'packages'),
        projectRoot: root,
        server: { port: 18900, healthPath: '/api/health' },
        interface: {
          runtime: 'vite',
          port: 18920,
          protocol: 'http',
          localOrigin: 'http://127.0.0.1:18920',
        },
        engine: { port: 15173, healthPath: '/preview/' },
        supervision: { restartPolicy: 'fail-fast', maxRestarts: 0 },
        startupTimeoutMs: 180_000,
      });
      expect(startup.stateFile).toBe(join(root, '.forgeax/runtime', `${profile}.json`));
    }
  });

  test('keeps desktop production isolated while serving its SPA from the server origin', () => {
    const startup = resolveStartupEnvironment({
      root,
      homeDir,
      profile: 'desktop-prod',
      env: { FORGEAX_PUBLIC_ORIGIN: 'https://untrusted.example.test' },
    });

    expect(startup).toMatchObject({
      profile: 'desktop-prod',
      sourceLayout: 'bundled',
      resourceRoot: root,
      projectRoot: join(homeDir, 'ForgeaxProjects'),
      server: { host: '127.0.0.1', port: 18810 },
      interface: {
        runtime: 'server-spa',
        port: 18810,
        localOrigin: 'http://127.0.0.1:18810',
        publicOrigin: 'http://127.0.0.1:18810',
      },
      engine: { host: '127.0.0.1', port: 15273 },
      supervision: { restartPolicy: 'bounded', maxRestarts: 5 },
      startupTimeoutMs: 60_000,
    });
  });

  test('honours AnyDev gateway inputs without changing lifecycle semantics', () => {
    const startup = resolveStartupEnvironment({
      root,
      homeDir,
      profile: 'anydev-web',
      env: {
        FORGEAX_INTERFACE_PORT: '80',
        FORGEAX_HMR_CLIENT_PORT: '443',
        FORGEAX_STANDALONE_PROXY: '1',
        FORGEAX_INTERFACE_ALLOWED_HOSTS: '.example.test',
        FORGEAX_PUBLIC_ORIGIN: 'https://studio.example.test',
      },
    });

    expect(startup.interface.port).toBe(80);
    expect(startup.interface.publicOrigin).toBe('https://studio.example.test');
    expect(startup.hmrClientPort).toBe(443);
    expect(startup.standaloneProxy).toBe(true);
    expect(startup.allowedHosts).toBe('.example.test');
  });

  test('projects the resolved contract into child process environment', () => {
    const startup = resolveStartupEnvironment({ root, homeDir, profile: 'desktop-prod', env: {} });
    const env = startupProcessEnv(startup, { KEEP_ME: 'yes' });

    expect(env).toMatchObject({
      KEEP_ME: 'yes',
      FORGEAX_STARTUP_PROFILE: 'desktop-prod',
      FORGEAX_SERVER_PORT: '18810',
      FORGEAX_SERVER_URL: 'http://127.0.0.1:18810',
      FORGEAX_INTERFACE_PORT: '18810',
      FORGEAX_ENGINE_PORT: '15273',
      FORGEAX_ENGINE_URL: 'http://127.0.0.1:15273',
      FORGEAX_SERVE_SPA: '1',
      FORGEAX_RUNTIME_STATE_FILE: startup.stateFile,
    });
  });

  test('rejects unknown profiles, invalid ports, and core port collisions', () => {
    expect(() => resolveStartupEnvironment({ root, profile: 'cloud', env: {} })).toThrow(
      /invalid FORGEAX_STARTUP_PROFILE/,
    );
    expect(() => resolveStartupEnvironment({
      root,
      profile: 'web-dev',
      env: { FORGEAX_SERVER_PORT: 'abc' },
    })).toThrow(/FORGEAX_SERVER_PORT must be a positive integer/);
    expect(() => resolveStartupEnvironment({
      root,
      profile: 'web-dev',
      env: { FORGEAX_SERVER_PORT: '18920' },
    })).toThrow(/colliding core ports/);
    expect(() => resolveStartupEnvironment({
      root,
      profile: 'web-dev',
      env: { FORGEAX_BRIDGE_PORT: '18900' },
    })).toThrow(/gateway bridge :18900 onto a core service port/);
  });

  test('selects the launcher profile explicitly before consulting the environment', () => {
    expect(requestedStartupProfile([], {})).toBe('web-dev');
    expect(requestedStartupProfile([], { FORGEAX_STARTUP_PROFILE: 'anydev-web' })).toBe('anydev-web');
    expect(requestedStartupProfile(['--profile', 'desktop-dev'], {
      FORGEAX_STARTUP_PROFILE: 'web-dev',
    })).toBe('desktop-dev');
    expect(requestedStartupProfile(['--profile=desktop-prod'], {})).toBe('desktop-prod');
    expect(() => requestedStartupProfile(['--profile=cloud'], {})).toThrow(/invalid startup profile/);
  });
});
