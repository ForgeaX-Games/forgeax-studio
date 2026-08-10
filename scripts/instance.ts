#!/usr/bin/env bun
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  resolveRuntimeInstance,
  writeRuntimeInstanceConfig,
} from './lib/runtime-instance.ts';
import { StartLock } from './lib/startlock.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function runInstanceCommand(argv: readonly string[], root = ROOT): void {
  const [command, ...args] = argv;
  switch (command) {
    case 'init':
      init(args, root);
      return;
    case 'show':
      if (args.length > 0) throw new Error('usage: bun fx instance show');
      show(root);
      return;
    default:
      throw new Error('usage: bun fx instance <init|show>');
  }
}

function init(args: readonly string[], root: string): void {
  let slot: number | undefined;
  let isolateUser = false;
  let envFile: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--isolate-user') {
      isolateUser = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--slot' || arg === '--env-file') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--slot') {
        if (!/^\d+$/.test(value)) throw new Error('--slot must be an integer');
        slot = Number(value);
      } else {
        envFile = value;
      }
    } else {
      throw new Error(`unknown instance init argument '${arg}'`);
    }
  }
  if (slot === undefined) throw new Error('instance init requires --slot N');
  const lock = new StartLock(root);
  lock.acquireForInstanceInitOrThrow();
  try {
    const stateFile = resolve(root, '.forgeax', 'runtime', 'web-dev.json');
    if (existsSync(stateFile)) {
      throw new Error(
        `runtime state exists at '${stateFile}'; run 'bun fx stop' for this instance, then retry 'bun fx instance init'`,
      );
    }
    writeRuntimeInstanceConfig({ root, slot, isolateUser, envFile, force });
    show(root);
  } finally {
    lock.release();
  }
}

function show(root: string): void {
  const instance = resolveRuntimeInstance({ root });
  // JSON.stringify only exposes a path for envFile, never the file's contents.
  console.log(JSON.stringify(instance, null, 2));
}

if (import.meta.main) {
  try {
    runInstanceCommand(process.argv.slice(2));
  } catch (error) {
    console.error(`[instance] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
