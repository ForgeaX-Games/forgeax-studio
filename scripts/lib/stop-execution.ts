import type { StopScope } from './stop-scope.ts';
import type { RuntimeProcessOwnerRequest, RuntimeProcessSnapshot } from './runtime-process-owner.ts';

export interface StopDiscoveryDeps {
  listenPids(port: number): number[];
  readSnapshot(pid: number): RuntimeProcessSnapshot | null;
  owns(snapshot: RuntimeProcessSnapshot | null, request: RuntimeProcessOwnerRequest): boolean;
  isAlive(pid: number): boolean;
  isPortBusy(port: number): boolean;
  protectedPids?: ReadonlySet<number>;
}

export interface StopDiscovery {
  found: Map<number, string>;
  refusedPorts: Set<number>;
  refusedPids: Set<number>;
  blocked: boolean;
}

export function discoverStopTargets(scope: StopScope, deps: StopDiscoveryDeps): StopDiscovery {
  const found = new Map<number, string>();
  const refusedPorts = new Set<number>();
  const refusedPids = new Set<number>();
  for (const target of scope.ports) {
    for (const pid of deps.listenPids(target.port)) {
      if (deps.owns(deps.readSnapshot(pid), target.owner)) {
        found.set(pid, target.key);
      } else {
        refusedPorts.add(target.port);
      }
    }
  }
  for (const target of scope.pids) {
    if (!deps.isAlive(target.pid)) continue;
    const snapshot = deps.readSnapshot(target.pid);
    if (deps.protectedPids?.has(target.pid) || !target.owners.some((owner) => deps.owns(snapshot, owner))) {
      refusedPids.add(target.pid);
    } else {
      found.set(target.pid, target.key);
    }
  }
  const blocked = scope.untrusted
    || refusedPorts.size > 0
    || refusedPids.size > 0
    || scope.unprovenPorts.some(deps.isPortBusy)
    || scope.unprovenPids.some(deps.isAlive);
  return { found, refusedPorts, refusedPids, blocked };
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
