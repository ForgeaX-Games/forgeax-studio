import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRuntimeLock, installRuntime, readInstalledRuntime } from '../src/runtime/cache';
import { parseRuntimeManifest, resolveRuntimeArtifact } from '../src/runtime/manifest';
import { launcherForRuntime, resolveInstalledRuntime } from '../src/runtime/manager';
import { allocatePort } from '../src/runtime/ports';
import { runtimeEnvironment } from '../src/runtime/env';

const originalCache = process.env.FORGEAX_RUNTIME_CACHE;
afterEach(() => {
  if (originalCache === undefined) delete process.env.FORGEAX_RUNTIME_CACHE;
  else process.env.FORGEAX_RUNTIME_CACHE = originalCache;
});

describe('runtime manifest and cache', () => {
  test('selects the newest exact machine artifact', () => {
    const manifest = parseRuntimeManifest({
      schemaVersion: 1,
      runtimeId: 'forgeax-game-runtime',
      artifacts: [
        { version: '1.0.0', platform: 'any', arch: 'any', source: '/old', sha256: 'a'.repeat(64) },
        { version: '1.2.0', platform: platform(), arch: arch(), source: '/new', sha256: 'b'.repeat(64) },
      ],
    });
    expect(resolveRuntimeArtifact(manifest)?.version).toBe('1.2.0');
  });

  test('verifies bytes before atomically publishing ready marker', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-runtime-test-'));
    const cache = join(fixture, 'cache');
    const source = join(fixture, 'runtime.bin');
    const bytes = 'verified runtime';
    writeFileSync(source, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const runtime = await installRuntime(
      { version: '1.0.0', source, sha256, command: 'runtime.bin' },
      { runtimeId: 'test-runtime', cacheRoot: cache, machine: { platform: platform(), arch: arch() } },
    );
    expect(readInstalledRuntime('test-runtime', '1.0.0', { platform: platform(), arch: arch() }, cache)).toEqual(runtime);
    expect(existsSync(join(runtime.root, '.ready.json'))).toBeTrue();
    expect(readFileSync(join(runtime.root, '.ready.json'), 'utf8')).toContain('"schemaVersion": 2');
  });

  test('replaces a stale install tree and refuses to reuse different bytes', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-runtime-stale-'));
    const cache = join(fixture, 'cache');
    const sourceRoot = join(fixture, 'assets');
    const dir = join(sourceRoot, 'runtime', 'darwin-arm64');
    mkdirSync(dir, { recursive: true });
    const machine = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64' };

    const pack = (payloadDir: string, name: string): { archive: string; sha256: string } => {
      const archive = join(dir, name);
      expect(spawnSync('tar', ['-czf', archive, '-C', payloadDir, '.']).status).toBe(0);
      return { archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') };
    };

    // A first, "fat" Runtime carrying a file the second one drops.
    const fat = join(fixture, 'fat');
    mkdirSync(join(fat, 'bin'), { recursive: true });
    writeFileSync(join(fat, 'bin', 'entry'), 'v1');
    writeFileSync(join(fat, 'dropped-payload.bin'), 'x'.repeat(4096));
    const first = pack(fat, 'fat.tar.gz');

    const install = (name: string, sha256: string) => installRuntime(
      { version: '1.0.0', platform: 'darwin', arch: 'arm64', source: `./runtime/darwin-arm64/${name}`, sha256, format: 'archive', command: 'bin/entry' },
      { runtimeId: 'stale-runtime', cacheRoot: cache, sourceRoot, machine },
    );

    const before = await install('fat.tar.gz', first.sha256);
    expect(existsSync(join(before.root, 'dropped-payload.bin'))).toBeTrue();

    // A rebuilt Runtime at the SAME version that no longer ships that file.
    const slim = join(fixture, 'slim');
    mkdirSync(join(slim, 'bin'), { recursive: true });
    writeFileSync(join(slim, 'bin', 'entry'), 'v2');
    const second = pack(slim, 'slim.tar.gz');
    const after = await install('slim.tar.gz', second.sha256);

    // Same version must not mean "already installed" when the bytes differ.
    expect(after.sha256).toBe(second.sha256);
    // Extraction must replace, not overlay: tar alone would leave the dropped file.
    expect(existsSync(join(after.root, 'dropped-payload.bin'))).toBeFalse();
    expect(readFileSync(join(after.root, 'bin', 'entry'), 'utf8')).toBe('v2');
  });

  test('does not hand out a held installation lock', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-runtime-lock-'));
    const first = acquireRuntimeLock(fixture);
    const second = acquireRuntimeLock(fixture);
    expect(first.acquired).toBeTrue();
    expect(second.acquired).toBeFalse();
    first.release();
    second.release();
  });

  test('verifies and extracts a bundled Runtime archive from the plugin asset root', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-runtime-archive-'));
    const payload = join(fixture, 'payload');
    const sourceRoot = join(fixture, 'assets');
    const sourceDir = join(sourceRoot, 'runtime', 'darwin-arm64');
    mkdirSync(join(payload, 'bin'), { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(payload, 'bin', 'bun-aarch64-apple-darwin'), 'bun sidecar');
    writeFileSync(join(payload, 'runtime-entry.mjs'), 'runtime');
    const archiveName = 'forgeax-game-runtime.tar.gz';
    const archive = join(sourceDir, archiveName);
    const tar = spawnSync('tar', ['-czf', archive, '-C', payload, '.']);
    expect(tar.status).toBe(0);
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    const runtime = await installRuntime(
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        source: `./runtime/darwin-arm64/${archiveName}`,
        sha256,
        format: 'archive',
        command: 'bin/bun-aarch64-apple-darwin',
        args: ['runtime-entry.mjs'],
      },
      {
        runtimeId: 'archive-runtime',
        cacheRoot: join(fixture, 'cache'),
        sourceRoot,
        machine: { platform: 'darwin', arch: 'arm64' },
      },
    );
    expect(existsSync(join(runtime.root, 'runtime-entry.mjs'))).toBeTrue();
    expect(runtime.command).toBe('bin/bun-aarch64-apple-darwin');
    expect(runtime.args).toEqual(['runtime-entry.mjs']);

    // The archive is dead weight once extracted: keeping it would double the
    // runtime's footprint on the user's disk for the life of the install.
    expect(existsSync(join(runtime.root, archiveName))).toBeFalse();
    expect(runtime.artifactPath).toBeUndefined();

    // Re-reading must not depend on the removed archive, and must not re-hash it.
    const reread = readInstalledRuntime('archive-runtime', '1.0.0', { platform: 'darwin', arch: 'arm64' }, join(fixture, 'cache'));
    expect(reread).toEqual(runtime);

    // A tree that lost its entry point is not ready, even with a valid marker.
    rmSync(join(runtime.root, 'bin', 'bun-aarch64-apple-darwin'), { force: true });
    expect(readInstalledRuntime('archive-runtime', '1.0.0', { platform: 'darwin', arch: 'arm64' }, join(fixture, 'cache'))).toBeUndefined();
  });
});

describe('runtime environment, ports and launcher', () => {
  test('passes only the explicit runtime environment allowlist', () => {
    const env = runtimeEnvironment({ FORGEAX_SERVER_PORT: '29000', FORGEAX_PROJECT_ROOT: '/tmp/game', SECRET_TOKEN: 'must-not-pass' }, {
      ...process.env,
      SECRET_TOKEN: 'secret',
      PATH: '/bin',
    });
    expect(env.FORGEAX_SERVER_PORT).toBe('29000');
    expect(env.FORGEAX_PROJECT_ROOT).toBe('/tmp/game');
    expect(env.PATH).toBe('/bin');
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  test('allocates a loopback port', async () => {
    const port = await allocatePort();
    expect(port).toBeGreaterThan(0);
  });

  test('resolves installed runtime without a Studio checkout', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-runtime-launch-'));
    const source = join(fixture, 'runtime.bin');
    writeFileSync(source, 'runtime');
    const sha256 = createHash('sha256').update('runtime').digest('hex');
    process.env.FORGEAX_RUNTIME_CACHE = join(fixture, 'cache');
    const installed = await installRuntime({ version: '9.0.0', source, sha256, command: 'runtime.bin', args: ['--serve'] });
    const resolved = resolveInstalledRuntime({ cacheRoot: process.env.FORGEAX_RUNTIME_CACHE, runtimeId: 'forgeax-game-runtime' });
    expect(resolved?.version).toBe(installed.version);
    const launcher = launcherForRuntime(installed);
    expect(launcher.command).toBe(join(installed.root, 'runtime.bin'));
    expect(launcher.args).toEqual(['--serve']);
    expect(launcher.env.FORGEAX_RUNTIME_VERSION).toBe('9.0.0');
  });
});
