import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_COMMIT, ENGINE_VERSION, resolveEngineRelease } from '../src/engine/release';
import { installTestCarrier } from './carrier-fixture';
import {
  ENGINE_PREVIEW_CLEANUP_DEADLINE_MS,
  ENGINE_PREVIEW_TOTAL_DEADLINE_MS,
  startEnginePreview,
  stopEnginePreview,
  type EnginePreviewResult,
} from '../src/run/engine-preview';

const roots: string[] = [];
const previews: Array<{ root: string; result: EnginePreviewResult }> = [];

function packageAt(game: string, name: string, manifest: Record<string, unknown>): string {
  const root = join(game, 'node_modules', ...name.split('/'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name, version: ENGINE_VERSION, ...manifest }, null, 2)}\n`);
  return root;
}

function fixture(): string {
  const game = mkdtempSync(join(tmpdir(), 'forgeax-engine-preview-'));
  roots.push(game);
  mkdirSync(join(game, 'src'), { recursive: true });
  writeFileSync(join(game, 'forge.json'), `${JSON.stringify({ id: 'fixture', entry: 'src/main.ts' })}\n`);
  writeFileSync(join(game, 'package.json'), `${JSON.stringify({ dependencies: { '@forgeax/engine': ENGINE_VERSION } })}\n`);
  writeFileSync(join(game, 'src', 'main.ts'), 'export const fixture = true;\n');

  const engine = packageAt(game, '@forgeax/engine', { forgeax: { engineCommit: ENGINE_COMMIT } });
  packageAt(game, '@forgeax/engine-devkit', {});
  const carrier = packageAt(game, '@forgeax/engine-sdk', {});
  mkdirSync(join(carrier, 'sdk'), { recursive: true });
  writeFileSync(join(carrier, 'sdk', 'sdk-manifest.json'), `${JSON.stringify({
    schemaVersion: '1.8.0',
    sdkVersion: ENGINE_VERSION,
    engineCommit: ENGINE_COMMIT,
    packages: [
      { name: '@forgeax/engine', version: ENGINE_VERSION },
      { name: '@forgeax/engine-devkit', version: ENGINE_VERSION },
    ],
  })}\n`);

  mkdirSync(join(engine, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(engine, 'dist', 'bin', 'forgeax.mjs'), `
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
const command = process.argv[3];
const root = realpathSync(process.cwd());
const version = ${JSON.stringify(ENGINE_VERSION)};
const commit = ${JSON.stringify(ENGINE_COMMIT)};
const dist = join(root, 'dist', 'forgeax-dist.json');
if (command === 'build') {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(dist, JSON.stringify({ schemaVersion: 'fixture/1', root }));
  if (existsSync(join(root, 'emit-noise'))) process.stdout.write('transforming...\\n');
  process.stdout.write(JSON.stringify({ artifacts: [], command: 'project build', ok: true, value: { root } }) + '\\n');
  if (existsSync(join(root, 'emit-suffix'))) process.stdout.write('late diagnostic\\n');
  if (existsSync(join(root, 'emit-duplicate'))) process.stdout.write(JSON.stringify({ artifacts: [], command: 'project build', ok: true, value: { root } }) + '\\n');
} else if (command === 'preview') {
  const token = process.env.FORGEAX_PREVIEW_INSTANCE_TOKEN;
  if (!token) throw new Error('missing token');
  process.stderr.write(token.slice(0, 31));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  process.stderr.write(token.slice(31) + '\\n');
  const identity = {
    root,
    urls: { local: [], network: [] },
    engineVersion: version,
    engineCommit: commit,
    buildDigest: createHash('sha256').update(readFileSync(dist)).digest('hex'),
    previewInstanceId: randomUUID(),
  };
  const server = http.createServer((request, response) => {
    if (request.url === '/forgeax-dist.json') {
      response.setHeader('content-type', 'application/json');
      response.end(readFileSync(dist));
      return;
    }
    if (request.url !== '/.forgeax/preview-health' || existsSync(join(root, 'compat-preview'))) { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(identity));
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    identity.urls.local.push('http://127.0.0.1:' + address.port + '/');
    const value = existsSync(join(root, 'compat-preview'))
      ? { root, urls: identity.urls, mode: 'preview', serves: 'dist', capabilities: {} }
      : identity;
    process.stdout.write(JSON.stringify({ artifacts: [], command: 'project preview', ok: true, value }) + '\\n');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else {
  process.stdout.write(JSON.stringify({ schemaVersion: '1.0.0', command, ok: false, error: { code: 'unknown' } }) + '\\n');
  process.exitCode = 1;
}
`);
  installTestCarrier(game);
  return game;
}

function carrierPluginRoot(game: string): string {
  return join(game, '.forgeax-test-plugin', 'node_modules', '@forgeax', 'game');
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await Bun.sleep(20);
  }
  throw new Error(`process ${pid} remained alive`);
}

afterEach(async () => {
  while (previews.length) {
    const { root } = previews.pop()!;
    await stopEnginePreview(root, root, { cleanupDeadlineMs: 1_000 }).catch(() => undefined);
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('exact Engine release resolution', () => {
  test('resolves game-local Engine and CLI plus the plugin sibling carrier', () => {
    const game = fixture();
    const release = resolveEngineRelease(game, { pluginRoot: carrierPluginRoot(game) });
    expect(release.gameRoot).toBe(realpathSync(game));
    expect(release.version).toBe(ENGINE_VERSION);
    expect(release.commit).toBe(ENGINE_COMMIT);
    expect(release.cliPath).toStartWith(realpathSync(join(game, 'node_modules')));
  });

  test('accepts a public game that has no game-local Engine DevKit package', () => {
    const game = fixture();
    rmSync(join(game, 'node_modules', '@forgeax', 'engine-devkit'), { recursive: true, force: true });
    const release = resolveEngineRelease(game, { pluginRoot: carrierPluginRoot(game) });
    expect(release.packageRoot).toBe(realpathSync(join(game, 'node_modules', '@forgeax', 'engine')));
    expect(release.commit).toBe(ENGINE_COMMIT);
  });

  test('ignores a game-local carrier and binds the Game Plugin sibling carrier', () => {
    const game = fixture();
    const manifest = join(game, 'node_modules', '@forgeax', 'engine-sdk', 'sdk', 'sdk-manifest.json');
    const value = JSON.parse(readFileSync(manifest, 'utf8'));
    value.engineCommit = 'wrong';
    writeFileSync(manifest, JSON.stringify(value));
    const release = resolveEngineRelease(game, { pluginRoot: carrierPluginRoot(game) });
    expect(release.commit).toBe(ENGINE_COMMIT);
    expect(release.carrierRoot).toContain('/node_modules/@forgeax/engine-sdk');
  });

  test('accepts the public Engine package manifest when it omits the optional commit field', () => {
    const game = fixture();
    const manifestPath = join(game, 'node_modules', '@forgeax', 'engine', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.forgeax;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const release = resolveEngineRelease(game, { pluginRoot: carrierPluginRoot(game) });
    expect(release.version).toBe(ENGINE_VERSION);
    expect(release.commit).toBe(ENGINE_COMMIT);
  });

  test('rejects a public Engine package with the wrong version', () => {
    const game = fixture();
    const manifestPath = join(game, 'node_modules', '@forgeax', 'engine', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.version = '0.1.6';
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => resolveEngineRelease(game, { pluginRoot: carrierPluginRoot(game) })).toThrow(/engine_release_mismatch/);
  });

  test('rejects an Engine package commit that conflicts with the carrier manifest', () => {
    const game = fixture();
    const manifestPath = join(game, 'node_modules', '@forgeax', 'engine', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.forgeax = { engineCommit: 'wrong' };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => resolveEngineRelease(game, { pluginRoot: carrierPluginRoot(game) })).toThrow(/engine_release_mismatch/);
  });

  test('rejects a carrier manifest with the wrong Engine DevKit version', () => {
    const game = fixture();
    const manifestPath = join(carrierPluginRoot(game), '..', 'engine-sdk', 'sdk', 'sdk-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.packages = [
      { name: '@forgeax/engine', version: ENGINE_VERSION },
      { name: '@forgeax/engine-devkit', version: '0.1.6' },
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => resolveEngineRelease(game, { pluginRoot: carrierPluginRoot(game) })).toThrow(/engine_sdk_manifest_mismatch/);
  });
});

describe('Engine-owned Preview lifecycle', () => {
  test('keeps the frozen 150 second operation and 5 second cleanup bounds', () => {
    expect(ENGINE_PREVIEW_TOTAL_DEADLINE_MS).toBe(150_000);
    expect(ENGINE_PREVIEW_CLEANUP_DEADLINE_MS).toBe(5_000);
  });

  test('accepts bounded diagnostics before the single terminal build frame', async () => {
    const game = fixture();
    writeFileSync(join(game, 'emit-noise'), '1');
    const result = await startEnginePreview(game, game, { totalDeadlineMs: 5_000, carrierPluginRoot: carrierPluginRoot(game) });
    previews.push({ root: game, result });
    expect(result.identity.root).toBe(realpathSync(game));
  });

  test('adapts the released Engine 0.1.7 preview envelope and verifies its static dist digest', async () => {
    const game = fixture();
    writeFileSync(join(game, 'compat-preview'), '1');
    const result = await startEnginePreview(game, game, { totalDeadlineMs: 5_000, carrierPluginRoot: carrierPluginRoot(game) });
    previews.push({ root: game, result });
    expect(result.identity.root).toBe(realpathSync(game));
    expect(result.identity.engineVersion).toBe(ENGINE_VERSION);
    expect(result.identity.engineCommit).toBe(ENGINE_COMMIT);
    expect(result.identity.buildDigest).toHaveLength(64);
    expect(result.identity.previewInstanceId).toHaveLength(36);
  });

  test('rejects diagnostics after the terminal frame and duplicate JSON frames', async () => {
    const suffix = fixture();
    writeFileSync(join(suffix, 'emit-suffix'), '1');
    await expect(startEnginePreview(suffix, suffix, { totalDeadlineMs: 5_000, carrierPluginRoot: carrierPluginRoot(suffix) })).rejects.toThrow(
      /build_envelope_invalid: diagnostics after JSON frame/,
    );
    const duplicate = fixture();
    writeFileSync(join(duplicate, 'emit-duplicate'), '1');
    await expect(startEnginePreview(duplicate, duplicate, { totalDeadlineMs: 5_000, carrierPluginRoot: carrierPluginRoot(duplicate) })).rejects.toThrow(
      /build_envelope_invalid: multiple JSON frames/,
    );
  });

  test('builds, authenticates, reuses, stops, and recovers after a crash', async () => {
    const game = fixture();
    const options = { totalDeadlineMs: 10_000, readyDeadlineMs: 5_000, cleanupDeadlineMs: 1_000, carrierPluginRoot: carrierPluginRoot(game) };
    const first = await startEnginePreview(game, game, options);
    previews.push({ root: game, result: first });
    expect(first.reused).toBeFalse();
    const unauthenticated = await fetch(new URL('/.forgeax/preview-health', first.selectedUrl));
    expect(unauthenticated.status).toBe(401);

    const second = await startEnginePreview(game, game, options);
    expect(second.reused).toBeTrue();
    expect(second.pid).toBe(first.pid);
    expect(second.identity.previewInstanceId).toBe(first.identity.previewInstanceId);

    const stopped = await stopEnginePreview(game, game, options);
    previews.pop();
    expect(stopped.stopped).toBeTrue();
    await waitDead(first.pid);

    const restarted = await startEnginePreview(game, game, options);
    previews.push({ root: game, result: restarted });
    process.kill(restarted.pid, 'SIGKILL');
    await waitDead(restarted.pid);
    const recovered = await startEnginePreview(game, game, options);
    previews.pop();
    previews.push({ root: game, result: recovered });
    expect(recovered.reused).toBeFalse();
    expect(recovered.pid).not.toBe(restarted.pid);
    const frames = readFileSync(recovered.paths.stdout, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    expect(frames.length).toBeGreaterThanOrEqual(7);
    expect(frames.every((frame) => frame.schemaVersion === undefined && Array.isArray(frame.artifacts))).toBeTrue();
    expect(frames.every((frame) => frame.command === 'project build' || frame.command === 'project preview')).toBeTrue();
    const recoveredState = JSON.parse(readFileSync(recovered.paths.state, 'utf8'));
    const finalStop = await stopEnginePreview(game, game, options);
    previews.pop();
    expect(finalStop.stopped).toBeTrue();
    await waitDead(recovered.pid);
    const stderr = readFileSync(recovered.paths.stderr, 'utf8');
    expect(stderr).not.toContain(recoveredState.instanceToken);
    expect(stderr).toContain('[REDACTED]');
  }, 30_000);

  test('never signals a live PID whose authenticated ownership cannot be proven', async () => {
    const game = fixture();
    const first = await startEnginePreview(game, game, { totalDeadlineMs: 10_000, cleanupDeadlineMs: 1_000, carrierPluginRoot: carrierPluginRoot(game) });
    previews.push({ root: game, result: first });
    const state = JSON.parse(readFileSync(first.paths.state, 'utf8'));
    state.instanceToken = '00'.repeat(32);
    writeFileSync(first.paths.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await expect(stopEnginePreview(game, game, { cleanupDeadlineMs: 1_000 })).rejects.toThrow(/preview_ownership_unverified/);
    expect(() => process.kill(first.pid, 0)).not.toThrow();
    process.kill(first.pid, 'SIGTERM');
    await waitDead(first.pid);
    previews.pop();
  }, 15_000);
});
