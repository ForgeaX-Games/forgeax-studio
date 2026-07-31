#!/usr/bin/env bun
// The only process entry that owns the local ForgeaX service graph.
// Browser, AnyDev, Tauri dev, and the packaged Tauri app select a startup
// profile; profile-specific preparation stays behind this entry.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './lib/env.ts';
import { runPackagedRuntime } from './lib/packaged-runtime.ts';
import {
  isStartupProfile,
  resolveStartupEnvironment,
  startupProcessEnv,
  type StartupProfile,
} from './lib/startup-environment.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function requestedStartupProfile(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): StartupProfile {
  const equals = argv.find((arg) => arg.startsWith('--profile='));
  const index = argv.indexOf('--profile');
  const value = equals?.slice('--profile='.length)
    ?? (index >= 0 ? argv[index + 1] : undefined)
    ?? env.FORGEAX_STARTUP_PROFILE
    ?? 'web-dev';
  if (!isStartupProfile(value)) {
    throw new Error(`invalid startup profile '${value}'`);
  }
  return value;
}

async function main(): Promise<void> {
  const profile = requestedStartupProfile(process.argv.slice(2));
  if (profile !== 'desktop-prod') {
    loadDotenv(process.env.FORGEAX_ENV_FILE ?? join(ROOT, '.env'));
  }
  const startup = resolveStartupEnvironment({
    root: ROOT,
    profile,
    env: process.env,
  });
  Object.assign(process.env, startupProcessEnv(startup));

  if (startup.sourceLayout === 'source') {
    await import('./run.ts');
    return;
  }
  await runPackagedRuntime(startup);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[local-runtime] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
