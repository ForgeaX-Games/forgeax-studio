import { afterEach, describe, expect, test } from 'bun:test';
import { previewUrl, probeServices, serverBaseUrl } from '../src/services/probe';

const ORIGINAL = {
  server: process.env.FORGEAX_SERVER_PORT,
  engine: process.env.FORGEAX_ENGINE_PORT,
};

afterEach(() => {
  if (ORIGINAL.server === undefined) delete process.env.FORGEAX_SERVER_PORT;
  else process.env.FORGEAX_SERVER_PORT = ORIGINAL.server;
  if (ORIGINAL.engine === undefined) delete process.env.FORGEAX_ENGINE_PORT;
  else process.env.FORGEAX_ENGINE_PORT = ORIGINAL.engine;
});

describe('ForgeaX service URLs', () => {
  test('uses the same port override names as the Studio stack', () => {
    process.env.FORGEAX_SERVER_PORT = '28900';
    process.env.FORGEAX_ENGINE_PORT = '25173';

    expect(serverBaseUrl()).toBe('http://127.0.0.1:28900');
    expect(previewUrl('hello world')).toBe('http://127.0.0.1:25173/?game=hello%20world');
  });

  test('does not treat an arbitrary HTTP listener as forgeax-server', async () => {
    const listener = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: 'ok', name: 'another-service' }),
    });
    process.env.FORGEAX_SERVER_PORT = String(listener.port);
    try {
      const capabilities = await probeServices();
      expect(capabilities.tier).toBe('local');
      expect(capabilities.services.find((service) => service.name === 'server')).toMatchObject({
        reachable: false,
        reason: 'endpoint did not identify as ForgeaX server',
      });
    } finally {
      listener.stop(true);
    }
  });
});
