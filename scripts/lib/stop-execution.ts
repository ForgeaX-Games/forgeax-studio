import type { StopScope } from './stop-scope.ts';
import type { RuntimeProcessOwnerRequest, RuntimeProcessSnapshot } from './runtime-process-owner.ts';

export interface StopDiscoveryDeps {
  listenPids(port: number): number[];
  readSnapshot(pid: number): RuntimeProcessSnapshot | null;
  owns(snapshot: RuntimeProcessSnapshot | null, request: RuntimeProcessOwnerRequest): boolean;
  isAlive(pid: number): boolean;
  isPortBusy(port: number): boolean;
  protectedPids?: ReadonlySet<number>;
  /** Explicit operator override for an unproven target; never overrides protectedPids. */
  forceUnowned?: boolean;
  /** Exact process snapshots approved by the operator; cannot follow PID reuse or replacement. */
  approvedUnownedProcesses?: ReadonlyMap<number, RuntimeProcessSnapshot>;
}

export type StopRefusalReason = 'protected-ancestor' | 'ownership-unproven';

export interface StopRefusal {
  readonly pid: number;
  readonly source: string;
  readonly reason: StopRefusalReason;
  readonly cwd: string | null;
  readonly commandLine: string | null;
  readonly startToken: string | null;
}

export interface StopDiscovery {
  found: Map<number, string>;
  refusedPorts: Set<number>;
  refusedPids: Set<number>;
  refusals: readonly StopRefusal[];
  blocked: boolean;
}

/** Wait for a kill target to disappear without treating a short process-table race as residue. */
export async function waitForStopPids(
  pids: Iterable<number>,
  isAlive: (pid: number) => boolean,
  delay: (ms: number) => Promise<void>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<number[]> {
  const targets = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let survivors = targets.filter(isAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    survivors = targets.filter(isAlive);
  }
  return survivors;
}

export function discoverStopTargets(scope: StopScope, deps: StopDiscoveryDeps): StopDiscovery {
  const found = new Map<number, string>();
  const refusedPorts = new Set<number>();
  const refusedPids = new Set<number>();
  const refusals: StopRefusal[] = [];
  for (const target of scope.ports) {
    for (const pid of deps.listenPids(target.port)) {
      const snapshot = deps.readSnapshot(pid);
      if (deps.protectedPids?.has(pid)) {
        refusedPorts.add(target.port);
        refusals.push({ pid, source: `:${target.port} ${target.key}`, reason: 'protected-ancestor', cwd: snapshot?.cwd ?? null, commandLine: snapshot?.commandLine ?? null, startToken: snapshot?.startToken ?? null });
      } else if (deps.forceUnowned || approvedSnapshotMatches(snapshot, deps.approvedUnownedProcesses?.get(pid)) || deps.owns(snapshot, target.owner)) {
        found.set(pid, target.key);
      } else {
        refusedPorts.add(target.port);
        refusals.push({ pid, source: `:${target.port} ${target.key}`, reason: 'ownership-unproven', cwd: snapshot?.cwd ?? null, commandLine: snapshot?.commandLine ?? null, startToken: snapshot?.startToken ?? null });
      }
    }
  }
  for (const target of scope.pids) {
    if (!deps.isAlive(target.pid)) continue;
    const snapshot = deps.readSnapshot(target.pid);
    if (deps.protectedPids?.has(target.pid)) {
      refusedPids.add(target.pid);
      refusals.push({ pid: target.pid, source: target.key, reason: 'protected-ancestor', cwd: snapshot?.cwd ?? null, commandLine: snapshot?.commandLine ?? null, startToken: snapshot?.startToken ?? null });
    } else if (deps.forceUnowned || approvedSnapshotMatches(snapshot, deps.approvedUnownedProcesses?.get(target.pid)) || target.owners.some((owner) => deps.owns(snapshot, owner))) {
      found.set(target.pid, target.key);
    } else {
      refusedPids.add(target.pid);
      refusals.push({ pid: target.pid, source: target.key, reason: 'ownership-unproven', cwd: snapshot?.cwd ?? null, commandLine: snapshot?.commandLine ?? null, startToken: snapshot?.startToken ?? null });
    }
  }
  const blocked = scope.untrusted
    || refusedPorts.size > 0
    || refusedPids.size > 0
    || scope.unprovenPorts.some(deps.isPortBusy)
    || scope.unprovenPids.some(deps.isAlive);
  return { found, refusedPorts, refusedPids, refusals, blocked };
}

export function approvedSnapshotMatches(
  current: RuntimeProcessSnapshot | null,
  approved: RuntimeProcessSnapshot | undefined,
): boolean {
  return current !== null
    && approved !== undefined
    && current.pid === approved.pid
    && current.cwd === approved.cwd
    && current.commandLine === approved.commandLine
    && current.startToken !== undefined
    && current.startToken === approved.startToken;
}

export function canFinalizeStop(
  scope: StopScope,
  discovery: Pick<StopDiscovery, 'found' | 'refusedPorts' | 'refusedPids'>,
  deps: Pick<StopDiscoveryDeps, 'isAlive' | 'isPortBusy'>,
): boolean {
  return !scope.untrusted
    && !scope.unprovenPorts.some(deps.isPortBusy)
    && !scope.unprovenPids.some(deps.isAlive)
    && ![...discovery.found.keys()].some(deps.isAlive)
    && ![...discovery.refusedPorts].some(deps.isPortBusy)
    && ![...discovery.refusedPids].some(deps.isAlive)
    && !scope.ports.some((target) => deps.isPortBusy(target.port));
}
