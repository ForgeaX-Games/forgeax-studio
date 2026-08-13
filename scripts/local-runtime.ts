#!/usr/bin/env bun
// The only process entry that owns the local ForgeaX service graph.
// Browser, AnyDev, Tauri dev, and the packaged Tauri app select a startup
// profile; profile-specific preparation stays behind this entry.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPackagedRuntime } from './lib/packaged-runtime.ts';
import { publishSourceRuntimeContext } from './lib/source-runtime-context.ts';
import { StartLock } from './lib/startlock.ts';
import {
  isStartupProfile,
  resolveStartupEnvironment,
  startupProcessEnv,
  type StartupProfile,
} from './lib/startup-environment.ts';

const ROOT = process.env.FORGEAX_WORKSPACE_ROOT
  ? resolve(process.env.FORGEAX_WORKSPACE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function requestedStartupProfile(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): StartupProfile {
  const equals = argv.find((arg) => arg.startsWith('--profile='));
  const index = argv.indexOf('--profile');
  const value =
    equals?.slice('--profile='.length) ??
    (index >= 0 ? argv[index + 1] : undefined) ??
    env.FORGEAX_STARTUP_PROFILE ??
    'web-dev';
  if (!isStartupProfile(value)) {
    throw new Error(`invalid startup profile '${value}'`);
  }
  return value;
}

async function main(): Promise<void> {
  const profile = requestedStartupProfile(process.argv.slice(2));
  // This secret exists only across the parent → launcher exec boundary. Remove
  // it before dotenv/startup projection so no service child, log, or state file
  // can inherit it.
  const handoffToken = process.env.FORGEAX_START_LOCK_HANDOFF_TOKEN;
  delete process.env.FORGEAX_START_LOCK_HANDOFF_TOKEN;
  // A desktop bundle's ROOT is read-only app Resources, not a source checkout.
  // Only source profiles participate in the source run.lock/handoff protocol.
  const lock = profile === 'desktop-prod'
    ? null
    : handoffToken ? StartLock.adopt(ROOT, handoffToken, process.ppid) : StartLock.acquireForRuntime(ROOT);
  try {
    // Source children inherit the one final environment resolved by
    // source-runtime-launcher. Never re-read dotenv here: doing so would let a
    // file value override the supplied parent after readiness was derived.
    const startup = resolveStartupEnvironment({
      root: ROOT,
      profile,
      env: process.env,
    });
    if (startup.sourceLayout === 'source') {
      // The launcher already projected this exact environment. Hand the
      // resolved object to run.ts in-process; do not re-project or serialize it.
      publishSourceRuntimeContext(startup);
      await import('./run.ts');
      return;
    }
    Object.assign(process.env, startupProcessEnv(startup));
    await runPackagedRuntime(startup);
    lock?.release();
  } catch (error) {
    lock?.release();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[local-runtime] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
}
