#!/usr/bin/env bun
// @ts-nocheck
// scripts/build-extensions.ts — rebuild marketplace workbench-plugin dists that are
// MISSING or BROKEN. Replaces build-plugins.sh (retired).
//
// Server serves each wb-* plugin's UI from its built dist/ (serveStatic
// /extensions/<id>/*). dist/ is gitignored (each plugin its own submodule) and only
// built by prepare.ts (plugins step). The dev path (run.ts) never (re)built them, so a
// missing/partial dist makes the iframe 404 / render blank. This rebuilds ONLY
// broken ones (no index.html, or index.html references a missing assets/*.js|css).
// Already-good dists are skipped; failures are non-fatal by default, with the
// --fail-on-error mode used by the nightly admission workflow. The --only
// selector lets an owner admission build exactly the extension its contract
// consumes instead of treating unrelated marketplace packages as prerequisites.
//
// Usage: bun scripts/build-extensions.ts [--force] [--fail-on-error] [--only <package-or-directory>]
//   (--force rebuilds all; --fail-on-error is for CI admission)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extensionBuildCommands,
  UnsupportedExtensionPackageManagerError,
} from './lib/extension-build.ts';
import { run } from './lib/sh.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const failOnError = process.argv.includes('--fail-on-error');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];
if (onlyIndex !== -1 && (!only || only.startsWith('--'))) {
  console.error('[build-plugins] --only requires a package name or directory name');
  process.exit(2);
}

const pluginsDir = join(ROOT, 'packages/marketplace/extensions');
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
let selected = 0;
for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!e.name.startsWith('wb-')) continue;
  if (e.isSymbolicLink()) continue; // node-editor apps run their own dev server
  const d = join(pluginsDir, e.name);
  if (!existsSync(join(d, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) as {
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  if (only && only !== e.name && only !== pkg.name) continue;
  selected++;
  if (!pkg.scripts?.build) continue;

  const dist = distDirFor(d);
  if (!force && !isBroken(dist)) {
    skipped++;
    continue;
  }
  console.log(`[build-plugins] building ${e.name} (dist broken/missing)…`);
  // Always install before (re)build: a stale node_modules makes tsc builds fail
  // with no obvious cause; install is cheap when already satisfied.
  let commands;
  try {
    commands = extensionBuildCommands(pkg);
  } catch (error) {
    if (!(error instanceof UnsupportedExtensionPackageManagerError)) throw error;
    console.log(`\x1b[33m  ⚠ ${e.name} ${error.message}\x1b[0m`);
    failed++;
    continue;
  }
  const [[installCommand, installArgs], [buildCommand, buildArgs]] = commands;
  const okInstall = run(installCommand, [...installArgs], { cwd: d });
  if (okInstall && run(buildCommand, [...buildArgs], { cwd: d })) {
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
if (only && selected === 0) {
  console.log(`\x1b[33m  ⚠ no extension matched --only ${only}\x1b[0m`);
  failed++;
}
console.log(`[build-plugins] done: ${built} built, ${skipped} ok-skipped, ${failed} failed`);
process.exit(failOnError && failed > 0 ? 1 : 0);
