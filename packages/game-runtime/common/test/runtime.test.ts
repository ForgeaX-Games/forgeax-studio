import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRuntimeLock,
  allocatePort,
  createRuntimeDistribution,
  installRuntime,
  parseRuntimeManifest,
  readInstalledRuntime,
  resolveRuntimeArtifact,
  runtimeEnvironment,
} from '../src/index';

const fixtures: string[] = [];
const machine = { platform: 'darwin' as const, arch: 'arm64' };

function fixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function tarGzipWithPath(path: string, contents: string): Buffer {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - body.length % 512) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Game Runtime common distribution', () => {
  test('uses only explicit platform and common roots', async () => {
    const root = fixture('forgeax-runtime-distribution-');
    const platformRoot = join(root, 'platform');
    const commonRoot = join(root, 'common');
    const cacheRoot = join(root, 'cache');
    const runtimeBytes = 'runtime 0.3.27';
    mkdirSync(join(platformRoot, 'assets'), { recursive: true });
    mkdirSync(join(commonRoot, 'assets', 'engine-sdk'), { recursive: true });
    writeFileSync(join(platformRoot, 'assets', 'runtime.bin'), runtimeBytes);
    writeFileSync(join(platformRoot, 'assets', 'runtime-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      runtimeId: 'forgeax-game-runtime',
      artifacts: [{
        version: '0.3.27',
        platform: 'darwin',
        arch: 'arm64',
        source: './runtime.bin',
        sha256: sha256(runtimeBytes),
        command: 'runtime.bin',
      }],
    }));

    const distribution = createRuntimeDistribution({ platformRoot, commonRoot, cacheRoot, machine });
    expect(distribution.runtimeCacheRoot()).toBe(cacheRoot);
    const installed = await distribution.ensureRuntime();

    expect(installed.version).toBe('0.3.27');
    expect(distribution.engineSdkRoot()).toBe(join(commonRoot, 'assets', 'engine-sdk'));
    expect(installed.root.startsWith(cacheRoot)).toBe(true);
    expect(distribution.loadRuntimeManifest()?.runtimeId).toBe('forgeax-game-runtime');
  });

  test('selects the newest exact-machine manifest artifact', () => {
    const manifest = parseRuntimeManifest({
      schemaVersion: 1,
      runtimeId: 'forgeax-game-runtime',
      artifacts: [
        { version: '1.0.0', platform: 'any', arch: 'any', source: 'old', sha256: 'a'.repeat(64) },
        { version: '1.2.0', platform: 'darwin', arch: 'any', source: 'wrong-arch', sha256: 'c'.repeat(64) },
        { version: '1.2.0', platform: 'darwin', arch: 'arm64', source: 'new', sha256: 'b'.repeat(64) },
      ],
    });
    expect(resolveRuntimeArtifact(manifest, undefined, machine)?.source).toBe('new');
  });

  test('rejects checksum mismatches before publishing readiness', async () => {
    const root = fixture('forgeax-runtime-sha-');
    const sourceRoot = join(root, 'assets');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, 'runtime.bin'), 'wrong bytes');

    await expect(installRuntime(
      { version: '1.0.0', source: './runtime.bin', sha256: sha256('expected'), command: 'runtime.bin' },
      { runtimeId: 'sha-runtime', cacheRoot: join(root, 'cache'), sourceRoot, machine },
    )).rejects.toThrow('checksum mismatch');
    expect(existsSync(join(root, 'cache', 'sha-runtime', '1.0.0', 'darwin-arm64', '.ready.json'))).toBe(false);
  });

  test('rejects a local artifact path that escapes the explicit asset root', async () => {
    const root = fixture('forgeax-runtime-traversal-');
    const sourceRoot = join(root, 'assets');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(root, 'outside.bin'), 'outside');

    await expect(installRuntime(
      { version: '1.0.0', source: '../outside.bin', sha256: sha256('outside'), command: 'outside.bin' },
      { runtimeId: 'unsafe-runtime', cacheRoot: join(root, 'cache'), sourceRoot, machine },
    )).rejects.toThrow('outside the distribution root');
  });

  test('rejects a local artifact symlink that escapes the explicit asset root', async () => {
    const root = fixture('forgeax-runtime-symlink-');
    const sourceRoot = join(root, 'assets');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(root, 'outside.bin'), 'outside');
    symlinkSync(join(root, 'outside.bin'), join(sourceRoot, 'runtime.bin'));

    await expect(installRuntime(
      { version: '1.0.0', source: './runtime.bin', sha256: sha256('outside'), command: 'runtime.bin' },
      { runtimeId: 'symlink-runtime', cacheRoot: join(root, 'cache'), sourceRoot, machine },
    )).rejects.toThrow(/symbolic link|outside the distribution root/);
  });

  test('replaces an archive install tree and keeps only the new payload', async () => {
    const root = fixture('forgeax-runtime-archive-');
    const sourceRoot = join(root, 'assets');
    mkdirSync(sourceRoot, { recursive: true });

    const pack = (name: string, files: Record<string, string>) => {
      const payload = join(root, name);
      mkdirSync(join(payload, 'bin'), { recursive: true });
      for (const [file, contents] of Object.entries(files)) {
        const destination = join(payload, file);
        mkdirSync(join(destination, '..'), { recursive: true });
        writeFileSync(destination, contents);
      }
      const archive = join(sourceRoot, `${name}.tar.gz`);
      expect(spawnSync('tar', ['-czf', archive, '-C', payload, '.']).status).toBe(0);
      return { source: `./${name}.tar.gz`, sha256: sha256(readFileSync(archive)) };
    };
    const cacheRoot = join(root, 'cache');
    const first = pack('first', { 'bin/runtime': 'v1', 'obsolete.bin': 'remove me' });
    const second = pack('second', { 'bin/runtime': 'v2' });
    const options = { runtimeId: 'archive-runtime', cacheRoot, sourceRoot, machine };

    await installRuntime({ version: '1.0.0', ...first, format: 'archive', command: 'bin/runtime' }, options);
    const installed = await installRuntime({ version: '1.0.0', ...second, format: 'archive', command: 'bin/runtime' }, options);

    expect(readFileSync(join(installed.root, 'bin', 'runtime'), 'utf8')).toBe('v2');
    expect(existsSync(join(installed.root, 'obsolete.bin'))).toBe(false);
    expect(installed.artifactPath).toBeUndefined();
    expect(readInstalledRuntime('archive-runtime', '1.0.0', machine, cacheRoot)).toEqual(installed);
  });

  test('rejects archive entries that traverse outside the install root', async () => {
    const root = fixture('forgeax-runtime-unsafe-archive-');
    const sourceRoot = join(root, 'assets');
    const archive = join(sourceRoot, 'unsafe.tar.gz');
    mkdirSync(sourceRoot, { recursive: true });
    const bytes = tarGzipWithPath('../escape', 'escape');
    writeFileSync(archive, bytes);

    await expect(installRuntime(
      { version: '1.0.0', source: './unsafe.tar.gz', sha256: sha256(bytes), format: 'archive', command: 'runtime' },
      { runtimeId: 'unsafe-archive', cacheRoot: join(root, 'cache'), sourceRoot, machine },
    )).rejects.toThrow(/unsafe path|extraction failed/);
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  test('does not hand out an installation lock that is already held', () => {
    const root = fixture('forgeax-runtime-lock-');
    const first = acquireRuntimeLock(root);
    const second = acquireRuntimeLock(root);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    first.release();
    second.release();
  });

  test('passes only the explicit runtime environment allowlist', () => {
    const env = runtimeEnvironment(
      { FORGEAX_SERVER_PORT: '29000', FORGEAX_PROJECT_ROOT: '/tmp/game', SECRET_TOKEN: 'must-not-pass' },
      { PATH: '/bin', SECRET_TOKEN: 'secret' },
    );
    expect(env.PATH).toBe('/bin');
    expect(env.FORGEAX_SERVER_PORT).toBe('29000');
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  test('allocates a loopback port and binds launcher identity', async () => {
    expect(await allocatePort()).toBeGreaterThan(0);
    const root = fixture('forgeax-runtime-launcher-');
    const sourceRoot = join(root, 'assets');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, 'runtime.bin'), 'runtime');
    const distribution = createRuntimeDistribution({
      platformRoot: root,
      commonRoot: join(root, 'common'),
      cacheRoot: join(root, 'cache'),
      machine,
    });
    const installed = await installRuntime(
      { version: '9.0.0', source: './runtime.bin', sha256: sha256('runtime'), command: 'runtime.bin', args: ['--serve'] },
      { runtimeId: 'forgeax-game-runtime', cacheRoot: join(root, 'cache'), sourceRoot, machine },
    );
    const launcher = distribution.launcherForRuntime(installed);
    expect(launcher.runtime).toBe(installed);
    expect(launcher.command).toBe(join(installed.root, 'runtime.bin'));
    expect(launcher.args).toEqual(['--serve']);
    expect(launcher.env.FORGEAX_RUNTIME_VERSION).toBe('9.0.0');
  });

  test('installs the SDK from the explicit common root', () => {
    const root = fixture('forgeax-runtime-sdk-');
    const platformRoot = join(root, 'platform');
    const commonRoot = join(root, 'common');
    const sdkRoot = join(commonRoot, 'assets', 'engine-sdk');
    const projectRoot = join(root, 'project');
    mkdirSync(join(sdkRoot, 'types'), { recursive: true });
    mkdirSync(join(sdkRoot, 'source'), { recursive: true });
    writeFileSync(join(sdkRoot, 'types', 'index.d.ts'), 'export {};');
    writeFileSync(join(sdkRoot, 'source', 'engine.ts'), 'export {};');
    writeFileSync(join(sdkRoot, 'engine-version.json'), JSON.stringify({ engineCommit: 'abc123' }));

    const distribution = createRuntimeDistribution({ platformRoot, commonRoot, machine });
    const result = distribution.installEngineSdk(projectRoot);

    expect(result.changed).toBe(true);
    expect(result.engineCommit).toBe('abc123');
    expect(result.sourceRoot).toBe(join(sdkRoot, 'source'));
    expect(existsSync(join(projectRoot, '.forgeax', 'engine-sdk', 'types', 'index.d.ts'))).toBe(true);

    writeFileSync(join(projectRoot, '.forgeax', 'engine-sdk', 'obsolete.d.ts'), 'stale');
    distribution.installEngineSdk(projectRoot);
    expect(existsSync(join(projectRoot, '.forgeax', 'engine-sdk', 'obsolete.d.ts'))).toBe(false);
  });
});
