#!/usr/bin/env bun
// scripts/stop.ts — stop the forgeax-studio dev stack started by run.ts.
//
// Replaces stop.sh + stop.bat with ONE cross-platform implementation. The two
// bash/batch versions existed only because MSYS `kill`/`ps` cannot terminate
// native Windows processes — running under Bun, `taskkill /T /F` and `kill` are
// both reachable directly, so the split collapses.
//
// Discovery is limited to the current RuntimeInstance. A valid RuntimeState
// supplies its complete managed PID/port contract; missing or invalid state
// falls back only to this instance's derived, typed service ports. Ownership
// checks fail closed by default; --force explicitly overrides unproven targets.
//
// Default escalation: SIGTERM → 4s grace → SIGKILL. --no-force warns + exits 1
// instead. After kills, poll each port up to ~5s for the socket to release
// (kernel TIME_WAIT) so an immediate follow-up run.ts doesn't misfire.
//
// Exit codes: 0 clean · 1 stragglers/ports-still-bound · 2 bad args.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeInstance } from './lib/runtime-instance.ts';
import {
  cleanupStopArtifacts,
  resolveInstanceStopScope,
} from './lib/stop-scope.ts';
import { readRuntimeProcessSnapshot, runtimeProcessBelongsToInstance } from './lib/runtime-process-owner.ts';
import { canFinalizeStop, discoverStopTargets } from './lib/stop-execution.ts';
import {
  clearPidfiles,
  IS_WIN,
  isAlive,
  isPortBusy,
  killTree,
  listenPids,
  selfAndAncestors,
  sleep,
} from './lib/proc.ts';
import { resolveActiveServerRole } from './lib/server-role.ts';
import { readRuntimeState, runtimeStateBelongsToInstance } from './lib/runtime-state.ts';
import { vitePurgeAll } from './lib/vite-cache.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveRuntimeInstance({ root: ROOT });
const runtimeState = readRuntimeState(instance.stateFile);
let activeServer = {
  packageDir: join(ROOT, 'packages/server'),
  entry: 'src/main.ts',
  packageName: '@forgeax/server',
  priority: 0,
};
if (!runtimeStateBelongsToInstance(instance, runtimeState)) {
  try {
    activeServer = resolveActiveServerRole({
      root: ROOT,
      profile: process.env.FORGEAX_SERVER_PROFILE,
    });
  } catch (error) {
    console.error(
      `[stop] WARNING: server role resolution failed; retaining the base orphan signature (${(error as Error).message})`,
    );
  }
}

// ── args ──────────────────────────────────────────────────────────────────
let force = true;
let forceUnowned = false;
let purgeVite = false;
for (const a of process.argv.slice(2)) {
  if (a === '--force' || a === '-f') {
    force = true;
    forceUnowned = true;
  }
  else if (a === '--no-force') force = false;
  else if (a === '--purge-vite') purgeVite = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: bun fx stop [--force] [--no-force] [--purge-vite]');
    console.log('  --force       also stop listeners/PIDs whose ownership cannot be proven');
    console.log('  --no-force    warn + exit 1 instead of escalating to SIGKILL after 4s');
    console.log('  --purge-vite  also clear all vite optimizeDeps caches');
    process.exit(0);
  } else {
    console.error(`[stop] unknown arg: ${a} (try --help)`);
    process.exit(2);
  }
}

// ── resolve this instance's state (fail closed on copied/cross-root state) ──
const interfaceDir = join(instance.root, 'packages', process.env.STUDIO === '0' ? 'interface' : 'studio');
const scoped = resolveInstanceStopScope(instance, runtimeState, { activeServer, interfaceDir });
if (scoped.lockConflict) {
  console.error('[stop] runtime state and run.lock name different launchers; refusing to kill or clean up during a possible handoff.');
  process.exit(1);
}

// ── port → service map ──────────────────────────────────────────────────────
const ports: number[] = scoped.ports.map(({ port }) => port);
const svcs: string[] = scoped.ports.map(({ service }) => service);

const startTs = performance.now();

console.log(`[stop] scanning forgeax-studio dev stack (${IS_WIN ? 'netstat' : 'lsof'}):`);
for (let i = 0; i < ports.length; i++) console.log(`  :${String(ports[i]).padEnd(5)}  ${svcs[i]}`);
console.log();

// ── discover owned pids from this instance's typed resource scope ──
// Never reap our own launcher chain (e.g. `bun fx start desktop` → desktop.ts → stop.ts):
// those ancestors carry the repo path on their command line and would otherwise
// be caught by the signature scan, killing the very command doing the reaping.
const protectedPids = selfAndAncestors();
const found = new Map<number, string>(); // pid -> source label
const note = (pid: number, src: string) => {
  if (pid && !protectedPids.has(pid) && !found.has(pid)) found.set(pid, src);
};

const discovery = discoverStopTargets(scoped, { listenPids, readSnapshot: readRuntimeProcessSnapshot, owns: runtimeProcessBelongsToInstance, isAlive, isPortBusy, protectedPids, forceUnowned });
for (const [pid, key] of discovery.found) note(pid, key);
for (const refusal of discovery.refusals) {
  const reason = refusal.reason === 'protected-ancestor'
    ? 'it belongs to the stop command ancestry'
    : 'ownership is unproven for this RuntimeInstance (command/CWD contract mismatch or unavailable)';
  const cwd = refusal.cwd ? `; cwd=${refusal.cwd}` : '';
  console.warn(`[stop] refusing ${refusal.source} pid ${refusal.pid}: ${reason}${cwd}`);
}

if (found.size === 0) {
  if (
    discovery.blocked
    || ports.some((port) => isPortBusy(port))
    || !canFinalizeStop(scoped, { ...discovery, found }, { isAlive, isPortBusy })
  ) {
    console.error('[stop] scoped resource remains busy, protected, or unproven; refusing cleanup.');
    process.exit(1);
  }
  console.log('[stop] nothing to kill — all ports already free.');
  if (!(await cleanupStateFiles())) {
    console.error('[stop] a run.lock owner appeared or survived during final cleanup; retaining recovery files.');
    process.exit(1);
  }
  if (purgeVite) vitePurgeAll(instance.projectRoot);
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
if (anyBusy || !canFinalizeStop(scoped, { ...discovery, found }, { isAlive, isPortBusy })) {
  console.error(`[stop] done in ${elapsed}s — a scoped port, PID, or declared resource survived; refusing cleanup`);
  process.exit(1);
}
if (!(await cleanupStateFiles())) {
  console.error('[stop] a run.lock owner appeared or survived during final cleanup; retaining recovery files.');
  process.exit(1);
}
if (purgeVite) {
  console.log('[stop] --purge-vite: clearing all vite optimizeDeps caches');
  vitePurgeAll(instance.projectRoot);
}
console.log(`[stop] done in ${elapsed}s — stack is down, safe to run: bun fx start`);

// ── helpers ───────────────────────────────────────────────────────────────

async function cleanupStateFiles(): Promise<boolean> {
  const result = await cleanupStopArtifacts(instance, {
    clearPidfiles,
    canFinalize: () => canFinalizeStop(scoped, { ...discovery, found }, { isAlive, isPortBusy }),
  });
  if (!result.ok) {
    console.error(`[stop] cleanup lease was not acquired or final verification changed: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
  }
  return result.ok;
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
