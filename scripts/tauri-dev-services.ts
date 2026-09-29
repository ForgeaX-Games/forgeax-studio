#!/usr/bin/env bun
// Tauri owns this beforeDevCommand and its complete child process tree.
// Keep the hook alive: exiting after startup would orphan the runtime launcher.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { EventEmitter } from 'node:events';
import { checkRecursiveInput } from './fx.ts';
import { isAlive } from './lib/proc.ts';
import { resolveSourceRuntimeEnvironment, startSourceRuntime, stopSourceRuntime } from './lib/source-runtime-launcher.ts';

// The hook pipe closes when Tauri dies, including parent termination on Windows.
// Tauri remains the window owner; this fallback only releases Studio services.
export async function withTauriServiceLifetime(
  start: () => Promise<{ alive: () => boolean; stop: () => Promise<void> }>,
  input: Readable = process.stdin,
  signals: Pick<EventEmitter, 'on' | 'off'> = process,
): Promise<void> {
  let closed = input.readableEnded || input.destroyed;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const ended = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const close = () => { closed = true; finish(); };
  input.on('end', close);
  input.on('close', close);
  signals.on('SIGINT', close);
  signals.on('SIGTERM', close);
  input.resume();
  let runtime: Awaited<ReturnType<typeof start>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    if (closed) return;
    runtime = await start();
    timer = setInterval(() => {
      if (!runtime!.alive()) fail(new Error('desktop development services exited'));
    }, 500);
    await ended;
  } finally {
    clearInterval(timer);
    try { await runtime?.stop(); }
    finally {
      input.off('end', close);
      input.off('close', close);
      signals.off('SIGINT', close);
      signals.off('SIGTERM', close);
      input.pause();
    }
  }
}

export function assertTauriDevUrl(configuredUrl: string, runtimeUrl: string): void {
  if (new URL(configuredUrl).href !== new URL(runtimeUrl).href) {
    throw new Error(`Tauri devUrl ${configuredUrl} does not match RuntimeInstance ${runtimeUrl}; use bun fx start desktop`);
  }
}

export async function runTauriDevServices(root: string): Promise<void> {
  const input = checkRecursiveInput(root);
  if (!input.ok) {
    const failure = input.result.status === 'non-ready' ? input.result.failure : null;
    throw new Error(`recursive source inputs are not ready${failure ? `: ${failure.code}` : ''}; run bun install in the Studio root`);
  }
  const config = JSON.parse(readFileSync(join(root, 'packages/ide/src-tauri/tauri.conf.json'), 'utf8'));
  const overrides = JSON.parse(process.env.TAURI_CONFIG ?? '{}');
  assertTauriDevUrl(overrides.build?.devUrl ?? config.build.devUrl,
    resolveSourceRuntimeEnvironment(root, 'desktop-dev').startup.interface.localOrigin);
  await withTauriServiceLifetime(async () => {
    // Preserve the old desktop launcher's restart policy. Besides replacing an
    // owned dev stack, this recovers stale state after Windows Tauri force-kills
    // its hook tree before the pipe-close cleanup can run.
    const runtime = await startSourceRuntime({ root, profile: 'desktop-dev', existing: 'restart', lifetime: 'caller', env: process.env });
    console.log(`[tauri-dev] services ready at ${runtime.startup.interface.localOrigin}`);
    return {
      alive: () => isAlive(runtime.launcherPid),
      stop: () => stopSourceRuntime(root, resolveSourceRuntimeEnvironment(root, 'desktop-dev').childEnv),
    };
  });
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  if (process.env.FORGEAX_INTEGRATION_ROOT && resolve(process.env.FORGEAX_INTEGRATION_ROOT) !== root) {
    throw new Error('FORGEAX_INTEGRATION_ROOT must identify the owning Studio checkout');
  }
  await runTauriDevServices(root);
}
