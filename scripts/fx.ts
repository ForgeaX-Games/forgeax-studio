#!/usr/bin/env bun
// @ts-nocheck
// ForgeaX Studio single TypeScript command entry.
//
// Usage:
//   bun fx <command> [args...]

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseSubmodulePaths } from './lib/repos.ts';
import { packageGitEnvironment } from './lib/package-sync.ts';
import {
  readPackageFiles,
  resolvePackageConfig,
  type PackageEntry,
} from './lib/package-manifest.ts';
import {
  parseRecursiveSubmoduleStatusPaths,
  restoreUpdateRepoStashes,
  stashDirtyUpdateRepos,
  type ManagedUpdateRepo,
  type UpdateRepoStash,
} from './lib/update-repo-stash.ts';
import {
  sourceRuntimePorts,
  sourceRuntimeStatusPorts,
  startSourceRuntime,
  liveRuntimeStateForInstance,
  type ExistingRuntimePolicy,
} from './lib/source-runtime-launcher.ts';
import { listenPids } from './lib/proc.ts';
import type { StopRefusal } from './lib/stop-execution.ts';
import {
  isStartupProfile,
  resolveStartupEnvironment,
  type StartupProfile,
} from './lib/startup-environment.ts';
import {
  resolveRuntimeInstance,
  runtimeInstanceProcessEnv,
} from './lib/runtime-instance.ts';
import {
  missingWorkspacePackageJson,
  readWorkspaceGlobs,
} from './ensure-workspace-submodules.ts';
import { wgpuWasmRoot } from './lib/workspace-paths.ts';
import {
  createRecursiveInputResult,
  isRecursiveInputResult,
  projectGitlinkGraph,
  readAuthoritativeGitGraph,
  validateRecursiveInputResult,
  type InputClass,
  type RecursiveInputResult,
} from '../packages/recursive-input-contract/src/index.ts';
import {
  createRecursiveInputCliDependencies,
  executeRecursiveInputCli,
  createReleaseIntegrityCliDependencies,
  executeReleaseIntegrityCli,
} from '../packages/recursive-input-contract/src/cli.ts';
import { runPublicCommand, PUBLIC_WRAPPER } from './fx/index.ts';


// Re-exported so existing consumers/specs keep one import site; the
// implementation's SSOT is scripts/lib/repos.ts (shared with repos.ts).
export { parseSubmodulePaths };

type ScriptPlan = { type: 'script'; script: string; args: string[] };
type InternalPlan = { type: 'internal'; command: string; args: string[] };
type UnknownPlan = { type: 'unknown'; command: string; args: string[] };
export type CommandPlan = ScriptPlan | InternalPlan | UnknownPlan;

type RunGitOptions = {
  dryRun?: boolean;
  inherit?: boolean;
};

type UpdateResult = {
  repoType: 'root' | 'submodule' | 'floating-repo';
  repo: string;
  result: string;
  detail?: string;
};

type ManagedRestoreResult = {
  path: string;
  repoType: 'submodule' | 'floating-repo';
  ok: boolean;
  detail: string;
};

type StartPort = readonly [name: string, port: number];

const ROOT = process.env.FORGEAX_WORKSPACE_ROOT
  ? resolve(process.env.FORGEAX_WORKSPACE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUN = process.execPath;
const ENGINE_WGPU_ROOT = wgpuWasmRoot(ROOT);

function runReleaseIntegrityRouteBackAdapter(args: string[]) {
  const adapter = spawnSync(BUN, [join(ROOT, 'scripts/mirror/route-back-contract.ts'), ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  return {
    exitCode: adapter.status ?? 1,
    stdout: String(adapter.stdout ?? ''),
    stderr: String(adapter.stderr ?? ''),
  };
}

// Floating checkouts are not visible to `git submodule foreach`, so their
// lifecycle policy must live in one place. `clean: false` protects state that
// may contain unpushed loop work; `clean: true` gives a runtime checkout the
// same scrub semantics as a submodule.
const FLOATING_REPOS = {
  studioLoopState: { path: '.forgeax-harness', clean: false },
  runtimeHarness: { path: 'packages/harness', clean: true },
  runtimeGames: { path: 'packages/games', clean: false },
} as const;

export function cleanableFloatingRepoPaths(): string[] {
  return Object.values(FLOATING_REPOS)
    .filter((repo) => repo.clean)
    .map((repo) => repo.path);
}

export function floatingRepoExclusionArgs(): string[] {
  return Object.values(FLOATING_REPOS).flatMap((repo) => ['-e', repo.path]);
}

function startPorts(): readonly StartPort[] {
  const instance = resolveRuntimeInstance({ root: ROOT });
  return sourceRuntimePorts(resolveStartupEnvironment({
    root: ROOT,
    profile: sourceProfileFromEnvironment(),
    env: lifecycleProcessEnv(process.env, instance),
  }));
}

/**
 * Projects one source-runtime instance onto a lifecycle child. Runtime paths
 * and ports always belong to the instance; an externally managed agent-host
 * socket is the sole explicit override retained from the parent environment.
 */
export function lifecycleProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  instance = resolveRuntimeInstance({ root: ROOT }),
): NodeJS.ProcessEnv {
  const instanceEnv = runtimeInstanceProcessEnv(instance);
  return {
    ...baseEnv,
    ...instanceEnv,
    FORGEAX_AGENT_HOST_SOCK: baseEnv.FORGEAX_AGENT_HOST_SOCK ?? instanceEnv.FORGEAX_AGENT_HOST_SOCK,
  };
}

const script = (name: string): string => resolve(ROOT, 'scripts', name);

const SCRIPT_COMMANDS = new Map<string, string>([
  // dev lifecycle
  ['stop', 'stop.ts'],
  ['open', 'open-web.ts'],
  ['instance', 'instance.ts'],
  ['worktree', 'worktree.ts'],
  ['wt', 'worktree.ts'],
  ['packages', 'packages.ts'],

  // build / metadata helpers
  ['build:plugins', 'build-extensions.ts'],
  ['version', 'lib/version.ts'],

  // CI maintenance: port-anchored recovery of leftover fixed-port heavy samples
  ['recover-fixed-ports', 'recover-fixed-ports.ts'],
]);

// Root commands are a public-command-wrapper over independent repositories.
// They may inspect a mount or public metadata, but never import product source.
const PUBLIC_COMMANDS = new Set(['ide', 'versions', 'teardown']);

// Multi-repo lifecycle commands, all implemented in scripts/repos.ts over one
// shared scan (scripts/lib/repos.ts). `update` stays separate below: update is
// the CONSUMER verb (align worktrees to the recorded pins, detaching), these
// are the DEVELOPER/INTEGRATOR verbs (branches, gates, commits, pin bumps).
const REPO_COMMANDS = new Set(['sync', 'check', 'commit', 'bump']);

const BUILTIN_COMMANDS = new Set([
  // delegates to bun install → prepare lifecycle
  'setup',

  // git update orchestration
  'update',
  'clean',
  'ci',

  // dev lifecycle orchestration
  'start',
  'restart',

  // diagnostics
  'status',
  'doctor',
  'recursive-inputs',
  'release-integrity',

  // compound aliases
  'build',

  // help aliases
  'help',
  '--help',
  '-h',
]);

export function fxCommandCatalog(): {
  public: readonly string[];
  script: readonly string[];
  repository: readonly string[];
  builtin: readonly string[];
} {
  return {
    public: [...PUBLIC_COMMANDS],
    script: [...SCRIPT_COMMANDS.keys()],
    repository: [...REPO_COMMANDS],
    builtin: [...BUILTIN_COMMANDS],
  };
}

export function resolveCommand(argv: string[]): CommandPlan {
  const [cmd = 'help', ...args] = argv;
  if (PUBLIC_COMMANDS.has(cmd)) return { type: 'script', script: script('fx/index.ts'), args: [cmd, ...args] };
  const route = SCRIPT_COMMANDS.get(cmd);
  if (route) return { type: 'script', script: script(route), args };

  // multi-repo lifecycle — thin shells over scripts/lib/repos.ts's single scan
  if (REPO_COMMANDS.has(cmd)) return { type: 'script', script: script('repos.ts'), args: [cmd, ...args] };

  if (cmd === 'build') {
    const [target = 'help', ...rest] = args;
    if (target === 'plugins') return { type: 'script', script: script('build-extensions.ts'), args: rest };
    if (target === 'desktop') return { type: 'script', script: script('fx/index.ts'), args: ['ide', 'build', ...rest] };
    return { type: 'internal', command: 'build', args };
  }

  if (BUILTIN_COMMANDS.has(cmd)) return { type: 'internal', command: cmd, args };
  return { type: 'unknown', command: cmd, args };
}

function usage(): void {
  console.log(`ForgeaX Studio

Usage:
  bun fx <command> [args...]

Common commands:
  setup                 Equivalent to bun install → prepare; records root + submodule setup pins
  update                Pull latest root code, sync submodules, and refresh floating repos if present
  sync [--dry-run]      Dev sync: fetch + ff-only each submodule BRANCH (keeps checkouts)
  clean [--deep|-x]     Restore a fully-clean git status across root,
                        submodules, and managed floating checkouts. Discards
                        uncommitted edits and untracked files, then syncs pins.
                        Gitignored products are kept unless --deep. --dry-run/-n
                        previews. Keeps .forgeax-harness.
                        Stops the Studio stack first; missing git-lfs uses pointer-only checkout.
  instance init --slot N [--isolate-user] [--env-file PATH]
                        Configure this worktree's isolated source-runtime slot
  instance show         Show this worktree's derived runtime contract
  worktree <name> [options]
                        Create a complete isolated worktree: recursive submodules,
                        independent floating repos, dependencies, prepare, and a
                        free RuntimeInstance slot. Options: --from REF, --slot N,
                        --isolate-user, --env-file PATH, --no-setup/--fast, --jobs N.
                        Alias: wt.
  start [args...]        Start the source runtime and wait for HTTP readiness
  stop                  Stop root-owned integration processes
  restart               Stop this checkout's source runtime, then start it again
  ide <command>          Run a public command in packages/ide
  teardown               Report the deterministic root teardown action
  status [--repos]      Show git/submodule/port/artefact status (--repos: full repo table)
  versions              Derived version manifest: pin / branch / nearest tag per submodule
  check [--all]         Run each dirty repo's own gates (lint/test); --all gates everything
  ci                    Run the mounted IDE public CI command plus root integration checks
  commit -m "msg"       Leaf-first multi-repo commit [path...] [--push] [--dry-run] [--no-verify]
  bump <path...>        Advance a clean submodule (fetch+ff) and stage its new pin in root
  recursive-inputs      Materialize, verify, inspect, or discover the recursive input contract
  release-integrity     Discover and verify release candidate integrity without external mutation (schema/status/verify)
  doctor [--fix]        Diagnose common local setup problems
  build plugins         Verify/rebuild product-selected extension package dists
  versions              Print public pin/version metadata as JSON
  version [args...]     Print version info
  recover-fixed-ports [--sample-prefix P] [--cleanup-workspaces]
                        CI-only: clear leftover fixed-port heavy samples by
                        probing the fixed ports directly (port-anchored), then
                        stop + remove generated /tmp sample workspaces

Examples:
  bun install
  bun fx start
  bun fx open
  bun fx update
  bun fx start desktop debug
  bun fx ci
  bun fx sync --dry-run
  bun fx commit -m "fix: adjust dock layout" --push
  bun fx status
`);
}

function runSetup(args: string[]): never {
  const knownLegacy = new Set(['--start', '--no-plugins', '--skip-bootstrap', '--interactive', '-i', '--yes', '-y']);
  const ignored = args.filter((a) => knownLegacy.has(a));
  console.log('→ bun fx setup delegates to: bun install');
  console.log('  (npm prepare lifecycle runs automatically after install)');
  if (ignored.length > 0) console.warn(`\x1b[33m⚠ Ignoring legacy flags: ${ignored.join(' ')}\x1b[0m`);
  const r = spawnSync(BUN, ['install'], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if ((r.status ?? 1) === 0) {
    try {
      const result = writeRecursiveInputResult(ROOT);
      console.log(`[setup] recorded recursive input ${result.status}`);
    } catch (error) {
      console.error(`[setup] could not record recursive input: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  process.exit(r.status ?? 1);
}

const LOCAL_INPUT_CLASSES: InputClass[] = [
  'source',
  'dependency-installation',
  'toolchain',
  'large-file-storage',
];

function recursiveInputResultPath(root: string): string {
  return join(root, '.forgeax', 'recursive-input-result.json');
}

function writeRecursiveInputResult(root: string): RecursiveInputResult {
  const graph = projectGitlinkGraph(readAuthoritativeGitGraph(root));
  const result = createRecursiveInputResult({
    graph,
    producer: 'bun-fx-setup',
    job: 'setup',
    attempt: `setup-${Date.now()}`,
    trustScope: 'local-fixed-worktree',
    requestedInputClasses: LOCAL_INPUT_CLASSES,
    readiness: graph.unreachablePaths.length > 0
      ? { source: { status: 'unavailable' } }
      : undefined,
  });
  mkdirSync(join(root, '.forgeax'), { recursive: true });
  writeFileSync(recursiveInputResultPath(root), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

function readRecursiveInputResult(root: string): unknown {
  try {
    return JSON.parse(readFileSync(recursiveInputResultPath(root), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function checkRecursiveInput(root: string): { ok: boolean; result: RecursiveInputResult } {
  const candidate = readRecursiveInputResult(root);
  const graph = projectGitlinkGraph(readAuthoritativeGitGraph(root));
  const typed = isRecursiveInputResult(candidate) ? candidate : null;
  const requestedInputClasses = typed?.content.requestedInputClasses ?? LOCAL_INPUT_CLASSES;
  return validateRecursiveInputResult(candidate, {
    graph,
    requestedInputClasses,
    trustScope: typed?.provenance.trustScope ?? 'local-fixed-worktree',
    job: typed?.provenance.job ?? 'setup',
    attempt: typed?.provenance.attempt ?? 'missing',
  });
}

function runScript(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): never {
  const r = spawnSync(BUN, [file, ...args], { cwd: ROOT, stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

async function runScriptWithSignals(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  const child = spawn(BUN, [file, ...args], { cwd: ROOT, stdio: 'inherit', env });
  let forwardedSignal: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    forwardedSignal = signal;
    child.kill(signal);
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const status = await new Promise<number>((resolveStatus) => {
    child.once('error', () => resolveStatus(1));
    child.once('exit', (code) => {
      if (code !== null) return resolveStatus(code);
      resolveStatus(forwardedSignal === 'SIGINT' ? 130 : 143);
    });
  });
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.exit(status);
}

function runGit(args: string[], opts: RunGitOptions = {}): string {
  if (opts.dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return '';
  }
  return (
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: opts.inherit ? 'inherit' : 'pipe',
    })?.trim() ?? ''
  );
}

function gitOut(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isDirty(): boolean {
  return gitOut(['status', '--porcelain']) !== '';
}

function updateStashMessage(): string {
  return `forgeax pre-update ${new Date().toISOString()}`;
}

function stashTopOid(): string {
  return gitOut(['rev-parse', '--verify', 'stash@{0}']);
}

export function didCreateStash(before: string, after: string): boolean {
  return after !== '' && after !== before;
}

export function stashPopArgsForRef(ref: string): string[] {
  return ['stash', 'pop', ref];
}

export function updateShouldStash(args: string[]): boolean {
  return !args.includes('--no-stash');
}

export function hasUnmergedStatus(status: string): boolean {
  return status.split(/\r?\n/).some((line) => line.startsWith('u '));
}

function unmergedPaths(): string[] {
  const status = gitOut(['status', '--porcelain=v2', '--untracked-files=no']);
  if (!hasUnmergedStatus(status)) return [];
  return gitOut(['diff', '--name-only', '--diff-filter=U'])
    .split(/\r?\n/)
    .filter(Boolean);
}

export function formatUnmergedUpdateError(paths: string[]): string {
  const files = paths.length > 0 ? paths.join(', ') : 'one or more files';
  return [
    `[update] unresolved merge conflicts detected: ${files}`,
    '[update] resolve and stage those files before retrying bun fx update.',
  ].join('\n');
}

function submodulePaths(): string[] {
  return parseSubmodulePaths(gitOut(['config', '--file', '.gitmodules', '--get-regexp', 'path']));
}

function managedUpdateRepos(): ManagedUpdateRepo[] {
  const repos: ManagedUpdateRepo[] = parseRecursiveSubmoduleStatusPaths(
    gitOut(['submodule', 'status', '--recursive']),
  ).map((path) => ({ path, repoType: 'submodule' as const }));
  for (const { path } of managedFloatingPackageEntries()) {
    if (!existsSync(resolve(ROOT, path))) continue;
    if (!gitOut(['-C', path, 'rev-parse', '--git-dir'])) continue;
    repos.push({ path, repoType: 'floating-repo' });
  }
  return [...new Map(repos.map((repo) => [repo.path, repo])).values()];
}

function managedFloatingPackageEntries(): PackageEntry[] {
  try {
    const files = readPackageFiles(ROOT);
    return resolvePackageConfig(files.base, files.local);
  } catch {
    return [FLOATING_REPOS.runtimeHarness, FLOATING_REPOS.runtimeGames].map((repo) => ({
      path: repo.path,
      url: '',
      branch: 'main',
    }));
  }
}

export function submoduleUpdateArgs(path: string): string[] {
  return ['submodule', 'update', '--init', '--recursive', '--', path];
}

function cleanTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

function colorResult(result: string): string {
  if (result === 'OK') return `\x1b[32m${result}\x1b[0m`;
  if (result === 'FAILED') return `\x1b[31m${result}\x1b[0m`;
  return result;
}

export function formatUpdateReport(rows: UpdateResult[]): string {
  const tableRows = rows.map((row) => [
    row.result.toUpperCase(),
    row.repo,
    row.repoType,
    row.detail ?? '',
  ]);
  const header = ['RESULT', 'REPO', 'REPO TYPE', 'DETAIL'];
  const widths = header.map((title, i) => Math.max(
    title.length,
    ...tableRows.map((row) => cleanTableCell(row[i] ?? '').length),
  ));
  const formatRow = (row: string[], color = false): string => row
    .map((cell, i) => {
      const text = cleanTableCell(cell).padEnd(widths[i]);
      return color && i === 0 ? colorResult(text) : text;
    })
    .join('  ')
    .trimEnd();

  return [
    formatRow(header),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...tableRows.map((row) => formatRow(row, true)),
  ].join('\n');
}

export function mergeManagedRestoreResult(
  rows: UpdateResult[],
  restored: ManagedRestoreResult,
  dryRun: boolean,
): UpdateResult[] {
  const index = rows.findIndex((row) => (
    row.repo === restored.path && row.repoType === restored.repoType
  ));
  const restoreRow: UpdateResult = {
    repoType: restored.repoType,
    repo: restored.path,
    result: dryRun ? 'planned' : restored.ok ? 'ok' : 'failed',
    detail: restored.detail,
  };
  if (index < 0) return [...rows, restoreRow];

  const updated = [...rows];
  const original = updated[index]!;
  updated[index] = {
    ...original,
    result: original.result === 'failed' || restoreRow.result === 'failed'
      ? 'failed'
      : original.result,
    detail: [original.detail, restored.detail].filter(Boolean).join('; '),
  };
  return updated;
}

function runGitUpdateStep(repoType: 'root', repo: string, args: string[], dryRun: boolean, okDetail: string): UpdateResult {
  if (dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return { repoType, repo, result: 'planned', detail: `git ${args.join(' ')}` };
  }
  const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  const status = r.status ?? 1;
  if (status === 0) return { repoType, repo, result: 'ok', detail: okDetail };
  return { repoType, repo, result: 'failed', detail: `git ${args.join(' ')} exited ${status}` };
}

function restoreStashResult(ref: string, dryRun: boolean): UpdateResult {
  const args = stashPopArgsForRef(ref);
  if (dryRun) {
    console.log(`[dry-run] git ${args.join(' ')}`);
    return { repoType: 'root', repo: '.', result: 'planned', detail: `git ${args.join(' ')}` };
  }
  const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  const status = r.status ?? 1;
  if (status === 0) return { repoType: 'root', repo: '.', result: 'ok', detail: 'restored pre-update stash' };
  return { repoType: 'root', repo: '.', result: 'failed', detail: `stash restore exited ${status}` };
}

function updateSubmodules(dryRun: boolean): UpdateResult[] {
  const paths = submodulePaths();
  if (paths.length === 0) {
    return [{ repoType: 'submodule', repo: '(none)', result: 'skipped', detail: 'no submodules configured' }];
  }

  const rows: UpdateResult[] = [];
  for (const path of paths) {
    const args = submoduleUpdateArgs(path);
    if (dryRun) {
      console.log(`[dry-run] git ${args.join(' ')}`);
      rows.push({ repoType: 'submodule', repo: path, result: 'planned', detail: `git ${args.join(' ')}` });
      continue;
    }
    console.log(`[update] submodule ${path}`);
    const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
    const status = r.status ?? 1;
    if (status === 0) rows.push({ repoType: 'submodule', repo: path, result: 'ok', detail: 'synced to recorded commit' });
    else rows.push({ repoType: 'submodule', repo: path, result: 'failed', detail: `git submodule update exited ${status}` });
  }
  return rows;
}

function spawnChild(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolveChild) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env });
    child.once('error', () => resolveChild(1));
    child.once('close', (status) => resolveChild(status ?? 1));
  });
}

export function updateFloatingPackageReportRows(
  entries: Pick<PackageEntry, 'path'>[],
  status: number,
  dryRun: boolean,
): UpdateResult[] {
  if (entries.length === 0) {
    return [{
      repoType: 'floating-repo',
      repo: '.packages',
      result: 'skipped',
      detail: 'no floating packages configured',
    }];
  }
  return entries.map((entry) => ({
    repoType: 'floating-repo',
    repo: entry.path,
    result: status === 0 ? (dryRun ? 'planned' : 'ok') : 'failed',
    detail: status === 0
      ? (dryRun ? 'would update from .packages' : 'updated from .packages')
      : `package update exited ${status}`,
  }));
}

async function updateFloatingPackages(dryRun: boolean): Promise<UpdateResult[]> {
  const args = [script('packages.ts'), 'update'];
  if (dryRun) args.push('--dry-run');
  if (dryRun) console.log(`[dry-run] ${BUN} ${args.join(' ')}`);
  else console.log('[update] floating repos from .packages');
  // Resolve the manifest's canonical HTTPS credentials in the already-loaded
  // parent process. During a self-update the root stash temporarily restores
  // the old package-sync.ts on disk before this child starts.
  const entries = managedFloatingPackageEntries();
  const status = await spawnChild(BUN, args, packageGitEnvironment(ROOT));
  return updateFloatingPackageReportRows(entries, status, dryRun);
}

function currentBranch(): string {
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
}

function upstream(): string {
  return gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

function wgpuWasmPath(): string {
  return resolve(ENGINE_WGPU_ROOT, 'pkg/wgpu_wasm_bg.wasm');
}

function wgpuWasmStatus(): 'missing' | 'stale' | 'fresh' {
  const wasm = wgpuWasmPath();
  if (!existsSync(wasm)) return 'missing';
  const wasmTime = statSync(wasm).mtimeMs;
  const candidates = [
    resolve(ENGINE_WGPU_ROOT, 'Cargo.toml'),
    resolve(ENGINE_WGPU_ROOT, 'Cargo.lock'),
    resolve(ENGINE_WGPU_ROOT, 'pkg/wgpu_wasm.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).mtimeMs > wasmTime) return 'stale';
  }
  return 'fresh';
}

function portOwner(port: number): string {
  try {
    return String(listenPids(port)[0] ?? '');
  } catch {
    return '';
  }
}

export function startBusyPorts(owner: (port: number) => string = portOwner): Array<[string, number, string]> {
  return startPorts()
    .map(([name, port]) => [name, port, owner(port)] as [string, number, string])
    .filter(([, , pid]) => pid !== '');
}

function touchWgpuWasm(): void {
  const wasm = wgpuWasmPath();
  if (!existsSync(wasm)) return;
  const now = new Date();
  utimesSync(wasm, now, now);
}

async function startStudio(
  args: string[],
  existing: ExistingRuntimePolicy = 'error',
): Promise<never> {
  const skipSetupCheck = args.includes('--skip-setup-check');
  const startArgs = args.filter((arg) => arg !== '--skip-setup-check');
  if (!skipSetupCheck) {
    const input = checkRecursiveInput(ROOT);
    if (input.ok) {
      console.log('[start] recursive input result is ready');
    } else {
      const failure = input.result.status === 'non-ready' ? input.result.failure : null;
      console.error(`[start] recursive input is non-ready${failure ? `: ${failure.code}` : ''}; run bun fx setup before starting`);
      if (failure) console.error(`        ${failure.hint}`);
      console.error('[start] bypass once with: bun fx start --skip-setup-check');
      process.exit(1);
    }
  } else {
    console.warn('[start] setup version check skipped');
  }

  const client = resolveStartClient(startArgs);
  if (client.type === 'desktop') {
    await runScriptWithSignals(
      script('fx/index.ts'),
      ['ide', 'desktop', ...client.args],
      lifecycleProcessEnv(),
    );
  }
  if (client.type === 'unknown') {
    console.error(`[start] unknown client: ${client.client}`);
    console.error('[start] usage: bun fx start [web|desktop] [args...]');
    process.exit(2);
  }
  // Floating on purpose: startWeb awaits unified HTTP readiness, then exits.
  return startWeb(client.args, existing);
}

export type StartClientPlan =
  | { type: 'desktop'; args: string[] }
  | { type: 'web'; args: string[] }
  | { type: 'unknown'; client: string; args: string[] };

export function resolveStartClient(args: string[]): StartClientPlan {
  const [maybeMode, ...rest] = args;
  if (maybeMode === 'desktop') return { type: 'desktop', args: rest };
  if (maybeMode === 'web') return { type: 'web', args: rest };
  if (maybeMode && !maybeMode.startsWith('-')) {
    return { type: 'unknown', client: maybeMode, args: rest };
  }
  return { type: 'web', args };
}

async function startWeb(
  runArgs: string[],
  existing: ExistingRuntimePolicy = 'error',
): Promise<never> {
  const ensure = runArgs.includes('--ensure');
  if (runArgs.includes('--no-open')) {
    console.error('[start] --no-open was removed because start never opens a browser; use bun fx open explicitly.');
    process.exit(2);
  }
  const launcherArgs = runArgs.filter((arg) => arg !== '--ensure');
  let startup: ReturnType<typeof resolveStartupEnvironment>;
  try {
    const result = await startSourceRuntime({
      root: ROOT,
      profile: sourceProfileFromEnvironment(),
      existing: existing === 'restart' ? 'restart' : ensure ? 'ensure' : 'error',
      runArgs: launcherArgs,
      approveUnownedStop: existing === 'restart' ? approveUnownedRuntimeStop : undefined,
      // source-runtime-launcher is the sole instance projection authority for
      // start; lifecycleProcessEnv remains for desktop/stop/status children.
      env: process.env,
    });
    startup = result.startup;
    console.log(
      `[start] ${result.reused ? 'reusing' : 'started'} ${startup.profile} launcher pid=${result.launcherPid || '?'}`,
    );
    console.log(`[start] server   http://127.0.0.1:${startup.server.port}`);
    console.log(`[start] UI       ${startup.interface.localOrigin}`);
    console.log(`[start] engine   http://127.0.0.1:${startup.engine.port}`);
  } catch (error) {
    console.error(`[start] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exit(0);
}

async function approveUnownedRuntimeStop(refusals: readonly StopRefusal[]): Promise<boolean> {
  const unique = [...new Map(refusals.map((refusal) => [refusal.pid, refusal])).values()];
  console.error('[restart] the following listener(s) are not owned by this checkout:');
  for (const refusal of unique) {
    console.error(`          pid=${refusal.pid} ${refusal.source} cwd=${refusal.cwd ?? '(unavailable)'}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('[restart] refusing non-interactive termination; rerun in an interactive terminal to confirm');
    return false;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question('[restart] stop these processes and continue? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    prompt.close();
  }
}

function sourceProfileFromEnvironment(): Exclude<StartupProfile, 'desktop-prod'> {
  const profile = process.env.FORGEAX_STARTUP_PROFILE;
  if (profile === undefined) return 'web-dev';
  if (!isStartupProfile(profile) || profile === 'desktop-prod') {
    throw new Error(`bun fx start web requires a source startup profile, got '${profile}'`);
  }
  return profile;
}

function status(): void {
  const instance = resolveRuntimeInstance({ root: ROOT });
  const startup = resolveStartupEnvironment({
    root: ROOT,
    profile: sourceProfileFromEnvironment(),
    env: lifecycleProcessEnv(process.env, instance),
  });
  console.log('ForgeaX Studio status');
  console.log(`root: ${ROOT}`);
  console.log(`instance: ${instance.id} slot=${instance.slot}`);
  console.log(`branch: ${currentBranch()}`);
  const up = upstream();
  console.log(`upstream: ${up || '(none)'}`);
  if (up) {
    const counts = gitOut(['rev-list', '--left-right', '--count', `HEAD...${up}`]).split(/\s+/);
    console.log(`state: ahead=${counts[0] ?? '?'} behind=${counts[1] ?? '?'}`);
  }
  console.log(`dirty: ${isDirty() ? 'yes' : 'no'}`);
  console.log(`wgpu-wasm: ${wgpuWasmStatus()}`);
  const runtime = liveRuntimeStateForInstance(instance);
  console.log(
    `runtime: ${runtime ? `${runtime.status} profile=${runtime.profile} launcher=${runtime.launcherPid}` : 'stopped'}`,
  );
  if (runtime?.error) console.log(`runtime error: ${runtime.error}`);
  console.log();
  console.log('ports:');
  for (const [name, port] of sourceRuntimeStatusPorts(startup)) {
    const pid = portOwner(port);
    console.log(`  ${name.padEnd(9)} :${port} ${pid ? `listening pid=${pid}` : 'free'}`);
  }
  console.log();
  console.log('commands: bun install | bun fx update | sync | start [web|desktop] | stop | status [--repos] | versions | check | commit | bump | build desktop | doctor');
}

function doctor(args: string[]): never {
  const fix = args.includes('--fix');
  const required = ['git', 'bun', 'node', 'pnpm'];
  let failed = 0;
  for (const bin of required) {
    const ok = Bun.which(bin) !== null;
    console.log(`${ok ? '[ok]' : '[missing]'} ${bin}`);
    if (!ok) failed++;
  }
  const envFile = resolve(ROOT, '.env');
  console.log(`${existsSync(envFile) ? '[ok]' : '[warn]'} .env${existsSync(envFile) ? '' : ' missing'}`);
  const wasm = wgpuWasmStatus();
  console.log(`${wasm === 'fresh' ? '[ok]' : '[warn]'} wgpu-wasm ${wasm}`);
  if (fix && wasm !== 'missing') {
    touchWgpuWasm();
    console.log('[ok] touched wgpu-wasm artefact');
  }

  // Detect the post-pull empty-submodule footgun before bun install does.
  try {
    const pkgText = readFileSync(resolve(ROOT, 'package.json'), 'utf8');
    const missing = missingWorkspacePackageJson(ROOT, readWorkspaceGlobs(pkgText));
    if (missing.length === 0) {
      console.log('[ok] workspace submodule package.json present');
    } else {
      console.log(`[missing] workspace package.json: ${missing.join(', ')}`);
      console.log('         → bun fx clean && bun install');
      failed++;
      if (fix) {
        console.log('[fix] running bun fx clean …');
        const r = spawnSync(BUN, [fileURLToPath(import.meta.url), 'clean'], {
          cwd: ROOT,
          stdio: 'inherit',
          env: process.env,
        });
        if ((r.status ?? 1) === 0) {
          console.log('[ok] cleaned; re-check workspaces after bun install');
          failed = Math.max(0, failed - 1);
        }
      }
    }
  } catch (e) {
    console.log(`[warn] workspace check skipped: ${(e as Error).message}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

async function update(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const stash = updateShouldStash(args);
  const restart = args.includes('--restart');
  let stashedMessage = '';
  let managedStashes: UpdateRepoStash[] = [];
  let results: UpdateResult[] = [];

  const conflicts = unmergedPaths();
  if (conflicts.length > 0) {
    console.error(formatUnmergedUpdateError(conflicts));
    process.exit(2);
  }

  console.log('[update] Checking working tree');
  if (stash) {
    try {
      managedStashes = stashDirtyUpdateRepos(ROOT, managedUpdateRepos(), updateStashMessage(), dryRun);
      for (const repo of managedStashes) {
        console.log(`${dryRun ? '[dry-run]' : '[update]'} stashed ${repo.path}`);
      }
    } catch (error) {
      console.error(`[update] unable to preserve managed repository changes: ${
        error instanceof Error ? error.message : String(error)
      }`);
      process.exit(2);
    }
  }
  if (isDirty()) {
    if (!stash) {
      console.error('[update] local changes detected; remove --no-stash or clean the worktree first.');
      process.exit(2);
    }
    const stashBefore = dryRun ? '' : stashTopOid();
    stashedMessage = updateStashMessage();
    try {
      runGit(['stash', 'push', '-u', '-m', stashedMessage], { dryRun, inherit: true });
    } catch (error) {
      restoreUpdateRepoStashes(ROOT, managedStashes, dryRun);
      console.error(`[update] root stash failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    const stashAfter = dryRun ? `stash^{/${stashedMessage}}` : stashTopOid();
    if (didCreateStash(stashBefore, stashAfter)) {
      stashedMessage = dryRun ? stashAfter : 'stash@{0}';
    } else {
      console.log('[update] no root stash was created; leaving submodule-only changes in place');
      stashedMessage = '';
    }
  } else {
    console.log('[update] working tree clean');
  }

  console.log(`[update] Updating ${currentBranch()}`);
  const up = upstream();
  if (up) {
    results.push(runGitUpdateStep('root', '.', ['pull', '--ff-only', '--no-recurse-submodules'], dryRun, 'pulled latest root code'));
  } else {
    console.log('[update] no upstream; fetching origin/main and rebasing current branch');
    const fetchResult = runGitUpdateStep('root', '.', ['fetch', '--no-recurse-submodules', 'origin', 'main'], dryRun, 'fetched origin/main');
    results.push(fetchResult);
    if (fetchResult.result !== 'failed') {
      results.push(runGitUpdateStep('root', '.', ['rebase', 'origin/main'], dryRun, 'rebased onto origin/main'));
    }
  }

  const rootOk = !results.some((row) => row.repoType === 'root' && row.result === 'failed');
  if (rootOk) {
    if (!dryRun) dropStaleSubmoduleConfig();
    results.push(...await updateFloatingPackages(dryRun));
    console.log('[update] Updating submodules');
    results.push(...updateSubmodules(dryRun));
  } else {
    results.push({ repoType: 'submodule', repo: '(all)', result: 'skipped', detail: 'root update failed' });
  }

  if (stashedMessage) {
    console.log('[update] Restoring pre-update stash');
    results.push(restoreStashResult(stashedMessage, dryRun));
  }
  if (managedStashes.length > 0) {
    console.log('[update] Restoring managed repository stashes');
    for (const restored of restoreUpdateRepoStashes(ROOT, managedStashes, dryRun)) {
      results = mergeManagedRestoreResult(results, restored, dryRun);
    }
  }

  console.log();
  console.log('[update] result report');
  console.log(formatUpdateReport(results));

  if (results.some((row) => row.result === 'failed')) {
    console.error('[update] one or more repositories failed to update; see report above');
    process.exit(1);
  }

  if (restart) {
    await restartAfterUpdate(dryRun);
  } else {
    console.log('[update] done (use --restart to restart the stack)');
  }
}

export async function restartAfterUpdate(
  dryRun: boolean,
  start: (args: string[], existing: ExistingRuntimePolicy) => Promise<void> = startStudio,
): Promise<void> {
  if (dryRun) {
    console.log('[dry-run] bun fx restart');
    return;
  }
  await start([], 'restart');
}

export type LifecycleCommandDependencies = {
  setup(args: string[]): void;
  start(args: string[], existing: ExistingRuntimePolicy): Promise<void>;
  update(args: string[]): Promise<void>;
};

export async function dispatchLifecycleCommand(
  command: string,
  args: string[],
  dependencies: LifecycleCommandDependencies = {
    setup: runSetup,
    start: startStudio,
    update,
  },
): Promise<boolean> {
  switch (command) {
    case 'setup':
      dependencies.setup(args);
      return true;
    case 'start':
      await dependencies.start(args, 'error');
      return true;
    case 'restart':
      await dependencies.start(args, 'restart');
      return true;
    case 'update':
      await dependencies.update(args);
      return true;
    default:
      return false;
  }
}

const LOCAL_CI_GAME_API_PORT = 'FORGEAX_GAME_API_PORT' as const;
const LOCAL_CI_GAME_API_DEFAULT = 15_281;

export function localCiEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const instance = resolveRuntimeInstance({ root: ROOT });
  const e2eHost = instance.ports.interface + 100;
  const e2eApi = instance.ports.server + 100;
  const e2eEngine = instance.ports.engine + 100;
  // Editor B2 starts its own game-backend in addition to the E2E web
  // projection. Keep that fixed default in the same reservation pass so a
  // developer's standalone editor cannot poison local Studio CI.
  return {
    ...baseEnv,
    CI: '1',
    // The editor Playwright projection must never reuse a running Studio or
    // another checkout's standalone stack. Keep its four web-server pairs in
    // a slot-derived, separate port block while still allowing explicit CI
    // overrides for runners that reserve their own ports.
    FORGEAX_GAME_API_PORT: baseEnv[LOCAL_CI_GAME_API_PORT] ?? String(LOCAL_CI_GAME_API_DEFAULT),
    FORGEAX_E2E_PORT: baseEnv.FORGEAX_E2E_PORT ?? String(e2eHost),
    FORGEAX_E2E_EDIT_PORT: baseEnv.FORGEAX_E2E_EDIT_PORT ?? String(e2eHost + 1),
    FORGEAX_E2E_API_PORT: baseEnv.FORGEAX_E2E_API_PORT ?? String(e2eApi),
    FORGEAX_E2E_ENGINE_PORT: baseEnv.FORGEAX_E2E_ENGINE_PORT ?? String(e2eEngine),
    FORGEAX_E2E_TEMPLATE_PORT: baseEnv.FORGEAX_E2E_TEMPLATE_PORT ?? String(e2eHost + 2),
    FORGEAX_E2E_TEMPLATE_EDIT_PORT: baseEnv.FORGEAX_E2E_TEMPLATE_EDIT_PORT ?? String(e2eHost + 3),
    FORGEAX_E2E_TEMPLATE_API_PORT: baseEnv.FORGEAX_E2E_TEMPLATE_API_PORT ?? String(e2eApi + 2),
    FORGEAX_E2E_TEMPLATE_ENGINE_PORT: baseEnv.FORGEAX_E2E_TEMPLATE_ENGINE_PORT ?? String(e2eEngine + 2),
    FORGEAX_E2E_BRIDGE_PORT: baseEnv.FORGEAX_E2E_BRIDGE_PORT ?? String(e2eHost + 6),
    FORGEAX_E2E_TEMPLATE_BRIDGE_PORT: baseEnv.FORGEAX_E2E_TEMPLATE_BRIDGE_PORT ?? String(e2eHost + 8),
  };
}

// Keep the editor-specific projection named at the CI boundary. The actual
// defaults come from the shared RuntimeInstance projection above; the final
// reserveLocalCiE2ePorts pass may move the whole block when a transient local
// socket makes the first candidate unavailable.
function editorCiEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return localCiEnvironment(baseEnv);
}

const LOCAL_CI_E2E_PORT_KEYS = [
  'FORGEAX_E2E_PORT',
  'FORGEAX_E2E_EDIT_PORT',
  'FORGEAX_E2E_API_PORT',
  'FORGEAX_E2E_ENGINE_PORT',
  'FORGEAX_E2E_TEMPLATE_PORT',
  'FORGEAX_E2E_TEMPLATE_EDIT_PORT',
  'FORGEAX_E2E_TEMPLATE_API_PORT',
  'FORGEAX_E2E_TEMPLATE_ENGINE_PORT',
  'FORGEAX_E2E_BRIDGE_PORT',
  'FORGEAX_E2E_TEMPLATE_BRIDGE_PORT',
] as const;

const LOCAL_CI_PORT_KEYS = [...LOCAL_CI_E2E_PORT_KEYS, LOCAL_CI_GAME_API_PORT] as const;
type LocalCiPortKey = (typeof LOCAL_CI_PORT_KEYS)[number];

function probeCiPort(port: number): Promise<ReturnType<typeof createServer> | null> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    let settled = false;
    const finish = (reserved: boolean): void => {
      if (settled) return;
      settled = true;
      resolveProbe(reserved ? server : null);
    };
    server.once('error', () => {
      try { server.close(); } catch { /* already closed */ }
      finish(false);
    });
    // Vite binds wildcard, so probe the same address. This catches not only
    // LISTEN sockets but also outbound connections (for example a VPN can
    // temporarily own a local ephemeral port that Vite cannot bind).
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => finish(true));
  });
}

/**
 * Reserve the editor smoke block immediately before launching its child CI.
 * Runtime-instance ports are stable for human services, but a long-lived
 * process can still occupy one of the derived E2E ports as an outbound local
 * socket between worktree creation and CI. Probe-and-release at the last
 * possible moment and move the whole default block when necessary.
 */
async function reserveLocalCiE2ePorts(
  projectedEnv: NodeJS.ProcessEnv,
  inheritedEnv: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; release: () => Promise<void>; offset: number }> {
  const instance = resolveRuntimeInstance({ root: ROOT });
  const hasExplicitPorts = LOCAL_CI_PORT_KEYS.some((key) => inheritedEnv[key] !== undefined);
  const offsets = hasExplicitPorts
    ? [0]
    : Array.from({ length: 100 }, (_, index) => index * 100);

  for (const offset of offsets) {
    const candidate: NodeJS.ProcessEnv = { ...projectedEnv };
    if (!hasExplicitPorts && offset !== 0) {
      const e2eHost = instance.ports.interface + 100 + offset;
      const e2eApi = instance.ports.server + 100 + offset;
      const e2eEngine = instance.ports.engine + 100 + offset;
      const defaults: Record<LocalCiPortKey, string> = {
        FORGEAX_GAME_API_PORT: String(LOCAL_CI_GAME_API_DEFAULT + offset),
        FORGEAX_E2E_PORT: String(e2eHost),
        FORGEAX_E2E_EDIT_PORT: String(e2eHost + 1),
        FORGEAX_E2E_API_PORT: String(e2eApi),
        FORGEAX_E2E_ENGINE_PORT: String(e2eEngine),
        FORGEAX_E2E_TEMPLATE_PORT: String(e2eHost + 2),
        FORGEAX_E2E_TEMPLATE_EDIT_PORT: String(e2eHost + 3),
        FORGEAX_E2E_TEMPLATE_API_PORT: String(e2eApi + 2),
        FORGEAX_E2E_TEMPLATE_ENGINE_PORT: String(e2eEngine + 2),
        FORGEAX_E2E_BRIDGE_PORT: String(e2eHost + 6),
        FORGEAX_E2E_TEMPLATE_BRIDGE_PORT: String(e2eHost + 8),
      };
      for (const key of LOCAL_CI_PORT_KEYS) candidate[key] = defaults[key];
    }

    const ports = [...new Set(LOCAL_CI_PORT_KEYS.map((key) => Number(candidate[key])))];
    if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)) {
      throw new Error('[ci] editor E2E port environment contains an invalid port');
    }

    const reservations: Array<ReturnType<typeof createServer>> = [];
    let available = true;
    for (const port of ports) {
      const reservation = await probeCiPort(port);
      if (reservation === null) {
        available = false;
        break;
      }
      reservations.push(reservation);
    }
    if (!available) {
      await Promise.all(reservations.map((reservation) => new Promise<void>((resolveClose) => {
        reservation.close(() => resolveClose());
      })));
      continue;
    }

    let released = false;
    return {
      env: candidate,
      offset,
      release: async () => {
        if (released) return;
        released = true;
        await Promise.all(reservations.map((reservation) => new Promise<void>((resolveClose) => {
          reservation.close(() => resolveClose());
        })));
      },
    };
  }

  const hint = hasExplicitPorts
    ? 'explicit FORGEAX_E2E_* ports are busy; choose a complete free port block'
    : 'no free editor E2E port block found';
  throw new Error(`[ci] ${hint}`);
}

// Local PR gate for the Studio integration workspace. Product execution and
// engine/editor builds belong to the independently checked-out IDE; this gate
// validates root-owned contracts, public wrappers, and then delegates the IDE
// leaf's own public CI command.
async function ci(args: string[]): Promise<never> {
  if (args.length > 0) {
    console.error('usage: bun fx ci');
    process.exit(2);
  }
  const ciEnv = editorCiEnvironment({
    ...process.env,
    // Match the non-interactive CI setup while keeping prepare-time skill
    // installation and optional game checkout outside this local projection.
    // CI also disables Playwright's reuseExistingServer path. The private
    // projection ports below keep a running developer stack out of the gate.
    CI: process.env.CI ?? 'true',
    FORGEAX_SKIP_HARNESS: '1',
    FORGEAX_SKIP_GAMES: '1',
    FORGEAX_SKIP_BOOTSTRAP: '1',
    FORGEAX_SKIP_SUBMODULE_INIT: '1',
    FORGEAX_ROOT_INTEGRATION_ONLY: '1',
    FORGEAX_SKIP_PLUGINS: '1',
  });
  const steps: readonly [string, string, string[], string][] = [
    ['root frozen Bun install + integration prepare', BUN, ['install', '--frozen-lockfile'], ROOT],
    ['root layer gate', BUN, ['run', 'lint:layers'], ROOT],
    ['root integration tests', BUN, ['run', 'test:layers'], ROOT],
    ['required-checks ruleset audit', BUN, ['scripts/ci/audit-required-checks-ruleset.mjs'], ROOT],
    ['bun fx command contract', BUN, ['test', './scripts/fx-ci-contract.test.ts'], ROOT],
    ['root cutover contract', BUN, ['test', './scripts/cutover/root-cutover.spec.ts', './scripts/check-root-runtime-exit.spec.ts'], ROOT],
    ['public wrapper discovery', BUN, ['scripts/fx.ts', 'versions'], ROOT],
  ];
  for (const [name, command, argv, cwd] of steps) {
    console.log(`\n[ci] ${name}`);
    const result = spawnSync(command, argv, { cwd, stdio: 'inherit', env: ciEnv });
    if ((result.status ?? 1) !== 0) {
      console.error(`[ci] FAIL: ${name}`);
      process.exit(result.status ?? 1);
    }
  }

  console.log('\n[ci] IDE public CI');
  const ideResult = spawnSync(BUN, [script('fx.ts'), 'ide', 'ci'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: ciEnv,
  });
  if ((ideResult.status ?? 1) !== 0) {
    console.error('[ci] FAIL: IDE public CI');
    process.exit(ideResult.status ?? 1);
  }
  console.log('\n[ci] PASS: local Studio integration CI');
  process.exit(0);
}

// ── clean ──────────────────────────────────────────────────────────────────
// Restore the working tree to a fully-clean `git status`, recursively across the
// root repo, every submodule (incl. the editor→engine nesting), and every
// cleanable floating checkout.
//
// Standard clean respects .gitignore everywhere, including submodules, so local
// dependencies and build products survive. `--deep`/-x opts the entire workspace
// into deleting ignored content too (wipe node_modules/dist/.env; re-run bun
// install after). `--dry-run`/-n previews without deleting.
// Floating checkout policy is defined by FLOATING_REPOS. `.forgeax-harness`
// remains preserved because it holds unpushed closed-loop state.
//
// NOTE: this function discards ALL uncommitted work (git reset --hard). Commit
// anything worth keeping — including edits to this very file — before running it.
export function cleanTreeFlags(deep: boolean, dryRun: boolean): string {
  return `-ff${dryRun ? 'n' : ''}d${deep ? 'x' : ''}`;
}

export type CleanLockAction = 'none' | 'remove' | 'plan-remove' | 'block';

export function cleanLockAction(lockExists: boolean, activeGitProcess: boolean, dryRun: boolean): CleanLockAction {
  if (!lockExists) return 'none';
  if (activeGitProcess) return 'block';
  return dryRun ? 'plan-remove' : 'remove';
}

export function hasActiveGitProcess(psOutput: string, currentPid = String(process.pid)): boolean {
  return psOutput.split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || match[1] === currentPid) return false;
    return /(?:^|[\s/])git(?:[-\w]*)(?:\s|$)/.test(match[2]);
  });
}

const LFS_FALLBACK_CONFIG = [
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.required=false',
  // A missing git-lfs install also leaves a post-checkout hook that exits 2.
  // Disable local hooks for this pointer-only checkout; otherwise Git reports
  // the hook failure as "Unable to checkout" even when the commit is present.
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
];

function gitLfsAvailable(): boolean {
  const result = spawnSync('git-lfs', ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function isGitCheckout(path: string): boolean {
  const gitSentinel = resolve(ROOT, path, '.git');
  if (!existsSync(gitSentinel)) return false;
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return true;
  } catch {
    return false;
  }
}

function submoduleStatusPaths(): string[] {
  return gitOut(['submodule', 'status', '--recursive'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1])
    .filter((path): path is string => Boolean(path));
}

function pruneNonGitSubmodulePaths(dryRun: boolean, results: UpdateResult[]): void {
  const paths = new Set([...submodulePaths(), ...submoduleStatusPaths()]);
  for (const path of paths) {
    const absPath = resolve(ROOT, path);
    if (!existsSync(absPath)) continue;
    if (isGitCheckout(path)) continue;

    if (dryRun) {
      console.log(`[dry-run] rm -rf ${path}`);
      results.push({
        repoType: 'submodule',
        repo: path,
        result: 'planned',
        detail: 'would remove stale non-git submodule path before update',
      });
      continue;
    }

    try {
      rmSync(absPath, { recursive: true, force: true });
      console.log(`[clean] removed stale non-git submodule path: ${path}`);
      results.push({
        repoType: 'submodule',
        repo: path,
        result: 'ok',
        detail: 'removed stale non-git submodule path before update',
      });
    } catch (error) {
      results.push({
        repoType: 'submodule',
        repo: path,
        result: 'failed',
        detail: `rm -rf ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

function rootIndexLockPath(): string {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'index.lock'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const path = result.status === 0 ? String(result.stdout ?? '').trim() : '.git/index.lock';
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

function activeGitProcessExists(): boolean {
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) return true;
    return /"git(?:[-\w]*)\.exe"/i.test(String(result.stdout ?? ''));
  }
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', stdio: 'pipe' });
  // An unknown process list is not proof that the lock is stale.
  return result.status !== 0 || hasActiveGitProcess(String(result.stdout ?? ''));
}

function scrubFloatingRepo(path: string, cleanFlags: string, dryRun: boolean, gitPrefix: string[]): UpdateResult {
  const repoType = 'floating-repo' as const;
  if (!existsSync(resolve(ROOT, path))) {
    return { repoType, repo: path, result: 'skipped', detail: 'checkout absent' };
  }
  if (!isGitCheckout(path)) {
    return { repoType, repo: path, result: 'failed', detail: 'path exists but is not a git checkout' };
  }

  const resetArgs = [...gitPrefix, '-C', path, 'reset', '--hard', '-q'];
  const cleanArgs = [...gitPrefix, '-C', path, 'clean', cleanFlags];
  if (dryRun) {
    console.log(`[dry-run] git ${resetArgs.join(' ')}`);
    console.log(`[dry-run] git ${cleanArgs.join(' ')}`);
    return {
      repoType,
      repo: path,
      result: 'planned',
      detail: `git ${resetArgs.join(' ')} && git ${cleanArgs.join(' ')}`,
    };
  }

  console.log(`[clean] ${path}: git ${resetArgs.join(' ')}`);
  const reset = spawnSync('git', resetArgs, { cwd: ROOT, stdio: 'inherit' });
  if ((reset.status ?? 1) !== 0) {
    return { repoType, repo: path, result: 'failed', detail: `git reset --hard exited ${reset.status ?? 1}` };
  }

  console.log(`[clean] ${path}: git ${cleanArgs.join(' ')}`);
  const clean = spawnSync('git', cleanArgs, { cwd: ROOT, stdio: 'inherit' });
  if ((clean.status ?? 1) !== 0) {
    return { repoType, repo: path, result: 'failed', detail: `git clean exited ${clean.status ?? 1}` };
  }
  return { repoType, repo: path, result: 'ok', detail: 'floating checkout scrubbed' };
}

function scrubFloatingRepos(cleanFlags: string, dryRun: boolean, gitPrefix: string[]): UpdateResult[] {
  return cleanableFloatingRepoPaths().map((path) => scrubFloatingRepo(path, cleanFlags, dryRun, gitPrefix));
}

function prepareRootIndexLock(dryRun: boolean, results: UpdateResult[]): void {
  const lockPath = rootIndexLockPath();
  const action = cleanLockAction(existsSync(lockPath), activeGitProcessExists(), dryRun);
  if (action === 'none') return;
  if (action === 'block') {
    const detail = `${lockPath} is locked by an active Git process; close it and re-run bun fx clean`;
    console.error(`[clean] ${detail}`);
    results.push({ repoType: 'root', repo: '.', result: 'failed', detail });
    console.log(`\n${formatUpdateReport(results)}`);
    process.exit(1);
  }
  if (action === 'plan-remove') {
    console.log(`[dry-run] remove stale Git lock ${lockPath}`);
    return;
  }
  try {
    unlinkSync(lockPath);
    console.log(`[clean] removed stale Git lock ${lockPath}`);
  } catch (error) {
    const detail = `could not remove stale Git lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[clean] ${detail}`);
    results.push({ repoType: 'root', repo: '.', result: 'failed', detail });
    console.log(`\n${formatUpdateReport(results)}`);
    process.exit(1);
  }
}

function stopBeforeClean(dryRun: boolean): void {
  if (dryRun) {
    console.log('[dry-run] bun fx stop');
    return;
  }
  console.log('[clean] stopping Studio stack first: bun fx stop');
  const stop = spawnSync(BUN, [fileURLToPath(import.meta.url), 'stop'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if ((stop.status ?? 1) !== 0) {
    console.error('[clean] bun fx stop failed; aborting clean');
    process.exit(stop.status ?? 1);
  }
}

function clean(args: string[]): never {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const deep = args.includes('--deep') || args.includes('-x');
  stopBeforeClean(dryRun);
  // Double -f (-ff): a plain `git clean -fd` SKIPS nested git directories
  // ("Skipping repository packages/core"). After submodule renames/removals
  // (e.g. packages/core → packages/cli), the old path often remains as an
  // orphaned checkout with its own .git — -ff is required to delete it.
  const cleanFlags = cleanTreeFlags(deep, dryRun);
  // Use the same ignore policy recursively. -ff descends into nested git dirs
  // (e.g. an uninitialised nested submodule) rather than skipping them.
  const lfsFallback = !gitLfsAvailable();
  const gitPrefix = lfsFallback ? LFS_FALLBACK_CONFIG : [];
  const gitCommand = (gitArgs: string[]): string => ['git', ...gitPrefix, ...gitArgs].join(' ');
  const submoduleInsideWorktreeCheck = `${gitCommand(['-C', '.', 'rev-parse', '--is-inside-work-tree'])} >/dev/null 2>&1`;
  const subForeachCmd = [
    'if',
    `${submoduleInsideWorktreeCheck}; then`,
    `${gitCommand(['reset', '--hard', '-q'])} && ${gitCommand(['clean', cleanFlags])};`,
    'else',
    'echo "[clean] skip non-git submodule path: $path";',
    'fi',
  ].join(' ');

  const results: UpdateResult[] = [];
  const step = (repo: string, gitArgs: string[], okDetail: string): void => {
    if (dryRun) {
      console.log(`[dry-run] git ${gitArgs.join(' ')}`);
      results.push({ repoType: repo === '.' ? 'root' : 'submodule', repo, result: 'planned', detail: `git ${gitArgs.join(' ')}` });
      return;
    }
    console.log(`[clean] ${repo}: git ${gitArgs.join(' ')}`);
    const r = spawnSync('git', [...gitPrefix, ...gitArgs], { cwd: ROOT, stdio: 'inherit' });
    const status = r.status ?? 1;
    results.push({
      repoType: repo === '.' ? 'root' : 'submodule',
      repo,
      result: status === 0 ? 'ok' : 'failed',
      detail: status === 0 ? okDetail : `git ${gitArgs.join(' ')} exited ${status}`,
    });
  };

  console.log(`[clean] workspace mode: ${deep ? 'deep (removes gitignored artefacts — re-run bun install after)' : 'standard (keeps gitignored artefacts)'}${dryRun ? ' · DRY RUN' : ''}`);
  if (lfsFallback) {
    console.warn('[clean] git-lfs not found; LFS files will remain as pointer files until git-lfs is installed and hydrated');
  }

  // 1. discard tracked edits + reset submodule pointers to recorded pins.
  prepareRootIndexLock(dryRun, results);
  step('.', ['reset', '--hard'], 'reset tracked changes');
  // 2. sync submodule URLs (repo renames) then checkout recorded pins — also
  //    materialises empty dirs left by a plain `git pull` of a new submodule.
  pruneNonGitSubmodulePaths(dryRun, results);
  step('submodules', ['submodule', 'sync', '--recursive'], 'submodule URLs synced');
  step('submodules', ['submodule', 'update', '--init', '--recursive', '--force'], 'checkouts synced to pins');
  // 3. scrub every submodule working tree (tracked + untracked, recursively).
  //    Ignored content is included only when deep mode was explicitly requested.
  step('submodules', ['submodule', 'foreach', '--recursive', subForeachCmd], 'submodule trees scrubbed');
  // 4. scrub managed floating checkouts separately; root git clean cannot
  // descend into them because they are gitignored independent repositories.
  results.push(...scrubFloatingRepos(cleanFlags, dryRun, gitPrefix));
  // 5. remove root untracked files (incl. orphaned former-submodule dirs like
  //    packages/core after rename), preserving all floating checkouts.
  step('.', ['clean', cleanFlags, ...floatingRepoExclusionArgs()], 'root untracked removed');

  // 6. Drop stale submodule.*.path config entries that no longer exist in
  //    .gitmodules (rename leftovers keep local config otherwise).
  if (!dryRun) {
    dropStaleSubmoduleConfig();
  }

  console.log(`\n${formatUpdateReport(results)}`);

  if (!dryRun) {
    const stillDirty = gitOut([...gitPrefix, 'status', '--porcelain']);
    if (stillDirty === '') {
      console.log('\n[clean] working tree is now completely clean ✓');
    } else {
      console.log('\n[clean] remaining after clean (inspect manually):');
      console.log(stillDirty);
    }

    // Gate the install path: empty/new submodule workspaces must have package.json.
    try {
      const pkgText = readFileSync(resolve(ROOT, 'package.json'), 'utf8');
      const missing = missingWorkspacePackageJson(ROOT, readWorkspaceGlobs(pkgText));
      if (missing.length > 0) {
        console.error(`\n[clean] workspace package.json still missing: ${missing.join(', ')}`);
        console.error('[clean] fix auth/network for submodule fetch, then re-run: bun fx clean && bun install');
        process.exit(1);
      }
      console.log('[clean] workspace submodules ready — next: bun install');
    } catch (e) {
      console.warn(`[clean] workspace check skipped: ${(e as Error).message}`);
    }
  }

  const failed = results.filter((r) => r.result === 'failed').length;
  process.exit(failed > 0 ? 1 : 0);
}

/** Remove local `submodule.<name>.*` config when that name is gone from .gitmodules. */
function dropStaleSubmoduleConfig(): void {
  const configured = gitOut(['config', '--local', '--get-regexp', '^submodule\\..*\\.url$']);
  if (!configured) return;
  const gitmodules = join(ROOT, '.gitmodules');
  const liveNames = new Set<string>();
  if (existsSync(gitmodules)) {
    for (const line of readFileSync(gitmodules, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\[submodule "(.+)"\]\s*$/);
      if (m) liveNames.add(m[1]);
    }
  }
  for (const line of configured.split(/\r?\n/)) {
    const m = line.match(/^submodule\.(.+)\.url\s/);
    if (!m) continue;
    const name = m[1];
    if (liveNames.has(name)) continue;
    console.log(`[clean] drop stale git config section submodule.${name}`);
    spawnSync('git', ['config', '--local', '--remove-section', `submodule.${name}`], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
}

async function main(): Promise<void> {
  const plan = resolveCommand(process.argv.slice(2));
  if (plan.type === 'script') {
    const lifecycleScript = plan.script === script('stop.ts') || plan.script === script('open-web.ts');
    runScript(plan.script, plan.args, lifecycleScript ? lifecycleProcessEnv() : process.env);
  }
  if (plan.type === 'unknown') {
    console.error(`unknown command: ${plan.command}`);
    usage();
    process.exit(2);
  }
  if (await dispatchLifecycleCommand(plan.command, plan.args)) return;
  switch (plan.command) {
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    case 'status':
      if (plan.args.includes('--repos')) runScript(script('repos.ts'), ['status']);
      status();
      break;
    case 'doctor':
      doctor(plan.args);
      break;
    case 'recursive-inputs': {
      const result = executeRecursiveInputCli(plan.args, createRecursiveInputCliDependencies(ROOT));
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    }
    case 'release-integrity': {
      const result = executeReleaseIntegrityCli(plan.args, {
        ...createReleaseIntegrityCliDependencies(ROOT),
        runRouteBackAdapter: runReleaseIntegrityRouteBackAdapter,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    }
    case 'clean':
      clean(plan.args);
      break;
    case 'ci':
      process.exit(runPublicCommand(['ide', 'ci', ...plan.args], ROOT));
      break;
    case 'build':
      usage();
      process.exit(2);
      break;
    default:
      console.error(`unhandled command: ${plan.command}`);
      process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[fx] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
