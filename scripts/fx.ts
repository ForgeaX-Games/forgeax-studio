#!/usr/bin/env bun
// @ts-nocheck
// ForgeaX Studio single TypeScript command entry.
//
// Usage:
//   bun fx <command> [args...]

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type ScriptPlan = { type: 'script'; script: string; args: string[] };
type InternalPlan = { type: 'internal'; command: string; args: string[] };
type UnknownPlan = { type: 'unknown'; command: string; args: string[] };
export type CommandPlan = ScriptPlan | InternalPlan | UnknownPlan;

type RunGitOptions = {
  dryRun?: boolean;
  inherit?: boolean;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUN = process.execPath;

const script = (name: string): string => resolve(ROOT, 'scripts', name);

const SCRIPT_COMMANDS = new Map<string, string>([
  // setup prerequisites
  ['setup', 'setup.ts'],

  // dev lifecycle
  ['stop', 'stop.ts'],

  // build / metadata helpers
  ['build:plugins', 'build-plugins.ts'],
  ['version', 'lib/version.ts'],
]);

const BUILTIN_COMMANDS = new Set([
  // git update orchestration
  'update',

  // dev lifecycle orchestration
  'start',
  'restart',

  // diagnostics
  'status',
  'doctor',

  // compound aliases
  'build',

  // help aliases
  'help',
  '--help',
  '-h',
]);

export function resolveCommand(argv: string[]): CommandPlan {
  const [cmd = 'help', ...args] = argv;
  const route = SCRIPT_COMMANDS.get(cmd);
  if (route) return { type: 'script', script: script(route), args };

  if (cmd === 'build') {
    const [target = 'help', ...rest] = args;
    if (target === 'plugins') return { type: 'script', script: script('build-plugins.ts'), args: rest };
    if (target === 'app') return { type: 'script', script: script('app.ts'), args: ['build', ...rest] };
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
  setup                 Prepare deps, submodules, engine, plugins, .env scaffold
  update                Pull latest root code and sync all submodules
  start [web|app]       Start Studio and open the selected client (default: web)
  stop                  Stop web-dev stack
  restart               Stop then start web-dev stack
  status                Show git/submodule/port/artefact status
  doctor [--fix]        Diagnose common local setup problems
  build plugins         Rebuild missing/broken marketplace plugin dists
  build app             Package the desktop app
  version [args...]     Print version info

Examples:
  bun fx setup
  bun fx update
  bun fx start
  bun fx start app debug
  bun fx status
`);
}

function runScript(file: string, args: string[]): never {
  const r = spawnSync(BUN, [file, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
  process.exit(r.status ?? 1);
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

function stashTopRef(): string {
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

export function parseSubmodulePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
}

function submodulePaths(): string[] {
  return parseSubmodulePaths(gitOut(['config', '--file', '.gitmodules', '--get-regexp', 'path']));
}

export function submoduleUpdateArgs(path: string): string[] {
  return ['submodule', 'update', '--init', '--recursive', '--', path];
}

function updateSubmodules(dryRun: boolean): boolean {
  const paths = submodulePaths();
  if (paths.length === 0) {
    console.log('[update] no submodules configured');
    return true;
  }

  const failed: string[] = [];
  for (const path of paths) {
    const args = submoduleUpdateArgs(path);
    if (dryRun) {
      console.log(`[dry-run] git ${args.join(' ')}`);
      continue;
    }
    console.log(`[update] submodule ${path}`);
    const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
    if ((r.status ?? 1) !== 0) failed.push(path);
  }

  const okCount = paths.length - failed.length;
  console.log(`[update] submodule report: ${okCount}/${paths.length} ok${failed.length ? `, ${failed.length} failed` : ''}`);
  for (const path of failed) console.log(`  ✗ ${path}`);
  return failed.length === 0;
}

function currentBranch(): string {
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
}

function upstream(): string {
  return gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

function wgpuWasmPath(): string {
  return resolve(ROOT, 'packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm');
}

function wgpuWasmStatus(): 'missing' | 'stale' | 'fresh' {
  const wasm = wgpuWasmPath();
  if (!existsSync(wasm)) return 'missing';
  const wasmTime = statSync(wasm).mtimeMs;
  const candidates = [
    'packages/engine/packages/wgpu-wasm/Cargo.toml',
    'packages/engine/packages/wgpu-wasm/Cargo.lock',
    'packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm.js',
  ].map((p) => resolve(ROOT, p));
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).mtimeMs > wasmTime) return 'stale';
  }
  return 'fresh';
}

function portOwner(port: number): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      const line = out
        .split(/\r?\n/)
        .find((l) => l.includes(`:${port}`) && /\bLISTENING\b/i.test(l));
      return line?.trim().split(/\s+/).at(-1) ?? '';
    }
    return (
      execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split(/\s+/)[0] ?? ''
    );
  } catch {
    return '';
  }
}

function touchWgpuWasm(): void {
  const wasm = wgpuWasmPath();
  if (!existsSync(wasm)) return;
  const now = new Date();
  utimesSync(wasm, now, now);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startStudio(args: string[]): never {
  const [maybeMode, ...rest] = args;
  if (maybeMode === 'app') runScript(script('app.ts'), rest);
  if (maybeMode && maybeMode !== 'web' && !maybeMode.startsWith('-')) {
    console.error(`[start] unknown client: ${maybeMode}`);
    console.error('[start] usage: bun fx start [web|app] [args...]');
    process.exit(2);
  }

  const runArgs = maybeMode === 'web' ? rest : args;
  startWeb(runArgs);
}

function startWeb(runArgs: string[]): never {
  const uiPort = Number.parseInt(process.env.FORGEAX_INTERFACE_PORT ?? '18920', 10);
  if (!portOwner(uiPort)) {
    console.log('[start] starting web stack in background...');
    const stackLog = resolve(tmpdir(), 'forgeax-stack.log');
    const fd = openSync(stackLog, 'a');
    const child = spawn(BUN, [script('run.ts'), ...runArgs], {
      cwd: ROOT,
      detached: true,
      env: process.env,
      stdio: ['ignore', fd, fd],
    });
    child.unref();

    process.stdout.write(`[start] waiting for UI :${uiPort}`);
    let up = false;
    for (let i = 0; i < 90; i++) {
      if (portOwner(uiPort)) {
        up = true;
        break;
      }
      process.stdout.write('.');
      sleepSync(2000);
    }
    console.log();
    if (!up) {
      console.error(`[start] web stack failed to come up — see ${stackLog}`);
      process.exit(1);
    }
  } else {
    console.log(`[start] UI :${uiPort} is already running; opening web client.`);
  }

  runScript(script('open-web.ts'), []);
}

function status(): void {
  console.log('ForgeaX Studio status');
  console.log(`root: ${ROOT}`);
  console.log(`branch: ${currentBranch()}`);
  const up = upstream();
  console.log(`upstream: ${up || '(none)'}`);
  if (up) {
    const counts = gitOut(['rev-list', '--left-right', '--count', `HEAD...${up}`]).split(/\s+/);
    console.log(`state: ahead=${counts[0] ?? '?'} behind=${counts[1] ?? '?'}`);
  }
  console.log(`dirty: ${isDirty() ? 'yes' : 'no'}`);
  console.log(`wgpu-wasm: ${wgpuWasmStatus()}`);
  console.log();
  console.log('ports:');
  for (const [name, port] of [
    ['server', 18900],
    ['ui', 18920],
    ['engine', 15173],
    ['editor', 15280],
    ['narrative', 8900],
    ['face-mask', 18930],
  ] as const) {
    const pid = portOwner(port);
    console.log(`  ${name.padEnd(9)} :${port} ${pid ? `listening pid=${pid}` : 'free'}`);
  }
  console.log();
  console.log('commands: bun fx setup | update | start [web|app] | stop | build app | status | doctor');
}

function doctor(args: string[]): never {
  const fix = args.includes('--fix');
  const required = ['git', 'bun', 'node'];
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
  process.exit(failed > 0 ? 1 : 0);
}

function update(args: string[]): void {
  const dryRun = args.includes('--dry-run');
  const stash = updateShouldStash(args);
  const restart = args.includes('--restart');
  let stashedMessage = '';

  console.log('[update] Checking working tree');
  if (isDirty()) {
    if (!stash) {
      console.error('[update] local changes detected; remove --no-stash or clean the worktree first.');
      process.exit(2);
    }
    const stashBefore = dryRun ? '' : stashTopRef();
    stashedMessage = updateStashMessage();
    runGit(['stash', 'push', '-u', '-m', stashedMessage], { dryRun, inherit: true });
    const stashAfter = dryRun ? `stash^{/${stashedMessage}}` : stashTopRef();
    if (didCreateStash(stashBefore, stashAfter)) {
      stashedMessage = stashAfter;
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
    runGit(['pull', '--ff-only', '--no-recurse-submodules'], { dryRun, inherit: true });
  } else {
    console.log('[update] no upstream; fetching origin/main and rebasing current branch');
    runGit(['fetch', '--no-recurse-submodules', 'origin', 'main'], { dryRun, inherit: true });
    runGit(['rebase', 'origin/main'], { dryRun, inherit: true });
  }

  console.log('[update] Updating submodules');
  const submodulesOk = updateSubmodules(dryRun);

  if (stashedMessage) {
    console.log('[update] Restoring pre-update stash');
    runGit(stashPopArgsForRef(stashedMessage), { dryRun, inherit: true });
  }

  if (!submodulesOk) {
    console.error('[update] one or more submodules failed to update; see report above');
    process.exit(1);
  }

  if (restart) {
    if (dryRun) console.log('[dry-run] bun fx restart');
    else restartStack([]);
  } else {
    console.log('[update] done (use --restart to restart the stack)');
  }
}

function restartStack(args: string[]): never {
  const stop = spawnSync(BUN, [script('stop.ts'), '--force'], { cwd: ROOT, stdio: 'inherit' });
  if ((stop.status ?? 0) !== 0) process.exit(stop.status ?? 1);
  startStudio(args);
}

function main(): void {
  const plan = resolveCommand(process.argv.slice(2));
  if (plan.type === 'script') runScript(plan.script, plan.args);
  if (plan.type === 'unknown') {
    console.error(`unknown command: ${plan.command}`);
    usage();
    process.exit(2);
  }
  switch (plan.command) {
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    case 'status':
      status();
      break;
    case 'start':
      startStudio(plan.args);
      break;
    case 'doctor':
      doctor(plan.args);
      break;
    case 'update':
      update(plan.args);
      break;
    case 'restart':
      restartStack(plan.args);
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
  main();
}
