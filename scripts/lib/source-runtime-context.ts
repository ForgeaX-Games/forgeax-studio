import type { StartupEnvironment } from './startup-environment.ts';

let pending: StartupEnvironment | null = null;

/** In-process handoff from local-runtime.ts to its single dynamic run.ts import. */
export function publishSourceRuntimeContext(startup: StartupEnvironment): void {
  if (startup.sourceLayout !== 'source') throw new Error('cannot publish a bundled runtime as source context');
  if (pending !== null) throw new Error('source runtime context is already published');
  pending = startup;
}

export function consumeSourceRuntimeContext(): StartupEnvironment {
  const startup = pending;
  pending = null;
  if (startup === null) {
    throw new Error('source runtime context is unavailable; start through `bun fx start`');
  }
  return startup;
}
