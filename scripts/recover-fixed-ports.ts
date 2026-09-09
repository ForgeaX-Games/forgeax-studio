// CI-only recovery of leftover fixed-port heavy-sample RuntimeInstances.
//
// The heavy Studio QA assembled-gateway profile pins each sample to a fixed port triple.
// A leftover listener from a previous run blocks the next batch. This command
// closes the gap the previous environ-anchored bash scan left open (see
// scripts/lib/fixed-port-recovery.ts): it is *port-anchored* — resolve whoever
// LISTENs on each fixed port and kill it only when its cwd / command line
// proves it is a generated sample process, tolerating a deleted workspace.
//
// It then runs the instance-scoped `bun fx stop --force` on every surviving
// /tmp/<prefix>* workspace (which clears that instance's plugin ports too, from
// its RuntimeState) and removes the directory. Exit non-zero if any fixed port
// is still held by a sample-anchored process, or a workspace stop fails —
// refusing to start fixed-port samples on top of runtime residue.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, killTree, listenPids, selfAndAncestors } from './lib/proc.ts';
import {
  fixedHeavyPorts,
  isGeneratedSampleAnchor,
  planFixedPortRecovery,
  type FixedPortOccupant,
} from './lib/fixed-port-recovery.ts';

interface Options {
  readonly samplePrefixes: string[];
  readonly cleanupWorkspaces: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const samplePrefixes: string[] = [];
  let cleanupWorkspaces = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sample-prefix') {
      const value = argv[i + 1];
      if (!value) throw new Error('--sample-prefix requires a value (e.g. studio-qa-sample-)');
      samplePrefixes.push(value);
      i += 1;
    } else if (arg === '--cleanup-workspaces') {
      cleanupWorkspaces = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: bun fx recover-fixed-ports [--sample-prefix P]... [--cleanup-workspaces]');
      console.log('  --sample-prefix P      generated /tmp workspace dir prefix (default studio-qa-sample-)');
      console.log('  --cleanup-workspaces   also `fx stop --force` + rm each surviving /tmp/<prefix>* workspace');
      process.exit(0);
    } else {
      throw new Error(`unknown argument '${arg}' (try --help)`);
    }
  }
  if (samplePrefixes.length === 0) samplePrefixes.push('studio-qa-sample-');
  return { samplePrefixes, cleanupWorkspaces };
}

/**
 * Raw process snapshot that survives a deleted workspace. On Linux the /proc
 * cwd symlink keeps a " (deleted)" suffix; realpath (used by
 * runtime-process-owner) cannot resolve it, so read the link directly.
 */
function readPortHolder(pid: number): { commandLine: string | null; cwdLink: string | null } {
  if (process.platform === 'linux') {
    let commandLine: string | null = null;
    let cwdLink: string | null = null;
    try {
      commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
    } catch {
      commandLine = null;
    }
    try {
      cwdLink = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwdLink = null;
    }
    return { commandLine, cwdLink };
  }
  // Non-Linux (local dev / macOS): best-effort via ps + lsof. CI runs on Linux.
  let commandLine: string | null = null;
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (ps.status === 0) commandLine = (ps.stdout ?? '').trim() || null;
  let cwdLink: string | null = null;
  const lsof = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  if (lsof.status === 0) {
    for (const line of (lsof.stdout ?? '').split('\n')) {
      if (line.startsWith('n')) {
        cwdLink = line.slice(1);
        break;
      }
    }
  }
  return { commandLine, cwdLink };
}

function collectOccupants(ports: readonly number[]): FixedPortOccupant[] {
  const occupants: FixedPortOccupant[] = [];
  for (const port of ports) {
    for (const pid of listenPids(port)) {
      const { commandLine, cwdLink } = readPortHolder(pid);
      occupants.push({ pid, port, commandLine, cwdLink });
    }
  }
  return occupants;
}

function terminate(pids: readonly number[]): void {
  for (const pid of pids) {
    console.log(`[recover-fixed-ports] SIGTERM generated sample pid=${pid}`);
    killTree(pid, false);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!pids.some((pid) => isAlive(pid))) break;
    spawnSync('sleep', ['1']);
  }
  for (const pid of pids) {
    if (isAlive(pid)) {
      console.log(`[recover-fixed-ports] SIGKILL surviving sample pid=${pid}`);
      killTree(pid, true);
    }
  }
}

function cleanupWorkspaces(samplePrefixes: readonly string[]): boolean {
  let ok = true;
  let entries: string[] = [];
  try {
    entries = readdirSync('/tmp');
  } catch {
    return true;
  }
  for (const name of entries) {
    if (!samplePrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const workspace = join('/tmp', name);
    console.log(`[recover-fixed-ports] recovering generated RuntimeInstance: ${workspace}`);
    const stop = spawnSync('bun', ['scripts/fx.ts', 'stop', '--force'], {
      cwd: workspace,
      env: { ...process.env, FORGEAX_WORKSPACE_ROOT: workspace },
      stdio: 'inherit',
    });
    if (stop.status === 0) {
      rmSync(workspace, { recursive: true, force: true });
    } else {
      console.error(
        `::error title=Fixed-port recovery failed::unable to stop generated workspace: ${workspace}`,
      );
      ok = false;
    }
  }
  return ok;
}

export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const ports = fixedHeavyPorts();
  const protectedPids = selfAndAncestors();

  const plan = planFixedPortRecovery(collectOccupants(ports), {
    samplePrefixes: options.samplePrefixes,
    protectedPids,
  });
  for (const { occupant, reason } of plan.skip) {
    console.log(
      `[recover-fixed-ports] leaving pid=${occupant.pid} on :${occupant.port} — ${reason}`,
    );
  }
  terminate(plan.kill.map((occupant) => occupant.pid));

  let failed = false;
  if (options.cleanupWorkspaces && !cleanupWorkspaces(options.samplePrefixes)) {
    failed = true;
  }

  // Re-probe: any fixed port still held by a non-protected process must block
  // the next fixed-port sample. We never kill an unrelated owner, but allowing
  // it through here only converts an attributable recovery failure into a
  // later opaque EADDRINUSE during sample startup.
  for (const port of ports) {
    for (const pid of listenPids(port)) {
      if (protectedPids.has(pid)) continue;
      const { commandLine, cwdLink } = readPortHolder(pid);
      const ours =
        isGeneratedSampleAnchor(cwdLink, options.samplePrefixes) ||
        isGeneratedSampleAnchor(commandLine, options.samplePrefixes);
      if (ours) {
        console.error(
          `::error title=Fixed-port recovery incomplete::sample pid=${pid} still holds :${port}`,
        );
        failed = true;
      } else {
        console.log(
          `[recover-fixed-ports] refusing to start: unrelated pid=${pid} holds fixed port :${port}`,
        );
        console.error(
          `::error title=Fixed-port recovery blocked::unrelated pid=${pid} owns :${port}; stop it outside Studio QA or choose another runner`,
        );
        failed = true;
      }
    }
  }

  if (failed) {
    console.error(
      '::error title=Fixed-port recovery incomplete::refusing to start fixed-port samples with runtime residue',
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
