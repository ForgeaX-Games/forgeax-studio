import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLiteLlmConfig } from '../src/gen/config';
import { generate3dTool, generateImageTool } from '../src/gen/generate';
import { initLocalGame } from '../src/project/locate';

const ORIGINAL = {
  base: process.env.FORGEAX_LITELLM_BASE_URL,
  key: process.env.FORGEAX_LITELLM_API_KEY,
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (ORIGINAL.base === undefined) delete process.env.FORGEAX_LITELLM_BASE_URL;
  else process.env.FORGEAX_LITELLM_BASE_URL = ORIGINAL.base;
  if (ORIGINAL.key === undefined) delete process.env.FORGEAX_LITELLM_API_KEY;
  else process.env.FORGEAX_LITELLM_API_KEY = ORIGINAL.key;
});

/** A fresh project with one active game, torn down after the test. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-gen-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  initLocalGame(root, 'demo');
  return root;
}

/** A tiny valid-looking PNG (1x1) as base64, for the image mock. */
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMDAgHDdA0OAAAAAElFTkSuQmCC';

describe('resolveLiteLlmConfig', () => {
  test('throws a fix-naming error when the key is missing', () => {
    delete process.env.FORGEAX_LITELLM_API_KEY;
    expect(() => resolveLiteLlmConfig()).toThrow(/FORGEAX_LITELLM_API_KEY/);
  });

  test('reads base URL and key from the environment and strips trailing slashes', () => {
    process.env.FORGEAX_LITELLM_BASE_URL = 'http://gw.local:4000///';
    process.env.FORGEAX_LITELLM_API_KEY = 'sk-test';
    const cfg = resolveLiteLlmConfig();
    expect(cfg.baseUrl).toBe('http://gw.local:4000');
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.models.textToImage).toBe('gemini-3-pro-image');
  });
});

describe('forgeax_generate_image', () => {
  test('text-to-image saves a PNG into the active game assets and returns its path', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/v1/images/generations') {
          return Response.json({ data: [{ b64_json: PNG_1PX_B64 }] });
        }
        return new Response('not found', { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    process.env.FORGEAX_LITELLM_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.FORGEAX_LITELLM_API_KEY = 'sk-test';

    const root = makeProject();
    const out = await generateImageTool({ prompt: 'a red cube', name: 'cube' }, root);

    expect(out).toContain('demo');
    expect(out).toContain('assets/cube.png');
    const assets = join(root, '.forgeax', 'games', 'demo', 'assets');
    expect(readdirSync(assets)).toContain('cube.png');
  });

  test('requires a prompt', async () => {
    process.env.FORGEAX_LITELLM_API_KEY = 'sk-test';
    await expect(generateImageTool({ prompt: '   ' }, makeProject())).rejects.toThrow(/prompt/);
  });
});

describe('forgeax_generate_3d', () => {
  test('text-to-3D submits, polls, downloads the mesh, and saves a .glb', async () => {
    let polls = 0;
    const authSeen: boolean[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/v1/3d/generations') {
          expect(req.headers.get('authorization')).toBe('Bearer sk-test');
          return Response.json({ id: 'task-1', status: 'processing' });
        }
        if (url.pathname === '/v1/3d/tasks/task-1') {
          authSeen.push(req.headers.get('authorization') === 'Bearer sk-test');
          polls += 1;
          if (polls < 2) return Response.json({ id: 'task-1', status: 'processing', progress: 40 });
          return Response.json({
            id: 'task-1',
            status: 'succeeded',
            progress: 100,
            data: [{ url: `${url.origin}/mesh.glb`, type: 'mesh', format: 'glb' }],
          });
        }
        if (url.pathname === '/mesh.glb') {
          return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), {
            headers: { 'content-type': 'model/gltf-binary' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    cleanups.push(() => server.stop(true));
    process.env.FORGEAX_LITELLM_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.FORGEAX_LITELLM_API_KEY = 'sk-test';

    const root = makeProject();
    const out = await generate3dTool({ prompt: 'a wooden barrel', name: 'barrel' }, root);

    expect(out).toContain('assets/barrel.glb');
    expect(existsSync(join(root, '.forgeax', 'games', 'demo', 'assets', 'barrel.glb'))).toBe(true);
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(authSeen.every(Boolean)).toBe(true);
  }, 15_000);

  test('local-file image-to-3D without COS points at the COS variables', async () => {
    process.env.FORGEAX_LITELLM_API_KEY = 'sk-test';
    for (const k of ['FORGEAX_COS_BUCKET', 'FORGEAX_COS_REGION', 'FORGEAX_COS_SECRET_ID', 'FORGEAX_COS_SECRET_KEY']) {
      delete process.env[k];
    }
    const root = makeProject();
    const localImage = join(root, '.forgeax', 'games', 'demo', 'assets', 'src.png');
    mkdirSync(join(root, '.forgeax', 'games', 'demo', 'assets'), { recursive: true });
    writeFileSync(localImage, Buffer.from(PNG_1PX_B64, 'base64'));
    await expect(generate3dTool({ image: localImage }, root)).rejects.toThrow(/FORGEAX_COS/i);
  });

  test('requires prompt or image', async () => {
    process.env.FORGEAX_LITELLM_API_KEY = 'sk-test';
    await expect(generate3dTool({}, makeProject())).rejects.toThrow(/prompt.*image|image.*prompt/i);
  });
});
