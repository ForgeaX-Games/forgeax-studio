#!/usr/bin/env bun
// One-command Studio worktree bootstrap.
//
// A plain `git worktree add` only creates the superproject checkout. Studio
// also needs its recursive submodule graph, several independent floating Git
// repositories, a dependency install, and an isolated RuntimeInstance. Keep
// those concerns here so every new worktree follows one reproducible path.

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  RUNTIME_INSTANCE_SLOTS,
  readRuntimeInstanceConfig,
  runtimeInstanceConfigPath,
} from './lib/runtime-instance.ts';

const BUN = process.execPath;
const DEFAULT_JOBS = Math.max(2, Math.min(8, availableParallelism()));
const WORKTREE_LOCK = join('.forgeax', 'worktree-bootstrap.lock');
const ROOT_FLOATING_PATHS = new Set(['.forgeax-harness', 'packages/harness', 'packages/games']);
const EDITOR_ENGINE_REQUIRED_PACKAGES = ['vite-plugin-shader', 'app', 'runtime', 'ecs', 'net', 'types', 'shader', 'gltf', 'npc'];
const EDITOR_ENGINE_REQUIRED_ARTIFACTS = ['index.mjs', 'index.d.ts', 'index.d.ts.map'];
const EDITOR_ENGINE_CI_BUILD_FILTERS = ['@forgeax/engine-net...', '@forgeax/engine-net-websocket...'];
const EDITOR_ENGINE_CI_REQUIRED_OUTPUTS = [
  'packages/net/dist/index.mjs',
  'packages/net-websocket/dist/browser.mjs',
  'packages/net-websocket/dist/node.mjs',
];
const EDITOR_ENGINE_REQUIRED_WASM = [
  'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm',
  'packages/fbx/pkg/fbx-wasm.mjs',
  'packages/fbx/pkg/fbx-wasm.wasm',
  'packages/codec/pkg/basis_transcoder.mjs',
  'packages/codec/pkg/basis_transcoder.wasm',
  'packages/codec/pkg/encode/basis_encoder.mjs',
  'packages/codec/pkg/encode/basis_encoder.wasm',
];
const BOOTSTRAP_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10',
};

export type WorktreeOptions = {
  readonly name: string;
  readonly from: string;
  readonly slot?: number;
  readonly isolateUser: boolean;
  readonly envFile?: string;
  readonly noSetup: boolean;
  readonly jobs: number;
};

export type FloatingRepoSpec = {
  readonly relativePath: string;
  readonly sourcePath?: string;
  readonly sourceHead?: string;
  readonly required: boolean;
  readonly syncArgs: readonly string[];
  readonly syncRelativeCwd: string;
};

function gitOutput(args: readonly string[], cwd: string): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitStatus(args: readonly string[], cwd: string): number {
  return spawnSync('git', [...args], { cwd, stdio: 'ignore' }).status ?? 1;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  console.log(`\n[worktree] ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    env,
  });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed${result.status === null ? ' (terminated by signal)' : ` (exit ${result.status ?? 1})`}`);
  }
}

function runAsync(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  console.log(`[worktree] ${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: 'inherit', env });
    child.once('error', (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once('close', (status) => {
      if (status === 0) resolvePromise();
      else reject(new Error(`${label} failed${status === null ? ' (terminated by signal)' : ` (exit ${status})`}`));
    });
  });
}

function repositoryRoot(cwd: string): string {
  const root = gitOutput(['rev-parse', '--show-toplevel'], cwd);
  if (!root) throw new Error('bun fx worktree must run inside a Git checkout');
  return resolve(root);
}

export function parseWorktreeOptions(argv: readonly string[]): WorktreeOptions {
  const name = argv[0] ?? '';
  if (!name || name.startsWith('-')) {
    throw new Error('usage: bun fx worktree <name> [--from REF] [--slot N] [--isolate-user] [--env-file PATH] [--no-setup] [--jobs N]');
  }

  let from = 'HEAD';
  let slot: number | undefined;
  let isolateUser = false;
  let envFile: string | undefined;
  let noSetup = false;
  let jobs = DEFAULT_JOBS;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--no-setup' || arg === '--fast') {
      noSetup = true;
    } else if (arg === '--isolate-user') {
      isolateUser = true;
    } else if (arg === '--from' || arg === '--slot' || arg === '--env-file' || arg === '--jobs') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--from') {
        from = value;
      } else if (arg === '--env-file') {
        envFile = value;
      } else if (arg === '--slot') {
        if (!/^\d+$/.test(value)) throw new Error('--slot must be an integer from 1 to 4');
        slot = Number(value);
      } else {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 32) {
          throw new Error('--jobs must be an integer from 1 to 32');
        }
        jobs = Number(value);
      }
    } else if (arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
      if (!from) throw new Error('--from needs a git ref');
    } else if (arg.startsWith('--slot=')) {
      const value = arg.slice('--slot='.length);
      if (!/^\d+$/.test(value)) throw new Error('--slot must be an integer from 1 to 4');
      slot = Number(value);
    } else if (arg.startsWith('--env-file=')) {
      envFile = arg.slice('--env-file='.length);
      if (!envFile) throw new Error('--env-file needs a path');
    } else if (arg.startsWith('--jobs=')) {
      const value = arg.slice('--jobs='.length);
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 32) {
        throw new Error('--jobs must be an integer from 1 to 32');
      }
      jobs = Number(value);
    } else {
      throw new Error(`unknown worktree flag: ${arg}`);
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/')) {
    throw new Error('worktree name must be a simple git-safe name (letters, numbers, ., _, -, /)');
  }
  if (!from) throw new Error('--from needs a git ref');
  if (slot !== undefined && (slot < 1 || slot > 4)) throw new Error('--slot must be an integer from 1 to 4');
  return { name, from, slot, isolateUser, envFile, noSetup, jobs };
}

export function branchFor(name: string): string {
  return name.startsWith('codex/') ? name : `codex/${name}`;
}

export function directoryFor(name: string): string {
  const slug = name
    .replace(/^codex\//, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('worktree name produces an empty directory name');
  return slug;
}

export function unresolvedSubmodulePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^[-+U][0-9a-f]{7,40}\s+(.+)$/i)?.[1]?.trim() ?? '')
    .map(stripSubmoduleStatusSuffix)
    .filter(Boolean);
}

export function parseSubmoduleStatusPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^[+\-U ]?[0-9a-f]{7,40}\s+(.+)$/i)?.[1]?.trim() ?? '')
    .map(stripSubmoduleStatusSuffix)
    .filter(Boolean);
}

function stripSubmoduleStatusSuffix(path: string): string {
  return path.replace(/\s+\([^)]*\)\s*$/, '').trim();
}

export function submoduleUpdateArgs(jobs: number, fullDepth = false): string[] {
  return [
    'submodule',
    'update',
    '--init',
    '--recursive',
    ...(fullDepth ? [] : ['--depth', '1']),
    '--jobs',
    String(fullDepth ? 1 : jobs),
  ];
}

function submodulePaths(root: string): string[] {
  return parseSubmoduleStatusPaths(gitOutput(['submodule', 'status', '--recursive'], root));
}

function isGitCheckout(path: string): boolean {
  if (!path) return false;
  const topLevel = gitOutput(['rev-parse', '--show-toplevel'], path);
  const head = gitOutput(['rev-parse', '--verify', 'HEAD'], path);
  return Boolean(topLevel && head && resolve(topLevel) === resolve(path));
}

function isHarnessFloatingPath(relativePath: string): boolean {
  return relativePath === '.forgeax-harness' || relativePath.endsWith('/.forgeax-harness');
}

function trackedPathsAtHead(cwd: string): Set<string> {
  return new Set(
    gitOutput(['ls-tree', '-r', '--name-only', 'FETCH_HEAD'], cwd)
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean),
  );
}

function moveOverlayAside(targetPath: string): string {
  const backupPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}-overlay-${process.pid}-${Date.now()}`,
  );
  mkdirSync(backupPath);
  for (const entry of readdirSync(targetPath)) {
    if (entry === '.git') continue;
    renameSync(join(targetPath, entry), join(backupPath, entry));
  }
  return backupPath;
}

function mergeOverlayEntry(
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  trackedPaths: ReadonlySet<string>,
): void {
  const stat = lstatSync(sourcePath);
  if (stat.isDirectory()) {
    mkdirSync(targetPath, { recursive: true });
    for (const entry of readdirSync(sourcePath)) {
      const childRelativePath = relativePath ? join(relativePath, entry) : entry;
      mergeOverlayEntry(
        join(sourcePath, entry),
        join(targetPath, entry),
        childRelativePath,
        trackedPaths,
      );
    }
    if (readdirSync(sourcePath).length === 0) rmSync(sourcePath, { recursive: true, force: true });
    return;
  }

  if (trackedPaths.has(relativePath)) {
    rmSync(sourcePath, { recursive: true, force: true });
    return;
  }

  if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(dirname(targetPath), { recursive: true });
  renameSync(sourcePath, targetPath);
}

function restoreOverlay(backupPath: string, targetPath: string, trackedPaths: ReadonlySet<string>): void {
  for (const entry of readdirSync(backupPath)) {
    mergeOverlayEntry(
      join(backupPath, entry),
      join(targetPath, entry),
      entry,
      trackedPaths,
    );
  }
  rmSync(backupPath, { recursive: true, force: true });
}

function checkoutFloatingRepoWithOverlay(
  targetPath: string,
  relativePath: string,
): void {
  const trackedPaths = trackedPathsAtHead(targetPath);
  const backupPath = moveOverlayAside(targetPath);
  let restored = false;
  try {
    // The overlay may contain copies of files tracked by the floating repo
    // (for example loop state seeded by a checkout hook). Checkout starts from
    // an empty tree, then restores only files that are not part of the pinned
    // source. This preserves install/runtime overlays without allowing stale
    // files to block the pinned floating checkout.
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], targetPath, `checking out harness files for ${relativePath}`);
    restoreOverlay(backupPath, targetPath, trackedPaths);
    restored = true;
  } catch (error) {
    if (existsSync(backupPath)) {
      try {
        restoreOverlay(backupPath, targetPath, new Set());
      } catch {
        console.error(`[worktree] could not restore floating overlay; backup left at ${backupPath}`);
      }
    }
    throw error;
  } finally {
    if (restored && existsSync(backupPath)) rmSync(backupPath, { recursive: true, force: true });
  }
}

function sourceFloatingSpec(
  root: string,
  relativePath: string,
  required: boolean,
  syncArgs: readonly string[],
  syncRelativeCwd = '.',
): FloatingRepoSpec | null {
  const sourcePath = resolve(root, relativePath);
  const syncCwd = resolve(root, syncRelativeCwd);
  if (!isGitCheckout(sourcePath)) {
    if (!existsSync(join(syncCwd, ...syncArgs.slice(0, 1)))) {
      return null;
    }
    return { relativePath, required, syncArgs, syncRelativeCwd };
  }
  const sourceHead = gitOutput(['rev-parse', 'HEAD'], sourcePath);
  return { relativePath, sourcePath, sourceHead, required, syncArgs, syncRelativeCwd };
}

/** Discover the floating repos owned by the current Studio checkout. */
export function discoverFloatingRepos(root: string): FloatingRepoSpec[] {
  const specs = [
    sourceFloatingSpec(root, '.forgeax-harness', false, ['scripts/sync-harness.mjs']),
    sourceFloatingSpec(root, 'packages/harness', true, ['scripts/sync-package-harness.mjs', '--ensure']),
    sourceFloatingSpec(root, 'packages/games', false, ['scripts/sync-games.mjs', '--ensure']),
  ].filter((spec): spec is FloatingRepoSpec => spec !== null);

  for (const submodule of submodulePaths(root)) {
    const relativePath = join(submodule, '.forgeax-harness');
    const spec = sourceFloatingSpec(root, relativePath, false, ['scripts/sync-harness.mjs'], submodule);
    if (spec) specs.push(spec);
  }

  const unique = new Map<string, FloatingRepoSpec>();
  for (const spec of specs) unique.set(spec.relativePath, spec);
  return [...unique.values()];
}

function acquireBootstrapLock(root: string): () => void {
  const lockPath = join(root, WORKTREE_LOCK);
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    } catch {
      // Keep an unreadable lock for a human to inspect rather than guessing.
    }
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error(`another worktree bootstrap is already running (pid ${pid})`);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        unlinkSync(lockPath);
        fd = openSync(lockPath, 'wx');
      }
    } else {
      throw new Error(`worktree bootstrap lock exists at '${lockPath}'; inspect it before retrying`);
    }
  }
  writeSync(fd, `${process.pid}\n`);
  return () => {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // An interrupted cleanup may already have removed the lock.
    }
  };
}

function runtimeConfigPaths(root: string): string[] {
  const paths = [runtimeInstanceConfigPath(root)];
  const worktrees = join(root, '.worktrees');
  if (!existsSync(worktrees)) return paths;
  for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidateRoot = join(worktrees, entry.name);
    const config = runtimeInstanceConfigPath(candidateRoot);
    if (existsSync(config)) paths.push(config);
  }
  return paths;
}

export function reservedRuntimeSlots(root: string): Set<number> {
  const slots = new Set<number>([0]);
  for (const config of runtimeConfigPaths(root)) {
    if (!existsSync(config)) continue;
    slots.add(readRuntimeInstanceConfig(config).slot);
  }
  return slots;
}

function allocateRuntimeSlot(root: string, requested: number | undefined): number {
  const reserved = reservedRuntimeSlots(root);
  if (requested !== undefined) {
    if (reserved.has(requested)) throw new Error(`runtime slot ${requested} is already reserved by another checkout`);
    return requested;
  }
  const slot = RUNTIME_INSTANCE_SLOTS.find((candidate) => candidate > 0 && !reserved.has(candidate));
  if (slot === undefined) throw new Error('no free runtime instance slot (1..4); stop or remove an existing worktree first');
  return slot;
}

async function cloneFloatingRepo(spec: FloatingRepoSpec, sourceRoot: string, targetRoot: string): Promise<void> {
  const targetPath = resolve(targetRoot, spec.relativePath);
  if (existsSync(targetPath) && isGitCheckout(targetPath)) {
    throw new Error(`floating checkout target already exists: ${targetPath}`);
  }

  // The Studio post-checkout hook may seed harness loop state into a fresh
  // worktree before this command runs. Adopt that non-Git overlay in place so
  // loop state survives while the tracked harness files come from the local
  // source checkout. Non-harness non-empty directories remain fail-closed.
  if (existsSync(targetPath) && readdirSync(targetPath).length > 0) {
    if (!isHarnessFloatingPath(spec.relativePath)) {
      throw new Error(`floating checkout target already exists and is non-empty: ${targetPath}`);
    }
    if (spec.sourcePath && spec.sourceHead) {
      await runAsync('git', ['init', '--quiet'], targetPath, `adopting floating repo overlay ${spec.relativePath}`);
      await runAsync('git', ['remote', 'add', 'origin', spec.sourcePath], targetPath, `wiring local origin for ${spec.relativePath}`);
      await runAsync('git', ['fetch', '--quiet', '--no-tags', 'origin', spec.sourceHead], targetPath, `fetching local harness source for ${spec.relativePath}`);
      checkoutFloatingRepoWithOverlay(targetPath, spec.relativePath);
      return;
    }
  }

  if (spec.sourcePath && spec.sourceHead) {
    mkdirSync(dirname(targetPath), { recursive: true });
    await runAsync(
      'git',
      ['clone', '--quiet', '--local', '--no-tags', '--no-checkout', spec.sourcePath, targetPath],
      sourceRoot,
      `cloning floating repo ${spec.relativePath} from the local checkout`,
    );
    run('git', ['checkout', '--detach', spec.sourceHead], targetPath, `pinning floating repo ${spec.relativePath} to ${spec.sourceHead.slice(0, 8)}`);
    return;
  }

  const syncCwd = resolve(targetRoot, spec.syncRelativeCwd);
  await runAsync('node', [...spec.syncArgs], syncCwd, `materializing floating repo ${spec.relativePath} from its origin`);
  if (spec.required && !isGitCheckout(targetPath)) {
    throw new Error(`required floating repo ${spec.relativePath} is unavailable after sync`);
  }
}

async function cloneFloatingRepos(
  specs: readonly FloatingRepoSpec[],
  sourceRoot: string,
  targetRoot: string,
): Promise<void> {
  if (specs.length === 0) return;
  const results = await Promise.allSettled(specs.map((spec) => cloneFloatingRepo(spec, sourceRoot, targetRoot)));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  if (failures.length > 0) throw new Error(`floating repository initialization failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`);
}

function initializeSubmodules(targetRoot: string, jobs: number): void {
  run('git', ['submodule', 'sync', '--recursive'], targetRoot, 'synchronizing recursive submodule URLs', BOOTSTRAP_GIT_ENV);
  const shallow = spawnSync('git', submoduleUpdateArgs(jobs), {
    cwd: targetRoot,
    stdio: 'inherit',
    env: BOOTSTRAP_GIT_ENV,
  });
  if (shallow.status !== 0) {
    console.warn('[worktree] shallow submodule initialization failed; retrying once with full-depth fetch');
    run('git', submoduleUpdateArgs(jobs, true), targetRoot, 'retrying recursive submodule initialization', BOOTSTRAP_GIT_ENV);
  }
  const status = spawnSync('git', ['submodule', 'status', '--recursive'], {
    cwd: targetRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const unresolved = unresolvedSubmodulePaths(String(status.stdout ?? ''));
  if ((status.status ?? 1) !== 0 || unresolved.length > 0) {
    throw new Error(`recursive submodule initialization is incomplete${unresolved.length > 0 ? `: ${unresolved.join(', ')}` : ''}`);
  }
}

function markEditorEngineDistFresh(targetRoot: string): void {
  const engineRoot = join(targetRoot, 'packages', 'editor', 'packages', 'engine');
  const engineHead = gitOutput(['rev-parse', 'HEAD'], engineRoot);
  if (!engineHead) throw new Error(`editor engine checkout is unavailable at ${engineRoot}`);

  const missingCiOutputs = EDITOR_ENGINE_CI_REQUIRED_OUTPUTS
    .filter((relativePath) => !existsSync(join(engineRoot, ...relativePath.split('/'))));
  if (missingCiOutputs.length > 0) {
    run(
      'pnpm',
      [
        ...EDITOR_ENGINE_CI_BUILD_FILTERS.flatMap((filter) => ['--filter', filter]),
        '-r',
        '--sort',
        'build',
      ],
      engineRoot,
      `building editor CI engine packages (${missingCiOutputs.join(', ')})`,
    );
  }

  const required = [
    ...EDITOR_ENGINE_REQUIRED_PACKAGES.flatMap((pkg) => EDITOR_ENGINE_REQUIRED_ARTIFACTS.map((artifact) => join(engineRoot, 'packages', pkg, 'dist', artifact))),
    ...EDITOR_ENGINE_REQUIRED_WASM.map((relativePath) => join(engineRoot, ...relativePath.split('/'))),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`editor engine setup is incomplete; missing artifacts:\n${missing.map((path) => `  - ${path}`).join('\n')}`);
  }

  writeFileSync(join(engineRoot, '.dist-sha'), `${engineHead}\n`);
}

function installDependencies(targetRoot: string, options: WorktreeOptions): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The command already completed this graph with parallel jobs. Avoid the
    // old serial prepare loop and avoid re-fetching local floating clones.
    FORGEAX_SKIP_SUBMODULE_INIT: '1',
    FORGEAX_SKIP_HARNESS_SYNC: '1',
    FORGEAX_SUBMODULE_JOBS: String(options.jobs),
  };
  const args = ['install', '--frozen-lockfile'];
  if (options.noSetup) {
    args.push('--ignore-scripts');
    env.FORGEAX_SKIP_PREPARE = '1';
  } else {
    // The bootstrap must fail while the worktree is still being created if
    // prepare cannot produce the editor CI admission artifacts.
    env.FORGEAX_REQUIRE_COMPLETE_SETUP = '1';
  }
  run(BUN, args, targetRoot, options.noSetup
    ? 'installing Bun dependencies without heavy prepare (--no-setup)'
    : 'installing Bun dependencies and running complete prepare', env);
  if (!options.noSetup) markEditorEngineDistFresh(targetRoot);
}

function initializeRuntime(targetRoot: string, slot: number, options: WorktreeOptions, sourceRoot: string): void {
  const args = [join('scripts', 'fx.ts'), 'instance', 'init', '--slot', String(slot)];
  if (options.isolateUser) args.push('--isolate-user');
  if (options.envFile) args.push('--env-file', resolve(sourceRoot, options.envFile));
  run(BUN, args, targetRoot, `assigning RuntimeInstance slot ${slot}`);
}

function printReady(targetRoot: string, branch: string, slot: number, noSetup: boolean): void {
  console.log(`\n[worktree] ready`);
  console.log(`  path       ${targetRoot}`);
  console.log(`  branch     ${branch}`);
  console.log(`  slot       ${slot}`);
  if (noSetup) console.log('  setup      skipped (--no-setup); run bun fx setup before bun fx start');
  console.log(`\nNext:\n  cd ${targetRoot}\n  bun fx start\n  bun fx status\n\nRemove later with:\n  bun fx stop\n  git worktree remove ${targetRoot}`);
}

export async function createWorktree(argv: readonly string[]): Promise<void> {
  const options = parseWorktreeOptions(argv);
  const sourceRoot = repositoryRoot(process.cwd());
  const branch = branchFor(options.name);
  const targetRoot = join(sourceRoot, '.worktrees', directoryFor(options.name));

  if (existsSync(targetRoot)) throw new Error(`worktree directory already exists: ${targetRoot}`);
  if (gitStatus(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], sourceRoot) === 0) {
    throw new Error(`branch already exists: ${branch} (choose another name)`);
  }
  if (gitStatus(['rev-parse', '--verify', `${options.from}^{commit}`], sourceRoot) !== 0) {
    throw new Error(`git ref does not resolve to a commit: ${options.from}`);
  }

  if (gitOutput(['status', '--porcelain'], sourceRoot)) {
    console.warn('[worktree] source checkout has uncommitted changes; only the selected ref will be copied.');
  }

  const floatingRepos = discoverFloatingRepos(sourceRoot);
  const rootFloating = floatingRepos.filter((spec) => ROOT_FLOATING_PATHS.has(spec.relativePath));
  const sourceFloatingByPath = new Map(floatingRepos.map((spec) => [spec.relativePath, spec]));
  mkdirSync(join(sourceRoot, '.worktrees'), { recursive: true });

  const releaseLock = acquireBootstrapLock(sourceRoot);
  let slot: number;
  try {
    slot = allocateRuntimeSlot(sourceRoot, options.slot);
    // The repository's post-checkout hook materializes submodules itself. That
    // would make this command perform the expensive recursive graph twice, so
    // create the worktree with an empty, target-specific hook directory and let
    // the parallel bootstrap below own initialization exactly once.
    const emptyHooksPath = join(sourceRoot, '.forgeax', 'empty-worktree-hooks');
    mkdirSync(emptyHooksPath, { recursive: true });
    run('git', ['-c', `core.hooksPath=${emptyHooksPath}`, 'worktree', 'add', '-b', branch, targetRoot, options.from], sourceRoot, `creating ${branch}`);
    initializeRuntime(targetRoot, slot, options, sourceRoot);
  } catch (error) {
    releaseLock();
    throw error;
  }
  releaseLock();

  try {
    // Root floating clones do not depend on submodule files, so overlap their
    // local clone work with the recursive graph fetch.
    // Recursive Git initialization mutates the superproject's shared
    // .git/modules metadata. Finish it before local floating clones so these
    // independent operations cannot corrupt each other's Git handles.
    initializeSubmodules(targetRoot, options.jobs);
    await cloneFloatingRepos(rootFloating, sourceRoot, targetRoot);

    // Discover nested floating repos from the newly materialized graph. A
    // fresh source checkout may not have its nested submodules initialized yet,
    // so the source-side discovery cannot be the sole authority here.
    const nestedByPath = new Map<string, FloatingRepoSpec>();
    // Keep source-side discoveries even when the target's fresh submodule
    // checkout has not yet recreated an optional floating repo directory.
    for (const spec of floatingRepos) {
      if (!ROOT_FLOATING_PATHS.has(spec.relativePath)) nestedByPath.set(spec.relativePath, spec);
    }
    // Also include sync-script-backed repos that were not materialized in the
    // source checkout but became discoverable after recursive initialization.
    for (const spec of discoverFloatingRepos(targetRoot)) {
      if (!ROOT_FLOATING_PATHS.has(spec.relativePath)) {
        nestedByPath.set(spec.relativePath, sourceFloatingByPath.get(spec.relativePath) ?? spec);
      }
    }
    await cloneFloatingRepos([...nestedByPath.values()], sourceRoot, targetRoot);
    installDependencies(targetRoot, options);
    printReady(targetRoot, branch, slot, options.noSetup);
  } catch (error) {
    console.error(`[worktree] bootstrap stopped; created worktree remains for inspection: ${targetRoot}`);
    throw error;
  }
}

if (import.meta.main) {
  createWorktree(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[worktree] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
