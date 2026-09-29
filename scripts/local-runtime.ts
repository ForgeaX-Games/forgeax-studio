#!/usr/bin/env bun
// Source-development service entry for browser, AnyDev, and Tauri dev.
// Packaged applications are owned by the independent IDE runtime.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishSourceRuntimeContext } from './lib/source-runtime-context.ts';
import { StartLock } from './lib/startlock.ts';
import {
  isStartupProfile,
  resolveStartupEnvironment,
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
  const lock = handoffToken ? StartLock.adopt(ROOT, handoffToken, process.ppid) : StartLock.acquireForRuntime(ROOT);
  try {
    // Source children inherit the one final environment resolved by
    // source-runtime-launcher. Never re-read dotenv here: doing so would let a
    // file value override the supplied parent after readiness was derived.
    const startup = resolveStartupEnvironment({
      root: ROOT,
      profile,
      env: process.env,
    });
    publishSourceRuntimeContext(startup);
    await import('./run.ts');
  } catch (error) {
    lock.release();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[local-runtime] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
}
