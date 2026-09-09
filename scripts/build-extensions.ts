#!/usr/bin/env bun
// @ts-nocheck
// scripts/build-extensions.ts — rebuild owner-repository Extension frontend artifacts that are
// MISSING or BROKEN. Replaces build-plugins.sh (retired).
//
// Server serves each Extension UI from its convention-derived runtime HTML under
// /extensions/<id>/*. Built artifacts are gitignored, so a missing/partial
// artifact makes the iframe 404 / render blank. This rebuilds only broken ones.
// Already-good dists are skipped; failures are non-fatal by default, with the
// --fail-on-error mode used by the nightly admission workflow. The --only
// selector lets an owner admission build exactly the extension its contract
// consumes instead of treating unrelated marketplace packages as prerequisites.
//
// Usage: bun scripts/build-extensions.ts --root <extensions-root> [--force] [--fail-on-error] [--only <package-or-directory>]
//   (--force rebuilds all; --fail-on-error is for CI admission)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  extensionFrontendArtifact,
  extensionPackageManagerFallback,
  extensionPreparationCommands,
  isExtensionSourceDirectory,
  matchesExtensionSelector,
  type ExtensionManifest,
  type ExtensionPackage,
  UnsupportedExtensionPackageManagerError,
} from './lib/extension-build.ts';
import { run } from './lib/sh.ts';

const force = process.argv.includes('--force');
const failOnError = process.argv.includes('--fail-on-error');
const retiredExtensionIds = new Set(['@forgeax-extension/video-game']);
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];
if (onlyIndex !== -1 && (!only || only.startsWith('--'))) {
  console.error('[build-extensions] --only requires a package name or directory name');
  process.exit(2);
}

const rootIndex = process.argv.indexOf('--root');
const rootArg = rootIndex === -1 ? process.env.FORGEAX_EXTENSION_SOURCE_ROOT : process.argv[rootIndex + 1];
if (!rootArg || rootArg.startsWith('--')) {
  console.error('[build-extensions] --root <extensions-root> or FORGEAX_EXTENSION_SOURCE_ROOT is required');
  process.exit(2);
}
const pluginsDir = resolve(rootArg);
if (!existsSync(pluginsDir)) {
  console.error(`[build-extensions] extension source root does not exist: ${pluginsDir}`);
  process.exit(2);
}

let built = 0;
let skipped = 0;
let failed = 0;
let selected = 0;

// Local file dependencies resolve their source imports from the shared package
// directory, so consumer-local node_modules cannot satisfy the shared source's
// own imports. Prepare shared packages before any consuming Extension build.
const sharedPackagesDir = join(pluginsDir, '_shared');
if (existsSync(sharedPackagesDir)) {
  for (const entry of readdirSync(sharedPackagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(sharedPackagesDir, entry.name);
    const packagePath = join(dir, 'package.json');
    if (!existsSync(packagePath)) continue;
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as ExtensionPackage;
    try {
      const fallback = extensionPackageManagerFallback({
        bunLock: existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb')),
        pnpmLock: existsSync(join(dir, 'pnpm-lock.yaml')),
        pnpmWorkspace: existsSync(join(dir, 'pnpm-workspace.yaml')),
      });
      const [[installCommand, installArgs]] = extensionPreparationCommands(pkg, fallback, {
        hasFrontend: false,
        artifactBroken: false,
        force: false,
      });
      if (!run(installCommand, [...installArgs], { cwd: dir })) {
        console.log(`\x1b[33m  ⚠ shared/${entry.name} dependency install failed\x1b[0m`);
        failed++;
      }
    } catch (error) {
      if (!(error instanceof UnsupportedExtensionPackageManagerError)) throw error;
      console.log(`\x1b[33m  ⚠ shared/${entry.name} ${error.message}\x1b[0m`);
      failed++;
    }
  }
}

/** Resolve the runtime HTML artifact served through /extensions/:id. */
function frontendArtifactFor(d: string, manifest: ExtensionManifest): string | undefined {
  const artifact = extensionFrontendArtifact(manifest);
  return artifact ? resolve(d, artifact) : undefined;
}

/** Broken = no runtime HTML, or that HTML references an asset missing on disk. */
function isBroken(entry: string): boolean {
  if (!existsSync(entry)) return true;
  if (!entry.endsWith('.html')) return false;
  const html = readFileSync(entry, 'utf8');
  for (const m of html.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)) {
    if (!existsSync(join(dirname(entry), m[0]))) return true;
  }
  return false;
}

for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
  const d = join(pluginsDir, e.name);
  const manifestPath = join(d, 'forgeax-extension.json');
  const packagePath = join(d, 'package.json');
  if (!isExtensionSourceDirectory(e.name, {
    symbolicLink: e.isSymbolicLink(),
    hasManifest: existsSync(manifestPath),
    hasPackage: existsSync(packagePath),
  })) continue;
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as ExtensionPackage;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
  if (manifest.id && retiredExtensionIds.has(manifest.id)) continue;
  if (!matchesExtensionSelector(only, e.name, pkg, manifest)) continue;
  selected++;

  // Prepare dependencies independently of artifact freshness. A copied/cached
  // dist is not evidence that backend/setup dependencies exist locally.
  let commands;
  try {
    const fallback = extensionPackageManagerFallback({
      bunLock: existsSync(join(d, 'bun.lock')) || existsSync(join(d, 'bun.lockb')),
      pnpmLock: existsSync(join(d, 'pnpm-lock.yaml')),
      pnpmWorkspace: existsSync(join(d, 'pnpm-workspace.yaml')),
    });
    const frontendArtifact = frontendArtifactFor(d, manifest);
    commands = extensionPreparationCommands(pkg, fallback, {
      hasFrontend: frontendArtifact !== undefined,
      artifactBroken: frontendArtifact ? isBroken(frontendArtifact) : false,
      force,
    });
  } catch (error) {
    if (!(error instanceof UnsupportedExtensionPackageManagerError)) throw error;
    console.log(`\x1b[33m  ⚠ ${e.name} ${error.message}\x1b[0m`);
    failed++;
    continue;
  }
  const [[installCommand, installArgs], buildCommandSpec] = commands;
  const okInstall = run(installCommand, [...installArgs], { cwd: d });
  if (!okInstall) {
    console.log(`\x1b[33m  ⚠ ${e.name} dependency install failed\x1b[0m`);
    failed++;
    continue;
  }
  const frontendArtifact = frontendArtifactFor(d, manifest);
  if (!buildCommandSpec) {
    skipped++;
    continue;
  }
  console.log(`[build-extensions] building ${e.name} (frontend artifact broken/missing)…`);
  const [buildCommand, buildArgs] = buildCommandSpec;
  if (run(buildCommand, [...buildArgs], { cwd: d })) {
    if (!frontendArtifact || isBroken(frontendArtifact)) {
      console.log(`\x1b[33m  ⚠ ${e.name} built but frontend artifact is still broken\x1b[0m`);
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
console.log(`[build-extensions] done: ${built} built, ${skipped} ok-skipped, ${failed} failed`);
process.exit(failOnError && failed > 0 ? 1 : 0);
