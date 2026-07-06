#!/usr/bin/env bun
// @ts-nocheck
// scripts/build-plugins.ts — rebuild marketplace workbench-plugin dists.
//
// Server serves each wb-* plugin UI from built dist/ (serveStatic /plugins/<id>/*).
// dist/ is usually gitignored, so a fresh clone must rebuild. We rebuild when dist
// is missing, broken, OR stale (source revision ≠ dist/.forgeax-source-rev).
//
// Usage: bun scripts/build-plugins.ts [--force]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isBrokenDist,
  pluginSourceRevision,
  pluginDistStatus,
  writeDistSourceStamp,
} from './lib/plugin-dist.ts';
import { run } from './lib/sh.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const pluginsDir = join(ROOT, 'packages/marketplace/plugins');
if (!existsSync(pluginsDir)) {
  console.log('[build-plugins] no plugins dir — skip');
  process.exit(0);
}

let built = 0;
let skipped = 0;
let failed = 0;

for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!e.name.startsWith('wb-')) continue;
  if (e.isSymbolicLink()) continue;
  const d = join(pluginsDir, e.name);
  if (!existsSync(join(d, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.build) continue;

  const { distDir, reason } = pluginDistStatus(d, { force });
  if (reason === 'fresh') {
    skipped++;
    continue;
  }

  const label = reason === 'force' ? 'forced rebuild' : reason === 'broken' ? 'dist broken/missing' : 'source changed';
  console.log(`[build-plugins] building ${e.name} (${label})…`);

  const okInstall = run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: d });
  if (okInstall && run('pnpm', ['build'], { cwd: d })) {
    if (isBrokenDist(distDir)) {
      console.log(`\x1b[33m  ⚠ ${e.name} built but dist still broken\x1b[0m`);
      failed++;
    } else {
      writeDistSourceStamp(distDir, pluginSourceRevision(d));
      console.log(`  ✓ ${e.name}`);
      built++;
    }
  } else {
    console.log(`\x1b[33m  ⚠ ${e.name} build failed\x1b[0m`);
    failed++;
  }
}

console.log(`[build-plugins] done: ${built} built, ${skipped} fresh, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
