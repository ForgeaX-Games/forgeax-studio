import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveStartupEnvironment,
  startupProcessEnv,
} from './startup-environment.ts';
import { requestedStartupProfile } from '../local-runtime.ts';

const root = '/tmp/forgeax-startup-contract/repo';

describe('startup environment', () => {
  test('derives the source profiles from one contract', () => {
    for (const profile of ['web-dev', 'desktop-dev', 'anydev-web'] as const) {
      const startup = resolveStartupEnvironment({ root, profile, env: {} });

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
      expect(startup.gatewayBridge.enabled).toBe(false);
    }
  });


  test('honours AnyDev gateway inputs without changing lifecycle semantics', () => {
    const startup = resolveStartupEnvironment({
      root,
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

  test('enables the loopback Engine MCP endpoint only when explicitly requested', () => {
    const startup = resolveStartupEnvironment({
      root,
      profile: 'anydev-web',
      env: { FORGEAX_MCP_HTTP: '1', FORGEAX_MCP_PORT: '28940' },
    });
    const env = startupProcessEnv(startup, {});

    expect(startup.mcp).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 28940,
      healthPath: '/healthz',
      publicPath: '/engine/mcp',
    });
    expect(env.FORGEAX_MCP_URL).toBe('http://127.0.0.1:28940');
    expect(resolveStartupEnvironment({ root, profile: 'web-dev', env: {} }).mcp.enabled).toBe(false);
  });

  test('projects the resolved contract into child process environment', () => {
    const startup = resolveStartupEnvironment({ root, profile: 'desktop-dev', env: {} });
    const env = startupProcessEnv(startup, { KEEP_ME: 'yes' });

    expect(env).toMatchObject({
      KEEP_ME: 'yes',
      FORGEAX_STARTUP_PROFILE: 'desktop-dev',
      FORGEAX_SERVER_PORT: '18900',
      FORGEAX_SERVER_URL: 'http://127.0.0.1:18900',
      FORGEAX_INTERFACE_PORT: '18920',
      FORGEAX_ENGINE_PORT: '15173',
      FORGEAX_ENGINE_URL: 'http://127.0.0.1:15173',
      FORGEAX_SERVE_SPA: '0',
      FORGEAX_RUNTIME_STATE_FILE: startup.stateFile,
    });
    expect(env.FORGEAX_BRIDGE).toBe('0');
    expect(env.FORGEAX_EDITOR_RELAY_URL).toBeUndefined();
  });

  test('keeps optional project MCP prewarm off the source readiness path unless explicitly enabled', () => {
    const source = resolveStartupEnvironment({ root, profile: 'web-dev', env: {} });

    expect(startupProcessEnv(source, {}).FORGEAX_PROJECT_MCP_PREWARM).toBe('0');
    expect(startupProcessEnv(source, { FORGEAX_PROJECT_MCP_PREWARM: '1' }).FORGEAX_PROJECT_MCP_PREWARM).toBe('1');
  });

  test('projects an isolated source instance including optional services and the actual UI CORS origin', () => {
    const startup = resolveStartupEnvironment({
      root,
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

  test('projects the DEV editor relay only when it is explicitly enabled', () => {
    const enabled = resolveStartupEnvironment({
      root,
      profile: 'web-dev',
      env: { FORGEAX_BRIDGE: '1', FORGEAX_BRIDGE_PORT: '25295' },
    });
    const enabledEnv = startupProcessEnv(enabled, {});

    expect(enabled.gatewayBridge.enabled).toBe(true);
    expect(enabledEnv.FORGEAX_BRIDGE).toBe('1');
    expect(enabledEnv.FORGEAX_BRIDGE_PORT).toBe('25295');
    expect(enabledEnv.FORGEAX_EDITOR_RELAY_URL).toBe('http://127.0.0.1:25295');

    const startup = resolveStartupEnvironment({
      root,
      profile: 'web-dev',
      env: { FORGEAX_BRIDGE_PORT: '25295' },
    });
    const env = startupProcessEnv(startup, {
      FORGEAX_BRIDGE_PORT: '25295',
      FORGEAX_BRIDGE_URL: 'http://127.0.0.1:25295',
      FORGEAX_EDITOR_RELAY_URL: 'http://127.0.0.1:25295',
    });

    expect(startup.gatewayBridge.enabled).toBe(false);
    expect(env.FORGEAX_BRIDGE).toBe('0');
    expect(env.FORGEAX_BRIDGE_PORT).toBeUndefined();
    expect(env.FORGEAX_BRIDGE_URL).toBeUndefined();
    expect(env.FORGEAX_EDITOR_RELAY_URL).toBeUndefined();
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
      env: { FORGEAX_BRIDGE: '1', FORGEAX_BRIDGE_PORT: '18900' },
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

  });


  test('selects the launcher profile explicitly before consulting the environment', () => {
    expect(requestedStartupProfile([], {})).toBe('web-dev');
    expect(requestedStartupProfile([], { FORGEAX_STARTUP_PROFILE: 'anydev-web' })).toBe('anydev-web');
    expect(requestedStartupProfile(['--profile', 'desktop-dev'], {
      FORGEAX_STARTUP_PROFILE: 'web-dev',
    })).toBe('desktop-dev');
    expect(() => requestedStartupProfile(['--profile=desktop-prod'], {})).toThrow(/invalid startup profile/);
    expect(() => resolveStartupEnvironment({ root, profile: 'desktop-prod', env: {} })).toThrow(/invalid FORGEAX_STARTUP_PROFILE/);
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
