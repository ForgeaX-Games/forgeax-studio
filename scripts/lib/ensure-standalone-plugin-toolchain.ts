#!/usr/bin/env bun
// scripts/lib/ensure-standalone-plugin-toolchain.ts — CLI entry for restart.sh /
// manual preflight. SSOT logic lives in standalone-plugins.ts; run.ts imports the
// same helper so `bun fx start` and `restart.sh` stay aligned.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStandalonePluginToolchain } from './standalone-plugins.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(ROOT, 'packages/marketplace/plugins');

process.exit(ensureStandalonePluginToolchain(pluginsDir) ? 0 : 1);
