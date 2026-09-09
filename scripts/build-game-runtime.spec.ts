import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleRuntimeResources,
  runtimeTarget,
  runtimeTargetForMachine,
  sidecarNameForTriple,
} from './lib/runtime-resource-assembler';
import {
  buildRuntimeTarget,
  platformDeclarationSource,
  platformEntrySource,
  runtimeTarArgs,
} from './build-game-runtime';
import { buildGameRuntimeSdk } from './build-game-runtime-sdk';

const fixtures: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-assembler-'));
  fixtures.push(root);
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Game Runtime native target contract', () => {
  test('maps the three approved package targets exactly', () => {
    expect(runtimeTarget('darwin-arm64')).toEqual({
      id: 'darwin-arm64',
      platform: 'darwin',
      arch: 'arm64',
      triple: 'aarch64-apple-darwin',
      runner: 'macos-latest',
      packageDirectory: 'darwin-arm64',
      sidecar: 'bun-aarch64-apple-darwin',
    });
    expect(runtimeTarget('win32-x64').triple).toBe('x86_64-pc-windows-msvc');
    expect(runtimeTarget('win32-x64').sidecar).toEndWith('.exe');
    expect(runtimeTarget('linux-x64').triple).toBe('x86_64-unknown-linux-gnu');
    expect(runtimeTarget('linux-x64').runner).toBe('ubuntu-latest');
    expect(() => runtimeTarget('linux-arm64')).toThrow('unsupported Game Runtime target');
  });

  test('uses the same sidecar naming rule as the desktop assembler', () => {
    expect(sidecarNameForTriple('aarch64-apple-darwin')).toBe('bun-aarch64-apple-darwin');
    expect(sidecarNameForTriple('x86_64-pc-windows-msvc')).toBe('bun-x86_64-pc-windows-msvc.exe');
  });

  test('generates every thin platform entry from one common-only template', () => {
    const entry = platformEntrySource();
    const declarations = platformDeclarationSource();
    expect(entry.match(/createRuntimeDistribution/g)).toHaveLength(2);
    expect(entry).toContain("from '@forgeax/game-runtime-common'");
    expect(entry).not.toMatch(/darwin-arm64|win32-x64|linux-x64/);
    expect(declarations).toContain("GameRuntimeDistribution['ensureRuntime']");
    expect(declarations).toContain("GameRuntimeDistribution['runtimeCacheRoot']");
    expect(declarations).not.toMatch(/darwin-arm64|win32-x64|linux-x64/);
  });

  test('forces Windows drive-letter tar outputs to stay local', () => {
    const args = runtimeTarArgs(
      String.raw`C:\Temp\runtime-inputs.tar`,
      String.raw`C:\Temp\resources`,
      String.raw`C:\Temp\runtime-inputs.txt`,
      'win32',
      ['--owner=0'],
    );
    expect(args).toContain('--force-local');
    expect(runtimeTarArgs('/tmp/runtime.tar', '/tmp/resources', '/tmp/inputs.txt', 'darwin', []))
      .not.toContain('--force-local');
  });
});

describe('Runtime resource assembly', () => {
  test('retains the launch closure while pruning product and authoring payload', () => {
    const root = fixture();
    const source = join(root, 'desktop-resources');
    const destination = join(root, 'runtime-resources');
    const files: Record<string, string> = {
      'engine/vite.config.ts': 'engine',
      'engine/engine-vite-preset.mjs': 'preset',
      'engine/node_modules/@dimforge/runtime.js': 'physics',
      'node_modules/fzstd/index.js': 'codec',
      'node_modules/@bokuweb/zstd-wasm/index.js': 'codec wasm',
      'node_modules/@dimforge/rapier2d-compat/index.js': 'physics 2d',
      'node_modules/@dimforge/rapier3d-compat/index.js': 'physics 3d',
      'interface/dist/studio.js': 'product UI',
      'games/demo/src/main.ts': 'bundled game',
      'marketplace/extensions/video/src/index.ts': 'authoring extension',
      'node_modules/pkg/test/fixture.js': 'test payload',
      'node_modules/pkg/index.js.map': 'source map',
      'node_modules/pkg/bun.lock': 'lock',
      'engine/assets/learn-opengl/demo.bin': 'sample corpus',
      'engine/assets/trailer.mp4': 'media',
    };
    for (const [relative, contents] of Object.entries(files)) {
      const path = join(source, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }

    const result = assembleRuntimeResources({ sourceRoot: source, destinationRoot: destination });

    for (const [retained, contents] of Object.entries({
      'engine/vite.config.ts': 'engine',
      'engine/engine-vite-preset.mjs': 'preset',
      'engine/node_modules/@dimforge/runtime.js': 'physics',
      'engine/node_modules/fzstd/index.js': 'codec',
      'engine/node_modules/@bokuweb/zstd-wasm/index.js': 'codec wasm',
      'engine/node_modules/@dimforge/rapier2d-compat/index.js': 'physics 2d',
      'engine/node_modules/@dimforge/rapier3d-compat/index.js': 'physics 3d',
    })) {
      expect(readFileSync(join(destination, retained), 'utf8')).toBe(contents);
    }
    for (const removed of [
      'interface',
      'games',
      'marketplace/extensions',
      'engine/assets/learn-opengl',
      'engine/assets/trailer.mp4',
    ]) {
      expect(existsSync(join(destination, removed))).toBe(false);
    }
    expect(result.removedEntries).toBeGreaterThanOrEqual(2);
  });

  test('builds the native platform archive, manifest, and generated entry from fixture resources', () => {
    const root = fixture();
    const target = runtimeTargetForMachine();
    const packageRoot = join(root, 'packages/game-runtime', target.packageDirectory);
    const resources = join(root, 'resources');
    const sidecar = join(root, target.sidecar);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '0.3.27' }));
    for (const [relative, contents] of Object.entries({
      'engine/vite.config.ts': 'export default {};',
      'engine/engine-vite-preset.mjs': 'export const preset = {};',
      'node_modules/fzstd/index.js': 'codec',
      'node_modules/@bokuweb/zstd-wasm/index.js': 'codec wasm',
      'node_modules/@dimforge/rapier2d-compat/index.js': 'physics 2d',
      'node_modules/@dimforge/rapier3d-compat/index.js': 'physics 3d',
    })) {
      const path = join(resources, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }
    writeFileSync(sidecar, 'bun');

    const result = buildRuntimeTarget({
      root,
      target,
      resourceRoot: resources,
      sidecarPath: sidecar,
      fromResources: true,
      skipSdk: true,
      engineCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as {
      schemaVersion: number;
      artifacts: Array<{
        version: string;
        platform: string;
        arch: string;
        command: string;
        sha256: string;
        engineCommit: string;
        capabilities: { build: { script: string }; serve: { script: string } };
      }>;
    };
    expect(existsSync(result.archive)).toBe(true);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.artifacts[0]).toMatchObject({
      version: '0.3.27',
      platform: target.platform,
      arch: target.arch,
      command: `bin/${target.sidecar}`,
      engineCommit: '0123456789abcdef0123456789abcdef01234567',
      capabilities: {
        build: { script: 'runtime/preview-build.mjs' },
        serve: { script: 'runtime/preview-serve.mjs' },
      },
    });
    expect(manifest.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(packageRoot, 'dist/index.js'), 'utf8')).toBe(platformEntrySource());
  });

  test('produces the same archive bytes for the same native input twice', () => {
    const root = fixture();
    const target = runtimeTargetForMachine();
    const packageRoot = join(root, 'packages/game-runtime', target.packageDirectory);
    const resources = join(root, 'resources');
    const sidecar = join(root, target.sidecar);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '0.3.27' }));
    for (const [relative, contents] of Object.entries({
      'engine/vite.config.ts': 'export default {};',
      'engine/engine-vite-preset.mjs': 'export const preset = {};',
      'node_modules/fzstd/index.js': 'codec',
      'node_modules/@bokuweb/zstd-wasm/index.js': 'codec wasm',
      'node_modules/@dimforge/rapier2d-compat/index.js': 'physics 2d',
      'node_modules/@dimforge/rapier3d-compat/index.js': 'physics 3d',
    })) {
      const path = join(resources, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }
    writeFileSync(sidecar, 'bun');
    chmodSync(join(resources, 'engine/vite.config.ts'), 0o600);

    const first = buildRuntimeTarget({
      root,
      target,
      resourceRoot: resources,
      sidecarPath: sidecar,
      fromResources: true,
      skipSdk: true,
      engineCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    const firstDigest = createHash('sha256').update(readFileSync(first.archive)).digest('hex');
    chmodSync(join(resources, 'engine/vite.config.ts'), 0o666);
    const second = buildRuntimeTarget({
      root,
      target,
      resourceRoot: resources,
      sidecarPath: sidecar,
      fromResources: true,
      skipSdk: true,
      engineCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    const secondDigest = createHash('sha256').update(readFileSync(second.archive)).digest('hex');
    expect(second.archive).toBe(first.archive);
    expect(secondDigest).toBe(firstDigest);
  });
});

describe('Runtime Engine SDK assembly', () => {
  test('builds declarations without running Engine shared-input producers', () => {
    const source = readFileSync(join(import.meta.dir, 'build-game-runtime-sdk.ts'), 'utf8');
    expect(source).toContain('buildEngineDeclarations');
    expect(source).toContain('ALL_ENGINE_PACKAGES_FILTER');
    expect(source).not.toContain("['scripts/build.mjs', '--engine']");
  });

  test('writes the platform-neutral SDK only to the requested common root', () => {
    const root = fixture();
    const engine = join(root, 'packages/editor/packages/engine');
    const packageRoot = join(engine, 'packages/engine-math-source');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@forgeax/engine-math',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts' } },
    }));
    writeFileSync(join(packageRoot, 'dist/index.d.ts'), "export { vector } from './vector.js';");
    writeFileSync(join(packageRoot, 'dist/vector.d.ts'), 'export declare const vector: true;');
    writeFileSync(join(packageRoot, 'dist/private-fixture.d.ts'), 'export declare const privateFixture: true;');
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/index.ts'), 'export const vector = true;');
    mkdirSync(join(packageRoot, 'src/__tests__'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/__tests__/fixture.test.ts'), "const localPath = '/Users/you/private';");
    mkdirSync(join(packageRoot, 'src/fixtures'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/fixtures/private.ts'), 'export const fixture = true;');
    mkdirSync(join(packageRoot, 'src/snapshots'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/snapshots/private.ts'), 'export const snapshot = true;');
    mkdirSync(join(engine, 'templates/game-default'), { recursive: true });
    writeFileSync(join(engine, 'templates/game-default/main.ts'), 'game');
    mkdirSync(join(engine, 'templates/game-empty'), { recursive: true });
    writeFileSync(join(engine, 'templates/game-empty/main.ts'), 'empty');
    mkdirSync(join(engine, 'skills/forgeax-engine-math'), { recursive: true });
    writeFileSync(join(engine, 'skills/forgeax-engine-math/SKILL.md'), '# Skill');
    const output = join(root, 'common-assets/engine-sdk');

    expect(buildGameRuntimeSdk({ root, output })).toBe(output);
    expect(existsSync(join(output, 'packages/engine-math-source/dist/index.d.ts'))).toBe(true);
    expect(existsSync(join(output, 'packages/engine-math-source/dist/vector.d.ts'))).toBe(true);
    expect(existsSync(join(output, 'packages/engine-math-source/dist/private-fixture.d.ts'))).toBe(false);
    // Mirrored under the Engine's own name so a model starts from a template rather
    // than imitating an "example", and game-empty travels with game-default.
    expect(existsSync(join(output, 'templates/game-default/main.ts'))).toBe(true);
    expect(existsSync(join(output, 'templates/game-empty/main.ts'))).toBe(true);
    expect(existsSync(join(output, 'examples'))).toBe(false);
    expect(existsSync(join(output, 'skills/forgeax-engine-math/SKILL.md'))).toBe(true);
    expect(existsSync(join(output, 'source/engine-math-source/src/index.ts'))).toBe(true);
    expect(existsSync(join(output, 'source/engine-math-source/src/__tests__'))).toBe(false);
    expect(existsSync(join(output, 'source/engine-math-source/src/fixtures'))).toBe(false);
    expect(existsSync(join(output, 'source/engine-math-source/src/snapshots'))).toBe(false);
    expect(existsSync(join(root, 'packages/game-runtime/darwin-arm64/assets/engine-sdk'))).toBe(false);
    expect(JSON.parse(readFileSync(join(output, 'engine-version.json'), 'utf8'))).toMatchObject({
      packageCount: 1,
      packages: ['@forgeax/engine-math'],
      packageDirectories: ['engine-math-source'],
      templates: ['game-default', 'game-empty'],
      skills: ['forgeax-engine-math'],
      sourcePackages: ['engine-math-source'],
    });
    expect(JSON.parse(readFileSync(join(output, 'tsconfig.json'), 'utf8'))).toMatchObject({
      compilerOptions: {
        paths: {
          '@forgeax/engine-math': ['packages/engine-math-source/dist/index.d.ts'],
        },
      },
    });
  });

  test('builds missing Engine declarations before snapshotting the SDK', () => {
    const root = fixture();
    const enginePackage = join(root, 'packages/editor/packages/engine/packages/ecs');
    mkdirSync(join(enginePackage, 'src'), { recursive: true });
    writeFileSync(join(enginePackage, 'package.json'), JSON.stringify({
      name: '@forgeax/engine-ecs',
      types: './dist/index.d.ts',
    }));
    writeFileSync(join(enginePackage, 'src/index.ts'), 'export interface World {}\n');
    const skills = join(root, 'packages/editor/packages/engine/skills/forgeax-engine-ecs');
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, 'SKILL.md'), '# ECS\n');
    for (const name of ['game-default', 'game-empty']) {
      const template = join(root, 'packages/editor/packages/engine/templates', name);
      mkdirSync(template, { recursive: true });
      writeFileSync(join(template, 'main.ts'), name);
    }
    let builds = 0;
    const output = buildGameRuntimeSdk({
      root,
      buildDeclarations: () => {
        builds += 1;
        mkdirSync(join(enginePackage, 'dist'), { recursive: true });
        writeFileSync(join(enginePackage, 'dist/index.d.ts'), 'export interface World {}\n');
      },
    });
    expect(builds).toBe(1);
    expect(existsSync(join(output, 'packages/ecs/dist/index.d.ts'))).toBeTrue();
  });
});
