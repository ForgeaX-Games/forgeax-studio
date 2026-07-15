#!/usr/bin/env bun
// scripts/stop.ts — stop the forgeax-studio dev stack started by run.ts.
//
// Replaces stop.sh + stop.bat with ONE cross-platform implementation. The two
// bash/batch versions existed only because MSYS `kill`/`ps` cannot terminate
// native Windows processes — running under Bun, `taskkill /T /F` and `kill` are
// both reachable directly, so the split collapses.
//
// Discovery is port-first (lsof on POSIX / netstat -ano on Windows, in proc.ts),
// then layered fallbacks: dev-stack.env pids, .forgeax/run pidfiles, command-line
// signature match (pgrep / PowerShell CIM), to catch orphans whose port drifted.
//
// Default escalation: SIGTERM → 4s grace → SIGKILL. --no-force warns + exits 1
// instead. After kills, poll each port up to ~5s for the socket to release
// (kernel TIME_WAIT) so an immediate follow-up run.ts doesn't misfire.
//
// Exit codes: 0 clean · 1 stragglers/ports-still-bound · 2 bad args.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_PORTS, FIXED_SVCS } from './lib/ports.ts';
import {
  clearPidfiles,
  IS_WIN,
  isAlive,
  isPortBusy,
  killTree,
  listenPids,
  runDir,
  selfAndAncestors,
  sleep,
} from './lib/proc.ts';
import { vitePurgeAll } from './lib/vite-cache.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── args ──────────────────────────────────────────────────────────────────
let force = true;
let purgeVite = false;
for (const a of process.argv.slice(2)) {
  if (a === '--force' || a === '-f') force = true;
  else if (a === '--no-force') force = false;
  else if (a === '--purge-vite') purgeVite = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: bun fx stop [--no-force] [--purge-vite]');
    console.log('  --no-force    warn + exit 1 instead of escalating to SIGKILL after 4s');
    console.log('  --purge-vite  also clear all vite optimizeDeps caches');
    process.exit(0);
  } else {
    console.error(`[stop] unknown arg: ${a} (try --help)`);
    process.exit(2);
  }
}

const runStackFile = join(ROOT, '.forgeax', 'dev-stack.env');
const extensionDevPortsJson = join(ROOT, '.forgeax', 'extension-dev-ports.json');

// ── gather dynamic ports + pids from prior run's state ──────────────────────
const stackEnv = parseEnvFile(runStackFile);
const runPids = (stackEnv.FORGEAX_RUN_PIDS ?? '').split(/\s+/).map(Number).filter(Boolean);
const runPorts = (stackEnv.FORGEAX_RUN_PORTS ?? '').split(/\s+/).map(Number).filter(Boolean);
const dynamicExtensionPorts = readExtensionDevPorts(extensionDevPortsJson);

// ── port → service map ──────────────────────────────────────────────────────
const ports: number[] = [...FIXED_PORTS];
const svcs: string[] = [...FIXED_SVCS];
const appendPort = (p: number) => {
  if (p && !ports.includes(p)) {
    ports.push(p);
    svcs.push('runtime    (run-managed dynamic service)');
  }
};
for (const p of [...runPorts, ...dynamicExtensionPorts]) appendPort(p);

const startTs = performance.now();

console.log(`[stop] scanning forgeax-studio dev stack (${IS_WIN ? 'netstat' : 'lsof'}):`);
for (let i = 0; i < ports.length; i++) console.log(`  :${String(ports[i]).padEnd(5)}  ${svcs[i]}`);
console.log();

// ── discover pids: ports → dev-stack.env pids → pidfiles → signature match ──
// Never reap our own launcher chain (e.g. `bun fx start desktop` → desktop.ts → stop.ts):
// those ancestors carry the repo path on their command line and would otherwise
// be caught by the signature scan, killing the very command doing the reaping.
const protectedPids = selfAndAncestors();
const found = new Map<number, string>(); // pid -> source label
const note = (pid: number, src: string) => {
  if (pid && !protectedPids.has(pid) && !found.has(pid)) found.set(pid, src);
};

for (const port of ports) for (const pid of listenPids(port)) note(pid, `:${port}`);
for (const pid of runPids) if (isAlive(pid)) note(pid, 'dev-stack.env');

// Layer 1: pidfiles recorded by run.ts as each service started.
const rdir = runDir(ROOT);
if (existsSync(rdir)) {
  for (const f of readdirSync(rdir)) {
    if (!f.endsWith('.pid')) continue;
    const pid = Number.parseInt(readFileSync(join(rdir, f), 'utf8').trim().split(/\s+/)[0] ?? '', 10);
    if (pid && isAlive(pid)) note(pid, `pidfile:${f.replace(/\.pid$/, '')}`);
  }
}

// Layer 2: command-line signature match for orphans whose port drifted.
for (const pid of signatureMatchPids(ROOT)) if (isAlive(pid)) note(pid, 'signature');

if (found.size === 0) {
  console.log('[stop] nothing to kill — all ports already free.');
  cleanupStateFiles();
  if (purgeVite) vitePurgeAll(ROOT);
  process.exit(0);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`[stop] found ${found.size} listener(s):`);
for (const [pid, src] of found) console.log(`  ${src.padEnd(16)} pid ${String(pid).padEnd(7)} ${pidCmd(pid)}`);
console.log();

// ── SIGTERM + 4s grace ──────────────────────────────────────────────────────
console.log('[stop] sending SIGTERM, waiting up to 4s for graceful exit...');
for (const pid of found.keys()) killTree(pid, false);

const reported = new Set<number>();
let straggling: number[] = [];
for (let tick = 0; tick < 8; tick++) {
  straggling = [];
  for (const pid of found.keys()) {
    if (isAlive(pid)) straggling.push(pid);
    else if (!reported.has(pid)) {
      console.log(`  ✓ pid ${pid} (${found.get(pid)}) exited`);
      reported.add(pid);
    }
  }
  if (straggling.length === 0) break;
  await sleep(500);
}

// ── escalate or warn ─────────────────────────────────────────────────────────
if (straggling.length > 0) {
  console.log();
  if (force) {
    console.log(`[stop] grace elapsed — escalating to SIGKILL on ${straggling.length} straggler(s):`);
    for (const pid of straggling) {
      console.log(`  ☠ pid ${pid} (${found.get(pid)})`);
      killTree(pid, true);
    }
    await sleep(1000);
  } else {
    console.error(`[stop] WARNING (--no-force): ${straggling.length} process(es) still alive after 4s:`);
    for (const pid of straggling) console.error(`  ✗ pid ${pid} (${found.get(pid)})  ${pidCmd(pid)}`);
    console.error('[stop] drop --no-force to auto-SIGKILL, or kill them manually.');
    process.exit(1);
  }
}

// ── wait for socket release (kernel TIME_WAIT) ──────────────────────────────
for (let tick = 0; tick < 10; tick++) {
  if (!ports.some((p) => isPortBusy(p))) break;
  await sleep(500);
}

// ── final verification ───────────────────────────────────────────────────────
console.log();
console.log('[stop] final port state:');
let anyBusy = false;
for (let i = 0; i < ports.length; i++) {
  if (isPortBusy(ports[i] as number)) {
    console.error(`  ✗ :${String(ports[i]).padEnd(5)}  ${svcs[i]}  STILL BUSY`);
    anyBusy = true;
  } else {
    console.log(`  ✓ :${String(ports[i]).padEnd(5)}  ${svcs[i]}`);
  }
}

const elapsed = Math.round((performance.now() - startTs) / 1000);
if (anyBusy) {
  console.error(`[stop] done in ${elapsed}s — but some ports remain bound (see above)`);
  process.exit(1);
}
cleanupStateFiles();
if (purgeVite) {
  console.log('[stop] --purge-vite: clearing all vite optimizeDeps caches');
  vitePurgeAll(ROOT);
}
console.log(`[stop] done in ${elapsed}s — stack is down, safe to run: bun fx start`);

// ── helpers ───────────────────────────────────────────────────────────────

function cleanupStateFiles(): void {
  rmSync(runStackFile, { force: true });
  rmSync(extensionDevPortsJson, { force: true });
  if (process.env.FORGEAX_EXTENSION_DEV_PORTS_FILE) rmSync(process.env.FORGEAX_EXTENSION_DEV_PORTS_FILE, { force: true });
  clearPidfiles(ROOT);
  rmSync(join(ROOT, '.forgeax', 'run.lock'), { recursive: true, force: true });
}

/** Parse a `KEY=value` env file into a record (ignores comments/blank lines). */
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** Read frontend+backend ports from extension-dev-ports.json. */
function readExtensionDevPorts(file: string): number[] {
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as {
      plugins?: Record<string, { frontendPort?: number; backendPort?: number }>;
    };
    const out: number[] = [];
    for (const p of Object.values(j.plugins ?? {})) {
      if (p.frontendPort) out.push(p.frontendPort);
      if (p.backendPort) out.push(p.backendPort);
    }
    return out;
  } catch {
    return [];
  }
}

/** Match orphaned stack processes by command-line referencing this working tree. */
function signatureMatchPids(root: string): number[] {
  if (IS_WIN) {
    // PowerShell CIM: native processes whose command line references THIS tree.
    const rootWin = root.replace(/\//g, '\\');
    const ps = [
      '$r = $env:FX_ROOT_WIN -replace "/","\\";',
      '$names = @("bun.exe","node.exe","esbuild.exe","python.exe","vite.exe");',
      'Get-CimInstance Win32_Process |',
      'Where-Object { ($names -contains $_.Name) -and $_.CommandLine -and ((($_.CommandLine -replace "/","\\")) -like "*$r*") } |',
      'ForEach-Object { $_.ProcessId }',
    ].join(' ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      env: { ...process.env, FX_ROOT_WIN: rootWin },
      windowsHide: true,
    });
    return (r.stdout ?? '')
      .split('\n')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((p) => p > 0 && p !== process.pid);
  }
  // POSIX: pgrep -f for known stack signatures under this tree.
  // `scripts/run.ts` is the launcher itself — it holds no port and records no
  // pidfile for itself, so without this it survives `bun fx stop` as an idle
  // orphan (defense-in-depth alongside listing its pid in dev-stack.env).
  const sigs = [
    `${root}/scripts/run.ts`,
    `${root}/packages/server.*bun.*src/main.ts`,
    `${root}/packages/.*vite`,
    `${root}/packages/editor/packages/.*vite`,
    `${root}/packages/marketplace/extensions/.*vite`,
    `${root}/packages/marketplace/extensions/.*headless-renderer.mjs`,
  ];
  const pids = new Set<number>();
  for (const sig of sigs) {
    const r = spawnSync('pgrep', ['-f', sig], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (pid > 0 && pid !== process.pid) pids.add(pid);
    }
  }
  return [...pids];
}

/** Human-readable command for a pid (cosmetic). */
function pidCmd(pid: number): string {
  if (IS_WIN) {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    const m = (r.stdout ?? '').match(/^"([^"]+)"/);
    return m ? (m[1] as string) : '';
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}
