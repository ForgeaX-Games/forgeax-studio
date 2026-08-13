import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
      expect(startup.logFile).toBe(join(root, '.forgeax/runtime/stack.log'));
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

  test('projects an isolated source instance including optional services and the actual UI CORS origin', () => {
    const startup = resolveStartupEnvironment({
      root,
      homeDir,
      profile: 'web-dev',
      env: {
        FORGEAX_SERVER_PORT: '28900',
        FORGEAX_INTERFACE_PORT: '28920',
        FORGEAX_ENGINE_PORT: '25173',
        NARRATIVE_PORT: '28930',
        FACE_MASK_PORT: '28931',
        FORGEAX_RHI_REVIEWER_PORT: '25274',
        FORGEAX_REEL_URL: 'http://127.0.0.1:25175',
        FORGEAX_PLUGIN_PORT_OFFSET: '10000',
        FORGEAX_AGENT_HOST_SOCK: '/tmp/slot-one/agent-host.sock',
        FORGEAX_PUBLIC_ORIGIN: 'https://studio.slot-one.test',
      },
    });
    const env = startupProcessEnv(startup, {});

    expect(startup.optional).toEqual({
      narrativePort: 28930,
      faceMaskPort: 28931,
      rhiReviewerPort: 25274,
      reelUrl: 'http://127.0.0.1:25175',
      pluginPortOffset: 10000,
    });
    expect(startup.assetCorsOrigins).toEqual([
      'https://studio.slot-one.test',
      'http://localhost:28920',
      'http://127.0.0.1:28920',
      'https://localhost:28920',
      'https://127.0.0.1:28920',
    ]);
    expect(env).toMatchObject({
      FORGEAX_HMR_CLIENT_PORT: '28920',
      FORGEAX_ASSET_CORS_ORIGINS: startup.assetCorsOrigins.join(','),
      FORGEAX_AGENT_HOST_SOCK: '/tmp/slot-one/agent-host.sock',
      NARRATIVE_PORT: '28930',
      FACE_MASK_PORT: '28931',
      FORGEAX_RHI_REVIEWER_PORT: '25274',
      FORGEAX_REEL_URL: 'http://127.0.0.1:25175',
      FORGEAX_PLUGIN_PORT_OFFSET: '10000',
    });
  });

  test('does not project a retired bridge port when bridge use is explicitly disabled', () => {
    const startup = resolveStartupEnvironment({
      root,
      homeDir,
      profile: 'web-dev',
      env: { FORGEAX_BRIDGE: '0', FORGEAX_BRIDGE_PORT: '25295' },
    });
    const env = startupProcessEnv(startup, { FORGEAX_BRIDGE_PORT: '25295' });

    expect(startup.gatewayBridge.enabled).toBe(false);
    expect(env.FORGEAX_BRIDGE).toBe('0');
    expect(env.FORGEAX_BRIDGE_PORT).toBeUndefined();
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
    expect(() => resolveStartupEnvironment({
      root,
      profile: 'web-dev',
      env: { NARRATIVE_PORT: '18900' },
    })).toThrow(/colliding managed ports.*server=18900.*narrative=18900/);
    expect(() => resolveStartupEnvironment({
      root,
      profile: 'web-dev',
      env: { FACE_MASK_PORT: '25274', FORGEAX_RHI_REVIEWER_PORT: '25274' },
    })).toThrow(/colliding managed ports.*face-mask=25274.*rhi-reviewer=25274/);
    expect(() => resolveStartupEnvironment({
      root,
      profile: 'desktop-prod',
      env: {
        NARRATIVE_PORT: 'not-a-port',
        FACE_MASK_PORT: '0',
        FORGEAX_RHI_REVIEWER_PORT: '70000',
        FORGEAX_REEL_URL: 'not a url',
        FORGEAX_PLUGIN_PORT_OFFSET: '-1',
      },
    })).not.toThrow();
  });

  test('lets a bundled launcher override ports through the generic variables', () => {
    const startup = resolveStartupEnvironment({
      root,
      homeDir,
      profile: 'desktop-prod',
      env: { FORGEAX_SERVER_PORT: '28810', FORGEAX_ENGINE_PORT: '25273' },
    });

    expect(startup.server.port).toBe(28810);
    expect(startup.engine.port).toBe(25273);

    // The desktop-specific variable still wins when both are present.
    expect(resolveStartupEnvironment({
      root,
      homeDir,
      profile: 'desktop-prod',
      env: { FORGEAX_DESKTOP_SERVER_PORT: '28811', FORGEAX_SERVER_PORT: '28810' },
    }).server.port).toBe(28811);

    // A malformed value is blamed on the variable that carried it, not the preferred one.
    expect(() => resolveStartupEnvironment({
      root,
      homeDir,
      profile: 'desktop-prod',
      env: { FORGEAX_SERVER_PORT: 'abc' },
    })).toThrow(/FORGEAX_SERVER_PORT must be a positive integer/);
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

  test('detached source entrypoints consume the parent projection without re-reading dotenv', () => {
    const localRuntime = readFileSync(join(import.meta.dir, '..', 'local-runtime.ts'), 'utf8');
    const run = readFileSync(join(import.meta.dir, '..', 'run.ts'), 'utf8');

    for (const source of [localRuntime, run]) {
      expect(source).not.toContain("from './lib/env.ts'");
      expect(source).not.toContain('loadDotenv(');
    }
    expect(localRuntime).toContain('publishSourceRuntimeContext(startup)');
    expect(run).toContain('consumeSourceRuntimeContext()');
    expect(run).not.toContain('resolveStartupEnvironment({');
    expect(run).not.toContain('Object.assign(process.env, startupProcessEnv(startup))');
  });
});
