// scripts/lib/ports.ts — stop's instance-derived port report.
//
// Do not resolve a startup environment here.  stop must make one decision from
// RuntimeInstance, rather than re-deriving a second, cwd/env-dependent port
// contract (which used to make a worktree stop sweep slot 0).

import type { RuntimeInstance } from './runtime-instance.ts';

export interface StopPort {
  readonly port: number;
  readonly service: string;
}

/** Every non-extension source port that belongs to exactly one instance. */
export function instanceStopPorts(instance: RuntimeInstance): readonly StopPort[] {
  return [
    { port: instance.ports.server, service: 'server     (forgeax-server / bun --watch)' },
    { port: instance.ports.interface, service: 'interface  (vite — serves the editor engine in-process)' },
    { port: instance.ports.engine, service: 'engine     (vite — engine-src / play-runtime)' },
    { port: instance.ports.narrative, service: 'narrative  (wb-narrative API · optional)' },
    { port: instance.ports.faceMask, service: 'face-mask  (wb-reel python sidecar · optional)' },
    { port: instance.ports.rhiReviewer, service: 'reviewer   (RHI reviewer · optional)' },
    { port: instance.ports.bridge, service: 'bridge     (external bridge · explicit only)' },
  ];
}
