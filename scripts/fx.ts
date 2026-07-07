#!/usr/bin/env bun
// @ts-nocheck
// ForgeaX Studio single TypeScript command entry.
//
// Usage:
//   bun fx <command> [args...]

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_ENGINE, PORT_INTERFACE, PORT_SERVER } from './lib/ports.ts';

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
  'clean',

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
  clean [--deep|-x]     Restore a fully-clean git status across root + all
                        submodules. Discards uncommitted edits, scrubs submodule
                        interiors to bare pin state (incl. gitignored runtime
                        products), syncs pins. Root keeps node_modules/dist/.env
                        unless --deep. --dry-run/-n previews. Keeps .forgeax-harness.
  start [web|app|local] Start Studio and open the selected client (default: web)
                        local = 127.0.0.1-only on a third port band (:38920) — use
                        when default and dev-local ports are both taken
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tailLog(path: string, lines: number): string {
  try {
    const all = readFileSync(path, 'utf8').split(/\r?\n/);
    return all.slice(-lines).join('\n');
  } catch {
    return '(log unavailable)';
  }
}

function startStudio(args: string[]): never {
  const [maybeMode, ...rest] = args;
  if (maybeMode === 'app') runScript(script('app.ts'), rest);
  // Local-only third port band (foreground, Ctrl-C to stop) for when the default
  // and dev-local ports are both taken by other checkouts. See dev-local2.ts.
  if (maybeMode === 'local') runScript(script('dev-local2.ts'), rest);
  if (maybeMode && maybeMode !== 'web' && !maybeMode.startsWith('-')) {
    console.error(`[start] unknown client: ${maybeMode}`);
    console.error('[start] usage: bun fx start [web|app|local] [args...]');
    process.exit(2);
  }

  const runArgs = maybeMode === 'web' ? rest : args;
  // Floating on purpose: startWeb awaits the UI port, then exits the process
  // itself (open-web / error). The pending timer keeps the loop alive.
  void startWeb(runArgs);
}

async function startWeb(runArgs: string[]): Promise<never> {
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
  // Track child death: run.ts fails fast (missing/stale engine dist, port
  // conflict, preflight) by exiting non-zero within the first second. Without
  // this, the loop below would poll the port for the full 180s and then print a
  // generic timeout, burying the real error in the log.
  let childExit: number | null = null;
  child.on('exit', (code, signal) => {
    childExit = code ?? (signal ? 1 : 0);
  });

  process.stdout.write(`[start] waiting for UI :${uiPort}`);
  let up = false;
  for (let i = 0; i < 90; i++) {
    if (portOwner(uiPort)) {
      up = true;
      break;
    }
    if (childExit !== null) break; // stack process died before the UI came up
    process.stdout.write('.');
    await sleep(2000); // async so the child 'exit' event can fire
  }
  console.log();

  if (!up && childExit !== null) {
    console.error(`[start] web stack process exited (code ${childExit}) before UI :${uiPort} came up.`);
    console.error(`[start] last lines of ${stackLog}:\n`);
    console.error(tailLog(stackLog, 25));
    // exit 0 but UI never bound is still a failure → floor to 1
    process.exit(childExit || 1);
  }
  if (!up) {
    console.error(`[start] web stack failed to come up within timeout — see ${stackLog}`);
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

// ── clean ──────────────────────────────────────────────────────────────────
// Restore the working tree to a fully-clean `git status`, recursively across the
// root repo AND every submodule (incl. the editor→engine nesting).
//
// Root vs submodule asymmetry (deliberate):
//   • ROOT stays conservative by default — keeps gitignored artefacts
//     (node_modules / dist / .env / wgpu-wasm pkg) so no re-setup is needed.
//   • SUBMODULES are always deep-cleaned (`-fdx`). A submodule reports itself
//     "modified" to the superproject whenever its tree has ANY untracked content
//     — and the only untracked content left after a normal clean is gitignored
//     runtime products (engine packages/*/build, games <slug>/workbench + reel/,
//     sessions/). Those are always regenerable, and leaving them keeps the
//     superproject stuck at `M packages/<sub>`. So to actually reach a clean
//     `git status`, submodule interiors must be scrubbed to bare pin state.
//
// `--deep`/-x extends the deep clean to the ROOT too (wipe node_modules/dist/.env;
// re-run setup after). `--dry-run`/-n previews without deleting.
// `.forgeax-harness` (floating loop-state clone, gitignored, own .git) is ALWAYS
// preserved — it holds unpushed closed-loop state and must never be wiped here.
//
// NOTE: this function discards ALL uncommitted work (git reset --hard). Commit
// anything worth keeping — including edits to this very file — before running it.
function clean(args: string[]): never {
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const deepRoot = args.includes('--deep') || args.includes('-x');
  const rootCleanFlags = deepRoot ? '-fdx' : '-fd';
  // Submodule interiors are always deep-cleaned; -ff to descend into any nested
  // git dirs (e.g. an uninitialised nested submodule) rather than skip them.
  const subForeachCmd = dryRun
    ? 'git reset --hard -q && git clean -ffndx'
    : 'git reset --hard -q && git clean -ffdx';

  const results: UpdateResult[] = [];
  const step = (repo: string, gitArgs: string[], okDetail: string): void => {
    if (dryRun) {
      console.log(`[dry-run] git ${gitArgs.join(' ')}`);
      results.push({ repoType: repo === '.' ? 'root' : 'submodule', repo, result: 'planned', detail: `git ${gitArgs.join(' ')}` });
      return;
    }
    console.log(`[clean] ${repo}: git ${gitArgs.join(' ')}`);
    const r = spawnSync('git', gitArgs, { cwd: ROOT, stdio: 'inherit' });
    const status = r.status ?? 1;
    results.push({
      repoType: repo === '.' ? 'root' : 'submodule',
      repo,
      result: status === 0 ? 'ok' : 'failed',
      detail: status === 0 ? okDetail : `git ${gitArgs.join(' ')} exited ${status}`,
    });
  };

  console.log(`[clean] root mode: ${deepRoot ? 'deep (removes gitignored artefacts — re-run setup after)' : 'standard (keeps node_modules/dist/.env)'} · submodules: always deep${dryRun ? ' · DRY RUN' : ''}`);

  // 1. discard tracked edits + reset submodule pointers to recorded pins.
  step('.', ['reset', '--hard'], 'reset tracked changes');
  // 2. sync submodule checkouts to the recorded pins (init any missing / nested).
  step('submodules', ['submodule', 'update', '--init', '--recursive', '--force'], 'checkouts synced to pins');
  // 3. scrub every submodule working tree to bare pin state (tracked + untracked
  //    + gitignored, recursively) so none reports "modified content" upward.
  step('submodules', ['submodule', 'foreach', '--recursive', subForeachCmd], 'submodule trees scrubbed');
  // 4. remove root untracked files, always preserving the harness floating clone.
  step('.', ['clean', rootCleanFlags, '-e', '.forgeax-harness', ...(dryRun ? ['-n'] : [])], 'root untracked removed');

  console.log(`\n${formatUpdateReport(results)}`);

  if (!dryRun) {
    const stillDirty = gitOut(['status', '--porcelain']);
    if (stillDirty === '') {
      console.log('\n[clean] working tree is now completely clean ✓');
    } else {
      console.log('\n[clean] remaining after clean (inspect manually):');
      console.log(stillDirty);
    }
  }

  const failed = results.filter((r) => r.result === 'failed').length;
  process.exit(failed > 0 ? 1 : 0);
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
    case 'clean':
      clean(plan.args);
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
