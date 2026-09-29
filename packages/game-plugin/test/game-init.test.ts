import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyGameWithCarrier,
  resolveGamePluginCarrier,
} from '../src/engine/carrier';
import { ENGINE_COMMIT, ENGINE_VERSION } from '../src/engine/release';
import { resolveProject } from '../src/project/locate';

const roots: string[] = [];

interface FixtureOptions {
  readonly layout?: 'nested' | 'npm-hoisted' | 'pnpm';
  readonly carrierPackage?: 'valid' | 'missing';
  readonly carrierVersion?: string;
  readonly pnpmVersion?: string;
  readonly sdkCli?: 'valid' | 'missing' | 'symlink';
  readonly sdkManifest?: 'valid' | 'mismatch';
  readonly pnpmPackage?: 'valid' | 'missing';
  readonly mode?: 'success' | 'multiline' | 'init-failure' | 'new-failure' | 'invalid-init' | 'invalid-new' | 'prefix-init' | 'suffix-init';
}

interface Fixture {
  readonly root: string;
  readonly pluginRoot: string;
  readonly target: string;
  readonly record: string;
  readonly sdkRoot: string;
  readonly carrierRoot: string;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-game-init-'));
  roots.push(root);
  const target = join(root, 'empty-target');
  const record = join(root, 'carrier-record.jsonl');
  let pluginPackageRoot: string;
  let carrierRoot: string;
  let pnpmRoot: string;
  if (options.layout === 'npm-hoisted') {
    const installRoot = join(root, 'npm-project', 'node_modules');
    pluginPackageRoot = join(installRoot, '@forgeax', 'game');
    carrierRoot = join(installRoot, '@forgeax', 'engine-sdk');
    pnpmRoot = join(installRoot, 'pnpm');
  } else if (options.layout === 'pnpm') {
    const installRoot = join(root, 'pnpm-project', 'node_modules');
    const packageStore = join(installRoot, '.pnpm');
    pluginPackageRoot = join(packageStore, '@forgeax+game@0.3.5', 'node_modules', '@forgeax', 'game');
    carrierRoot = join(packageStore, '@forgeax+engine-sdk@0.3.3', 'node_modules', '@forgeax', 'engine-sdk');
    pnpmRoot = join(packageStore, 'pnpm@11.7.0', 'node_modules', 'pnpm');
  } else {
    const installRoot = join(root, 'nested-project', 'node_modules');
    pluginPackageRoot = join(installRoot, '@forgeax', 'game');
    carrierRoot = join(pluginPackageRoot, 'node_modules', '@forgeax', 'engine-sdk');
    pnpmRoot = join(pluginPackageRoot, 'node_modules', 'pnpm');
  }
  const sdkRoot = join(carrierRoot, 'sdk');
  mkdirSync(target, { recursive: true });
  writeJson(join(pluginPackageRoot, 'package.json'), {
    name: '@forgeax/game',
    version: '0.3.5',
    dependencies: { '@forgeax/engine-sdk': ENGINE_VERSION, pnpm: '11.7.0' },
  });
  if (options.layout === 'pnpm') {
    const pluginModules = join(pluginPackageRoot, 'node_modules', '@forgeax');
    mkdirSync(pluginModules, { recursive: true });
    symlinkSync(relative(pluginModules, carrierRoot), join(pluginModules, 'engine-sdk'));
    const pluginPnpmModules = join(pluginPackageRoot, 'node_modules');
    symlinkSync(relative(pluginPnpmModules, pnpmRoot), join(pluginPnpmModules, 'pnpm'));
  }
  mkdirSync(sdkRoot, { recursive: true });
  writeFileSync(join(sdkRoot, 'record-path.txt'), record);
  if (options.carrierPackage !== 'missing') {
    writeJson(join(carrierRoot, 'package.json'), {
      name: '@forgeax/engine-sdk',
      version: options.carrierVersion ?? ENGINE_VERSION,
    });
  }
  const manifestCommit = options.sdkManifest === 'mismatch' ? '0'.repeat(40) : ENGINE_COMMIT;
  writeJson(join(sdkRoot, 'sdk-manifest.json'), {
    schemaVersion: '1.8.0',
    sdkVersion: ENGINE_VERSION,
    engineCommit: manifestCommit,
    requirements: { pnpm: '11.7.0' },
    packages: [
      { name: '@forgeax/engine', version: ENGINE_VERSION },
      { name: '@forgeax/engine-devkit', version: ENGINE_VERSION },
    ],
  });
  const cli = join(sdkRoot, 'bin', 'forgeax.mjs');
  if (options.sdkCli !== 'missing') {
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      `import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const command = process.argv[3];
const record = (() => { try { return readFileSync(resolve(process.cwd(), 'record-path.txt'), 'utf8').trim(); } catch { return ''; } })();
const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
let nodePathProbe = 'not-found';
try { createRequire(import.meta.url)('hostile-node-path'); nodePathProbe = 'loaded'; } catch {}
if (record) appendFileSync(record, JSON.stringify({ kind: 'sdk', command, args: process.argv.slice(2), cwd: process.cwd(), updateCheck: process.env.FORGEAX_DISABLE_UPDATE_CHECK, sdkRoot: process.env.FORGEAX_SDK_ROOT, nodeOptions: process.env.NODE_OPTIONS, nodePath: process.env.NODE_PATH, pnpmExecPath: process.env.npm_execpath, pnpmNodeExecPath: process.env.npm_node_execpath, registry: process.env.npm_config_registry, path: process.env.PATH, pathHead: process.env.PATH?.split(${JSON.stringify(delimiter)})[0], execPath: process.execPath, pnpmVersion, nodePathProbe }) + '\\n');
const mode = (() => { try { return readFileSync(resolve(process.cwd(), 'mode.txt'), 'utf8').trim(); } catch { return ''; } })();
const success = (value) => process.stdout.write(JSON.stringify(value, null, mode === 'multiline' ? 2 : undefined) + '\\n');
if (command === 'init') {
  if (mode === 'init-failure') { process.stderr.write('fixture init exact failure'); process.exit(17); }
  if (mode === 'invalid-init') { process.stdout.write('not-json\\n'); process.exit(0); }
  const initEnvelope = JSON.stringify({ artifacts: [], command: 'project ' + command, ok: true, value: { sdkVersion: ${JSON.stringify(ENGINE_VERSION)}, engineCommit: ${JSON.stringify(ENGINE_COMMIT)}, pnpm: '11.7.0' } }, null, mode === 'multiline' ? 2 : undefined);
  if (mode === 'prefix-init') { process.stdout.write('diagnostic\\n' + initEnvelope + '\\n'); process.exit(0); }
  if (mode === 'suffix-init') { process.stdout.write(initEnvelope + '\\ndiagnostic\\n'); process.exit(0); }
  process.stdout.write(initEnvelope + '\\n');
} else if (command === 'new') {
  if (mode === 'new-failure') { const target = process.argv[5]; writeFileSync(resolve(target, 'partial.txt'), 'preserve me'); process.stderr.write('fixture new exact failure'); process.exit(19); }
  if (mode === 'invalid-new') { process.stdout.write(JSON.stringify({ artifacts: [], command: 'project ' + command, ok: true, value: {} }) + '\\n'); process.exit(0); }
  const target = process.argv[5];
  mkdirSync(resolve(target, 'src'), { recursive: true });
  writeFileSync(resolve(target, 'forge.json'), JSON.stringify({ id: 'fixture', entry: 'src/main.ts' }) + '\\n');
  writeFileSync(resolve(target, 'package.json'), JSON.stringify({ dependencies: { '@forgeax/engine': ${JSON.stringify(ENGINE_VERSION)} } }) + '\\n');
  writeFileSync(resolve(target, 'src/main.ts'), 'export const fixture = true;\\n');
  success({ artifacts: [], command: 'project ' + command, ok: true, value: { root: target, template: 'empty', sdkVersion: ${JSON.stringify(ENGINE_VERSION)} } });
} else { process.stderr.write('unknown command'); process.exit(2); }
`,
    );
  }
  if (options.sdkCli === 'symlink') {
    const real = join(root, 'outside-cli.mjs');
    writeFileSync(real, readFileSync(cli));
    rmSync(cli);
    // A symlink is intentionally rejected even when its target is inside the fixture.
    symlinkSync(real, cli);
  }

  if (options.pnpmPackage !== 'missing') {
    writeJson(join(pnpmRoot, 'package.json'), {
      name: 'pnpm',
      version: options.pnpmVersion ?? '11.7.0',
      bin: { pnpm: 'bin/pnpm.mjs' },
    });
    mkdirSync(dirname(join(pnpmRoot, 'bin', 'pnpm.mjs')), { recursive: true });
    const pnpmCli = join(pnpmRoot, 'bin', 'pnpm.mjs');
    writeFileSync(pnpmCli, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\nimport { resolve } from 'node:path';\nconst record = (() => { try { return readFileSync(resolve(process.cwd(), 'record-path.txt'), 'utf8').trim(); } catch { return ''; } })();\nif (record) appendFileSync(record, JSON.stringify({ kind: 'pnpm', args: process.argv.slice(2), execPath: process.execPath }) + '\\n');\nprocess.stdout.write(process.argv.includes('--version') ? '11.7.0\\n' : '');\n`);
    chmodSync(pnpmCli, 0o755);
  }
  // The fake CLI reads this file from its SDK root. Keeping it out of the target
  // preserves the empty-target precondition for all bootstrap command tests.
  if (options.mode && options.mode !== 'success') writeFileSync(join(sdkRoot, 'mode.txt'), options.mode);

  return { root, pluginRoot: pluginPackageRoot, target, record, sdkRoot, carrierRoot };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Game Plugin sibling carrier bootstrap', () => {
  test('resolves the sibling carrier and runs init/new with exact argv, cwd, and env', async () => {
    const f = fixture();
    const sdkRootOverride = process.env.FORGEAX_SDK_ROOT;
    const registry = process.env.npm_config_registry;
    process.env.FORGEAX_SDK_ROOT = join(f.root, 'must-not-inherit');
    process.env.npm_config_registry = 'https://registry.example.test/';
    try {
      const result = await createEmptyGameWithCarrier(f.target, { pluginRoot: f.pluginRoot });
      expect(result.created.value).toMatchObject({ root: resolve(f.target), template: 'empty', sdkVersion: ENGINE_VERSION });
      const allRecords = readFileSync(f.record, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      const records = allRecords.filter((entry) => entry.kind === 'sdk');
      const pnpmRecords = allRecords.filter((entry) => entry.kind === 'pnpm');
      expect(records.map((entry) => entry.args)).toEqual([
        ['project', 'init', '--json'],
        ['project', 'new', '--root', resolve(f.target), '--template', 'empty', '--json'],
      ]);
      expect(pnpmRecords).toHaveLength(2);
      expect(pnpmRecords.map((entry) => entry.args)).toEqual([['--version'], ['--version']]);
      expect(pnpmRecords.every((entry) => entry.execPath === process.execPath)).toBeTrue();
      expect(records.every((entry) => entry.cwd === realpathSync(f.sdkRoot))).toBeTrue();
      expect(records.every((entry) => entry.updateCheck === '1')).toBeTrue();
      expect(records.every((entry) => entry.sdkRoot === undefined)).toBeTrue();
      expect(records.every((entry) => entry.registry === 'https://registry.example.test/')).toBeTrue();
      expect(records.every((entry) => entry.pathHead?.includes('forgeax-game-pnpm-'))).toBeTrue();
      expect(existsSync(join(f.target, 'forge.json'))).toBeTrue();
      expect(resolveProject(f.target).root).toBe(resolve(f.target));
    } finally {
      if (sdkRootOverride === undefined) delete process.env.FORGEAX_SDK_ROOT;
      else process.env.FORGEAX_SDK_ROOT = sdkRootOverride;
      if (registry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = registry;
    }
  });

  test('accepts one pretty-printed success envelope spanning multiple lines', async () => {
    const f = fixture({ mode: 'multiline' });
    await expect(createEmptyGameWithCarrier(f.target, { pluginRoot: f.pluginRoot })).resolves.toMatchObject({
      init: { command: 'project init', ok: true },
      created: { command: 'project new', ok: true },
    });
    expect(existsSync(join(f.target, 'forge.json'))).toBeTrue();
  });

  test.each(['npm-hoisted', 'pnpm'] as const)('resolves dependencies from the %s installed layout', (layout) => {
    const f = fixture({ layout });
    const carrier = resolveGamePluginCarrier({ pluginRoot: f.pluginRoot });
    expect(carrier.pluginRoot).toBe(realpathSync(f.pluginRoot));
    expect(carrier.root).toBe(realpathSync(f.carrierRoot));
    expect(carrier.pnpmRoot).toBe(realpathSync(join(f.root, layout === 'pnpm' ? 'pnpm-project' : 'npm-project', 'node_modules', layout === 'pnpm' ? '.pnpm/pnpm@11.7.0/node_modules/pnpm' : 'pnpm')));
  });

  test('rejects a non-empty target before resolving a missing carrier and preserves bytes', async () => {
    const f = fixture();
    const sentinel = join(f.target, 'sentinel.bin');
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 3]));
    await expect(createEmptyGameWithCarrier(f.target, { pluginRoot: join(f.root, 'missing-plugin') })).rejects.toThrow(/project_target_not_empty/);
    expect(readFileSync(sentinel)).toEqual(Buffer.from([0, 1, 2, 3]));
  });

  test('strips hostile node and package-manager overrides and uses the exact shim', async () => {
    const f = fixture();
    const hostileRoot = join(f.root, 'hostile-bin');
    const hostileMarker = join(f.root, 'hostile-marker');
    const hostilePnpm = join(hostileRoot, 'pnpm');
    mkdirSync(hostileRoot, { recursive: true });
    writeFileSync(hostilePnpm, `#!/bin/sh\nprintf hostile > ${JSON.stringify(hostileMarker)}\nexit 99\n`);
    chmodSync(hostilePnpm, 0o755);
    const hostileNodePath = join(f.root, 'hostile-node-path');
    mkdirSync(hostileNodePath, { recursive: true });
    writeFileSync(join(hostileNodePath, 'hostile-node-path.js'), `require('node:fs').writeFileSync(${JSON.stringify(hostileMarker)}, 'node-path'); module.exports = {};\n`);
    const hostileOptions = join(f.root, 'hostile-node-options.cjs');
    writeFileSync(hostileOptions, `require('node:fs').writeFileSync(${JSON.stringify(hostileMarker)}, 'node-options');\n`);
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of [
      ['PATH', hostileRoot],
      ['NODE_OPTIONS', `--require ${hostileOptions}`],
      ['NODE_PATH', hostileNodePath],
      ['FORGEAX_SDK_ROOT', join(f.root, 'hostile-sdk')],
      ['npm_execpath', hostilePnpm],
      ['npm_node_execpath', hostilePnpm],
      ['npm_config_script_shell', hostilePnpm],
    ] as const) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      await createEmptyGameWithCarrier(f.target, { pluginRoot: f.pluginRoot });
      const records = readFileSync(f.record, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      const sdkRecords = records.filter((entry) => entry.kind === 'sdk');
      const pnpmRecords = records.filter((entry) => entry.kind === 'pnpm');
      expect(sdkRecords).toHaveLength(2);
      expect(sdkRecords.every((entry) => entry.nodeOptions === undefined)).toBeTrue();
      expect(sdkRecords.every((entry) => entry.nodePath === undefined)).toBeTrue();
      expect(sdkRecords.every((entry) => entry.pnpmExecPath === undefined)).toBeTrue();
      expect(sdkRecords.every((entry) => entry.pnpmNodeExecPath === undefined)).toBeTrue();
      expect(sdkRecords.every((entry) => !entry.path.includes(hostileRoot))).toBeTrue();
      expect(sdkRecords.every((entry) => entry.execPath === process.execPath)).toBeTrue();
      expect(pnpmRecords.every((entry) => entry.execPath === process.execPath)).toBeTrue();
      expect(existsSync(hostileMarker)).toBeFalse();
      expect(sdkRecords.every((entry) => entry.nodePathProbe === 'not-found')).toBeTrue();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test.each([
    ['carrier missing', { carrierPackage: 'missing' as const }, /engine_sdk_carrier_missing/],
    ['carrier mismatch', { carrierVersion: '0.1.6' }, /engine_sdk_carrier_mismatch/],
    ['SDK manifest mismatch', { sdkManifest: 'mismatch' as const }, /engine_sdk_manifest_mismatch/],
    ['SDK CLI missing', { sdkCli: 'missing' as const }, /engine_sdk_cli_invalid/],
    ['SDK CLI symlink', { sdkCli: 'symlink' as const }, /engine_sdk_cli_invalid/],
    ['pnpm missing', { pnpmPackage: 'missing' as const }, /pnpm_missing/],
    ['pnpm mismatch', { pnpmVersion: '11.8.0' }, /pnpm_version_mismatch/],
  ])('%s fails closed before any carrier command', (_label, options, error) => {
    const f = fixture(options);
    expect(() => resolveGamePluginCarrier({ pluginRoot: f.pluginRoot })).toThrow(error);
    expect(readdirSync(f.target)).toEqual([]);
  });

  test('returns the exact init/new process failure without deleting target artifacts', async () => {
    for (const [mode, code] of [['init-failure', 'engine_sdk_init_failed'], ['new-failure', 'engine_sdk_new_failed']] as const) {
      const f = fixture({ mode });
      await expect(createEmptyGameWithCarrier(f.target, { pluginRoot: f.pluginRoot })).rejects.toThrow(new RegExp(`${code}.*fixture ${mode.split('-')[0]} exact failure`));
      if (mode === 'new-failure') expect(readFileSync(join(f.target, 'partial.txt'), 'utf8')).toBe('preserve me');
      else expect(readdirSync(f.target)).toEqual([]);
    }
  });

  test.each([
    ['invalid-init', /engine_sdk_init_envelope_invalid/],
    ['invalid-new', /engine_sdk_new_identity_mismatch/],
    ['prefix-init', /engine_sdk_init_envelope_invalid/],
    ['suffix-init', /engine_sdk_init_envelope_invalid/],
  ] as const)('rejects a %s success envelope', async (mode, error) => {
    const f = fixture({ mode });
    await expect(createEmptyGameWithCarrier(f.target, { pluginRoot: f.pluginRoot })).rejects.toThrow(error);
  });
});
