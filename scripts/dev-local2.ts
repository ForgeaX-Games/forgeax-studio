#!/usr/bin/env bun
// Deprecated compatibility entry for the former third local port band.
// Runtime ports and paths belong exclusively to RuntimeInstance.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeInstance } from './lib/runtime-instance.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLOT = 2;

function usage(): void {
  console.log(`Deprecated: scripts/dev-local2.ts

This compatibility wrapper starts this worktree through the RuntimeInstance API.
It uses slot ${SLOT} only when this worktree has no instance configuration.

Migration:
  bun fx instance init --slot ${SLOT}
  bun fx start [web|desktop]

If this worktree already has a different slot, this wrapper refuses to replace it.
Use \`bun fx instance show\` to inspect the current contract.`);
}

function runFx(args: readonly string[]): number {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'scripts/fx.ts'), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

function main(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }

  const instance = resolveRuntimeInstance({ root: ROOT });
  console.warn('[deprecated] scripts/dev-local2.ts now delegates to `bun fx instance` and `bun fx start`.');
  console.warn(`[deprecated] migrate with: bun fx instance init --slot ${SLOT}`);
  if (instance.config === null) {
    console.log(`[deprecated] no instance config found; initializing this worktree with slot ${SLOT}.`);
    const initialized = runFx(['instance', 'init', '--slot', String(SLOT)]);
    if (initialized !== 0) return initialized;
  } else if (instance.slot !== SLOT) {
    console.error(
      `[deprecated] this worktree is configured for slot ${instance.slot}; refusing to replace it with slot ${SLOT}. Use \`bun fx start\` directly.`,
    );
    return 2;
  }
  return runFx(['start', ...argv]);
}

process.exit(main(process.argv.slice(2)));
