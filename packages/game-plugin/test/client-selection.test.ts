import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ENGINE_COMMIT, ENGINE_VERSION } from '../src/engine/release';
import { installTestCarrier } from './carrier-fixture';

/**
 * `--ide` semantics across the project-side commands.
 *
 * Omitting the flag means "hosts that are actually installed". Naming a host that is not
 * installed must say so rather than silently doing nothing, because mounting skills for a
 * host without an MCP entry hands the model instructions naming tools it cannot call.
 *
 * Driven as a subprocess so each case gets its own working directory: changing this
 * process's cwd would leak into every other test file.
 */
const BINARY = resolve(import.meta.dir, '..', 'dist', 'main.js');

function run(args: readonly string[], cwd: string, binaryPath = BINARY) {
  const home = join(cwd, 'home');
  mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, [binaryPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function installedBinary(cwd: string): string {
  const pluginRoot = installTestCarrier(cwd);
  const binary = join(pluginRoot, 'dist', 'main.js');
  mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
  cpSync(BINARY, binary);
  cpSync(join(import.meta.dir, '..', 'assets'), join(pluginRoot, 'assets'), { recursive: true });
  return binary;
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'forgeax-select-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function existingGame(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'forge.json'), `${JSON.stringify({ id: 'existing', entry: 'src/main.ts' })}\n`);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ dependencies: { '@forgeax/engine': ENGINE_VERSION } })}\n`);
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const existing = true;\n');

  const engine = join(dir, 'node_modules', '@forgeax', 'engine');
  mkdirSync(join(engine, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(engine, 'package.json'), `${JSON.stringify({
    name: '@forgeax/engine',
    version: ENGINE_VERSION,
    forgeax: { engineCommit: ENGINE_COMMIT },
  })}\n`);
  writeFileSync(join(engine, 'dist', 'bin', 'forgeax.mjs'), '#!/usr/bin/env node\n');

  const devKit = join(dir, 'node_modules', '@forgeax', 'engine-devkit');
  mkdirSync(devKit, { recursive: true });
  writeFileSync(join(devKit, 'package.json'), `${JSON.stringify({
    name: '@forgeax/engine-devkit',
    version: ENGINE_VERSION,
  })}\n`);
}

describe('client selection', () => {
  test('rejects an unknown client id', () => {
    withDir((dir) => {
      const result = run(['install', '--ide', 'nosuchide'], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/unknown client/i);
      expect(result.output).toContain('zcode');
    });
  });

  test('update refuses when no client is installed', () => {
    withDir((dir) => {
      const result = run(['update'], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/no ForgeaX client configuration/i);
    });
  });

  test('update names the uninstalled client it was asked for', () => {
    withDir((dir) => {
      const result = run(['update', '--ide', 'claude'], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/none of the named clients is installed/i);
    });
  });

  test('init rejects unknown non-empty directories before carrier resolution', () => {
    withDir((dir) => {
      const sentinel = join(dir, 'keep.txt');
      writeFileSync(sentinel, 'keep these bytes\n');
      const result = run(['init'], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/project_target_not_empty/i);
      expect(readFileSync(sentinel, 'utf8')).toBe('keep these bytes\n');
    });
  });

  test('init binds an existing exact Engine game without invoking creation', () => {
    withDir((dir) => {
      existingGame(dir);
      const before = readFileSync(join(dir, 'forge.json'));
      const result = run(['init'], dir, installedBinary(dir));
      expect(result.status).toBe(0);
      expect(result.output).toContain('Bound Engine game existing');
      expect(readFileSync(join(dir, 'forge.json'))).toEqual(before);
      expect(readFileSync(join(dir, 'src', 'main.ts'), 'utf8')).toBe('export const existing = true;\n');
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain(ENGINE_VERSION);
    });
  });
});
