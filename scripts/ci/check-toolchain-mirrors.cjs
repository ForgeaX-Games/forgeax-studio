#!/usr/bin/env node
// CI reads these root files before IDE/Engine are materialized. Once they are
// present, reject drift from the owning repositories' exact version contract.
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '../..');
const MIRRORS = [
  { name: 'bun', path: '.bun-version', source: 'IDE package.json#packageManager' },
  { name: 'node', path: '.nvmrc', source: 'Engine .nvmrc' },
  { name: 'pnpm', path: '.pnpm-version', source: 'Engine package.json#packageManager' },
];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function toolchainMirrorErrors(studio, versions) {
  const errors = [];
  for (const { name, path, source } of MIRRORS) {
    const actual = readFileSync(join(studio, path), 'utf8').trim();
    if (!EXACT_VERSION.test(actual)) {
      errors.push(`${path} must contain an exact major.minor.patch version (got ${JSON.stringify(actual)})`);
    } else if (actual !== versions[name]) {
      errors.push(`${path}=${actual} disagrees with ${source}=${versions[name]}`);
    }
  }
  return errors;
}

function checkToolchainMirrors(studio = ROOT) {
  const ide = join(studio, 'packages/ide');
  const { desktopToolchainSources } = require(join(ide, '.ci/toolchain-versions.cjs'));
  const versions = desktopToolchainSources(ide, studio);
  const errors = toolchainMirrorErrors(studio, versions);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return versions;
}

if (require.main === module) {
  try {
    const { bun, node, pnpm } = checkToolchainMirrors();
    console.log(`[toolchain] Studio mirrors match IDE/Engine: bun=${bun} node=${node} pnpm=${pnpm}`);
  } catch (error) {
    console.error(`[toolchain] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { checkToolchainMirrors, toolchainMirrorErrors };
