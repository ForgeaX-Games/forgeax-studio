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
import { PORT_EDITOR, PORT_ENGINE, PORT_INTERFACE, PORT_SERVER } from './lib/ports.ts';

type ScriptPlan = { type: 'script'; script: string; args: string[] };
type InternalPlan = { type: 'internal'; command: string; args: string[] };
type UnknownPlan = { type: 'unknown'; command: string; args: string[] };
export type CommandPlan = ScriptPlan | InternalPlan | UnknownPlan;

type RunGitOptions = {
  dryRun?: boolean;
  inherit?: boolean;
};

type UpdateResult = {
  repoType: 'root' | 'submodule';
  repo: string;
  result: string;
  detail?: string;
};

type StartPort = readonly [name: string, port: number];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUN = process.execPath;
const START_PORTS: readonly StartPort[] = [
  ['server', PORT_SERVER],
  ['interface', PORT_INTERFACE],
  ['engine', PORT_ENGINE],
  ['editor', PORT_EDITOR],
];

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

export function startBusyPorts(owner: (port: number) => string = portOwner): Array<[string, number, string]> {
  return START_PORTS
    .map(([name, port]) => [name, port, owner(port)] as [string, number, string])
    .filter(([, , pid]) => pid !== '');
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
  const busyPorts = startBusyPorts();
  if (busyPorts.length > 0) {
    console.error('[start] dev stack already appears to be running:');
    for (const [name, port, pid] of busyPorts) {
      console.error(`  :${String(port).padEnd(5)} ${name.padEnd(9)} pid=${pid}`);
    }
    console.error('\n[start] use `bun fx restart` to stop and start the stack, or `bun fx stop` first.');
    process.exit(1);
  }

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
  const results: UpdateResult[] = [];

  console.log('[update] Checking working tree');
  if (isDirty()) {
    if (!stash) {
      console.error('[update] local changes detected; remove --no-stash or clean the worktree first.');
      process.exit(2);
    }
    const stashBefore = dryRun ? '' : stashTopOid();
    stashedMessage = updateStashMessage();
    runGit(['stash', 'push', '-u', '-m', stashedMessage], { dryRun, inherit: true });
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
    console.log('[update] Updating submodules');
    results.push(...updateSubmodules(dryRun));
  } else {
    results.push({ repoType: 'submodule', repo: '(all)', result: 'skipped', detail: 'root update failed' });
  }

  if (stashedMessage) {
    console.log('[update] Restoring pre-update stash');
    results.push(restoreStashResult(stashedMessage, dryRun));
  }

  console.log();
  console.log('[update] result report');
  console.log(formatUpdateReport(results));

  if (results.some((row) => row.result === 'failed')) {
    console.error('[update] one or more repositories failed to update; see report above');
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
