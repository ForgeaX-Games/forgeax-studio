#!/usr/bin/env bun
// @ts-nocheck
// scripts/build-plugins.ts — rebuild marketplace workbench-plugin dists that are
// MISSING or BROKEN. Replaces build-plugins.sh.
//
// Server serves each wb-* plugin's UI from its built dist/ (serveStatic
// /plugins/<id>/*). dist/ is gitignored (each plugin its own submodule) and only
// built by setup.ts §5. The dev path (run.ts) never (re)built them, so a
// missing/partial dist makes the iframe 404 / render blank. This rebuilds ONLY
// broken ones (no index.html, or index.html references a missing assets/*.js|css).
// Already-good dists are skipped; failures are non-fatal.
//
// Usage: bun scripts/build-plugins.ts [--force]   (--force rebuilds all)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './lib/sh.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const pluginsDir = join(ROOT, 'packages/marketplace/plugins');
if (!existsSync(pluginsDir)) {
  console.log('[build-plugins] no plugins dir — skip');
  process.exit(0);
}

/** Resolve a plugin's served dist dir (most use dist/; wb-narrative uses viz/dist/). */
function distDirFor(d: string): string {
  if (existsSync(join(d, 'viz/dist/index.html')) || (existsSync(join(d, 'viz')) && !existsSync(join(d, 'dist')))) {
    return join(d, 'viz/dist');
  }
  return join(d, 'dist');
}

/** Broken = no index.html, or index.html references an asset missing on disk. */
function isBroken(dist: string): boolean {
  const indexHtml = join(dist, 'index.html');
  if (!existsSync(indexHtml)) return true;
  const html = readFileSync(indexHtml, 'utf8');
  for (const m of html.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)) {
    if (!existsSync(join(dist, m[0]))) return true;
  }
  return false;
}

let built = 0;
let skipped = 0;
let failed = 0;
for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!e.name.startsWith('wb-')) continue;
  if (e.isSymbolicLink()) continue; // node-editor apps run their own dev server
  const d = join(pluginsDir, e.name);
  if (!existsSync(join(d, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  if (!pkg.scripts?.build) continue;

  const dist = distDirFor(d);
  if (!force && !isBroken(dist)) {
    skipped++;
    continue;
  }
  console.log(`[build-plugins] building ${e.name} (dist broken/missing)…`);
  // Always install before (re)build: a stale node_modules makes tsc builds fail
  // with no obvious cause; install is cheap when already satisfied.
  const okInstall = run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: d });
  if (okInstall && run('pnpm', ['build'], { cwd: d })) {
    if (isBroken(dist)) {
      console.log(`\x1b[33m  ⚠ ${e.name} built but dist still broken\x1b[0m`);
      failed++;
    } else {
      console.log(`  ✓ ${e.name}`);
      built++;
    }
  } else {
    console.log(`\x1b[33m  ⚠ ${e.name} build failed\x1b[0m`);
    failed++;
  }
}
console.log(`[build-plugins] done: ${built} built, ${skipped} ok-skipped, ${failed} failed`);
process.exit(0);
