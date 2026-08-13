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
import { buildRuntimeTarget, platformDeclarationSource, platformEntrySource } from './build-game-runtime';
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
});

describe('Runtime resource assembly', () => {
  test('retains the launch closure while pruning product and authoring payload', () => {
    const root = fixture();
    const source = join(root, 'desktop-resources');
    const destination = join(root, 'runtime-resources');
    const files: Record<string, string> = {
      'runtime/local-runtime.mjs': 'launcher',
      'server/src/main.ts': 'server',
      'engine/vite.config.ts': 'engine',
      'engine/node_modules/@dimforge/runtime.js': 'physics',
      'node_modules/sharp/index.js': 'native image dependency',
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

    for (const retained of [
      'runtime/local-runtime.mjs',
      'server/src/main.ts',
      'engine/vite.config.ts',
      'engine/node_modules/@dimforge/runtime.js',
      'node_modules/sharp/index.js',
    ]) {
      expect(readFileSync(join(destination, retained), 'utf8')).toBe(files[retained]);
    }
    for (const removed of [
      'interface',
      'games',
      'marketplace/extensions',
      'node_modules/pkg/test',
      'node_modules/pkg/index.js.map',
      'node_modules/pkg/bun.lock',
      'engine/assets/learn-opengl',
      'engine/assets/trailer.mp4',
    ]) {
      expect(existsSync(join(destination, removed))).toBe(false);
    }
    expect(result.removedEntries).toBeGreaterThanOrEqual(8);
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
      'runtime/local-runtime.mjs': 'runtime',
      'server/src/main.ts': 'server',
      'engine/vite.config.ts': 'const health = {\n          instanceRootAbs,\n};',
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
    });
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8')) as {
      artifacts: Array<{ version: string; platform: string; arch: string; command: string; sha256: string }>;
    };
    expect(existsSync(result.archive)).toBe(true);
    expect(manifest.artifacts[0]).toMatchObject({
      version: '0.3.27',
      platform: target.platform,
      arch: target.arch,
      command: `bin/${target.sidecar}`,
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
      'runtime/local-runtime.mjs': 'runtime',
      'server/src/main.ts': 'server',
      'engine/vite.config.ts': 'const health = {\n          instanceRootAbs,\n};',
    })) {
      const path = join(resources, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }
    writeFileSync(sidecar, 'bun');
    chmodSync(join(resources, 'runtime/local-runtime.mjs'), 0o600);

    const first = buildRuntimeTarget({
      root,
      target,
      resourceRoot: resources,
      sidecarPath: sidecar,
      fromResources: true,
      skipSdk: true,
    });
    const firstDigest = createHash('sha256').update(readFileSync(first.archive)).digest('hex');
    chmodSync(join(resources, 'runtime/local-runtime.mjs'), 0o666);
    const second = buildRuntimeTarget({
      root,
      target,
      resourceRoot: resources,
      sidecarPath: sidecar,
      fromResources: true,
      skipSdk: true,
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
    const packageRoot = join(engine, 'packages/math');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@forgeax/engine-math' }));
    writeFileSync(join(packageRoot, 'dist/index.d.ts'), 'export declare const vector: true;');
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/index.ts'), 'export const vector = true;');
    mkdirSync(join(packageRoot, 'src/__tests__'), { recursive: true });
    writeFileSync(join(packageRoot, 'src/__tests__/fixture.test.ts'), "const localPath = '/Users/you/private';");
    mkdirSync(join(engine, 'templates/game-default'), { recursive: true });
    writeFileSync(join(engine, 'templates/game-default/main.ts'), 'game');
    mkdirSync(join(engine, 'skills/engine-authoring'), { recursive: true });
    writeFileSync(join(engine, 'skills/engine-authoring/SKILL.md'), '# Skill');
    const output = join(root, 'common-assets/engine-sdk');

    expect(buildGameRuntimeSdk({ root, output })).toBe(output);
    expect(existsSync(join(output, 'packages/math/dist/index.d.ts'))).toBe(true);
    expect(existsSync(join(output, 'examples/game-default/main.ts'))).toBe(true);
    expect(existsSync(join(output, 'skills/engine-authoring/SKILL.md'))).toBe(true);
    expect(existsSync(join(output, 'source/math/src/index.ts'))).toBe(true);
    expect(existsSync(join(output, 'source/math/src/__tests__'))).toBe(false);
    expect(existsSync(join(root, 'packages/game-runtime/darwin-arm64/assets/engine-sdk'))).toBe(false);
  });

  test('builds missing Engine declarations before snapshotting the SDK', () => {
    const root = fixture();
    const enginePackage = join(root, 'packages/editor/packages/engine/packages/ecs');
    mkdirSync(join(enginePackage, 'src'), { recursive: true });
    writeFileSync(join(enginePackage, 'package.json'), JSON.stringify({ name: '@forgeax/engine-ecs' }));
    writeFileSync(join(enginePackage, 'src/index.ts'), 'export interface World {}\n');
    const skills = join(root, 'packages/editor/packages/engine/skills/forgeax-engine-ecs');
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, 'SKILL.md'), '# ECS\n');
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
