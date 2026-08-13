#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineRelativeRoot = join('packages', 'editor', 'packages', 'engine');
const packageFilter = '@forgeax/engine-wgpu-wasm';

export interface EnsureEngineWgpuWasmOptions {
  readonly root?: string;
  readonly engineRoot?: string;
  readonly force?: boolean;
  readonly strict?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function hasWgpuWasm(wgpuRoot: string): boolean {
  return [
    join(wgpuRoot, 'pkg', 'wgpu_wasm.js'),
    join(wgpuRoot, 'pkg', 'wgpu_wasm_bg.wasm'),
  ].every((path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0);
}

function failure(message: string, strict: boolean): boolean {
  if (strict) throw new Error(message);
  console.warn(`⚠ ${message}`);
  return false;
}

function resolveGithubToken(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[key];
    if (value?.trim()) return value.trim();
  }
  if (commandAvailable('gh')) {
    const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout?.trim()) return result.stdout.trim();
  }
  return undefined;
}

/**
 * Ensure the Engine's gitignored wgpu-wasm output exists before any Engine
 * package build imports it. Fetching a content-keyed release asset is the fast
 * path; compiling from source is the deterministic fallback for a missing or
 * stale Engine release asset.
 */
export function ensureEngineWgpuWasm(options: EnsureEngineWgpuWasmOptions = {}): boolean {
  const root = resolve(options.root ?? repositoryRoot);
  const engineRoot = resolve(options.engineRoot ?? join(root, engineRelativeRoot));
  const wgpuRoot = join(engineRoot, 'packages', 'wgpu-wasm');
  const force = options.force ?? false;
  const strict = options.strict ?? false;
  const env = { ...process.env, ...options.env };

  if (!existsSync(wgpuRoot)) {
    return failure(`Engine wgpu-wasm package is missing: ${wgpuRoot}`, strict);
  }
  if (!force && hasWgpuWasm(wgpuRoot)) return true;
  if (!commandAvailable('pnpm')) {
    return failure('pnpm is required to provision Engine wgpu WASM', strict);
  }

  const githubToken = resolveGithubToken(env);
  const fetchEnv = githubToken ? { ...env, GITHUB_TOKEN: githubToken, GH_TOKEN: githubToken } : env;
  console.log(`→ ${packageFilter}: trying prebuilt release (fetch-wasm)…`);
  const fetched = run('pnpm', ['-F', packageFilter, 'fetch-wasm'], engineRoot, fetchEnv);
  if (!fetched) {
    console.log('→ no prebuilt wgpu WASM release asset; compiling from source');
  }
  // When prepare marked an existing output stale, a failed fetch must not turn
  // that old output back into a cache hit; compile the current source instead.
  if (fetched && hasWgpuWasm(wgpuRoot)) return true;

  if (!commandAvailable('rustc') || !commandAvailable('wasm-pack')) {
    return failure(
      'Rust and wasm-pack are required to compile Engine wgpu WASM (install Rust 1.93 and wasm-pack 0.14.0)',
      strict,
    );
  }
  if (commandAvailable('rustup')) {
    const targets = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
    if (!(targets.stdout ?? '').includes('wasm32-unknown-unknown')
      && !run('rustup', ['target', 'add', 'wasm32-unknown-unknown'], engineRoot, env)) {
      return failure('Rust wasm32-unknown-unknown target could not be installed', strict);
    }
  }

  if (!run('pnpm', ['-F', packageFilter, 'build:wasm'], engineRoot, env)) {
    return failure('Engine wgpu WASM compilation failed', strict);
  }
  return hasWgpuWasm(wgpuRoot)
    || failure('Engine wgpu WASM compilation completed without both required pkg outputs', strict);
}

if (import.meta.main) {
  try {
    ensureEngineWgpuWasm({ strict: true });
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
