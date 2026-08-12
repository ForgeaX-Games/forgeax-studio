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
}

export type StopRefusalReason = 'protected-ancestor' | 'ownership-unproven';

export interface StopRefusal {
  readonly pid: number;
  readonly source: string;
  readonly reason: StopRefusalReason;
  readonly cwd: string | null;
}

export interface StopDiscovery {
  found: Map<number, string>;
  refusedPorts: Set<number>;
  refusedPids: Set<number>;
  refusals: readonly StopRefusal[];
  blocked: boolean;
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
        refusals.push({ pid, source: `:${target.port} ${target.key}`, reason: 'protected-ancestor', cwd: snapshot?.cwd ?? null });
      } else if (deps.forceUnowned || deps.owns(snapshot, target.owner)) {
        found.set(pid, target.key);
      } else {
        refusedPorts.add(target.port);
        refusals.push({ pid, source: `:${target.port} ${target.key}`, reason: 'ownership-unproven', cwd: snapshot?.cwd ?? null });
      }
    }
  }
  for (const target of scope.pids) {
    if (!deps.isAlive(target.pid)) continue;
    const snapshot = deps.readSnapshot(target.pid);
    if (deps.protectedPids?.has(target.pid)) {
      refusedPids.add(target.pid);
      refusals.push({ pid: target.pid, source: target.key, reason: 'protected-ancestor', cwd: snapshot?.cwd ?? null });
    } else if (deps.forceUnowned || target.owners.some((owner) => deps.owns(snapshot, owner))) {
      found.set(target.pid, target.key);
    } else {
      refusedPids.add(target.pid);
      refusals.push({ pid: target.pid, source: target.key, reason: 'ownership-unproven', cwd: snapshot?.cwd ?? null });
    }
  }
  const blocked = scope.untrusted
    || refusedPorts.size > 0
    || refusedPids.size > 0
    || scope.unprovenPorts.some(deps.isPortBusy)
    || scope.unprovenPids.some(deps.isAlive);
  return { found, refusedPorts, refusedPids, refusals, blocked };
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
