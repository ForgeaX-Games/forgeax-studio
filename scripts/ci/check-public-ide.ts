#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Public archives do not contain internal CI definitions. Validate the shipped
// product sources here; the lifecycle smoke separately exercises real services.
const ide = resolve(import.meta.dir, '../../packages/ide');
for (const script of [
  'prepare:app-shell',
  'check:dependencies',
  'lint:types',
  'lint:biome',
  'build:web',
  'check:release-sources',
  'diagnostics',
]) {
  const diagnostics = script === 'diagnostics';
  const args = ['run', script, ...(diagnostics ? ['--', '--json'] : [])];
  const result = spawnSync(process.execPath, args, {
    cwd: ide,
    encoding: 'utf8',
    stdio: diagnostics ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  // diagnostics prints a report but exits zero even for missing components.
  if (diagnostics) {
    console.log(result.stdout);
    const report = JSON.parse(result.stdout);
    if (report.status !== 'product-ready') {
      throw new Error(`Public IDE components are not ready: ${report.status}`);
    }
  }
}
