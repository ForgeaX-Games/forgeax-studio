#!/usr/bin/env bun
// scripts/dev.ts — historical `dev` wrapper around the source lifecycle.
// fx/source-runtime-launcher remains the only dotenv + RuntimeInstance
// projection authority before it spawns the local-runtime service-graph child.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts/fx.ts'), 'start', 'web', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    cwd: ROOT,
  },
);
process.exit(r.status ?? 0);
