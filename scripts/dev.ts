#!/usr/bin/env bun
// scripts/dev.ts — thin wrapper that forwards to scripts/run.ts (the zero-build
// dev orchestrator). Kept as a separate entry for the historical `dev` name.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, [join(ROOT, 'scripts/run.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: ROOT,
});
process.exit(r.status ?? 0);
