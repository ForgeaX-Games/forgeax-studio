#!/usr/bin/env bun
// Provision exact owner-declared tools. --no-toolchain disables installation,
// not verification. --toolchain-only requires already materialized inputs.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyToolchainEnvironment, ensureBootstrapToolchain, ensureNativeToolchain, type ToolEnv } from './lib/toolchain.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDistribution = existsSync(resolve(ROOT, '.forgeax-public-distribution'));
let yes = process.env.FORGEAX_BOOTSTRAP_YES === '1';
let install = true;
let toolchainOnly = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--yes' || arg === '-y') yes = true;
  else if (arg === '--no-toolchain') install = false;
  else if (arg === '--toolchain-only') toolchainOnly = true;
  else if (arg === '-h' || arg === '--help') {
    console.log('Usage: bun scripts/bootstrap.ts [--yes] [--no-toolchain] [--toolchain-only]\n--no-toolchain verifies installed versions without provisioning.\n--toolchain-only requires materialized IDE/Engine inputs.');
    process.exit(0);
  } else throw new Error(`unknown arg: ${arg}`);
}

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${result.error?.message ?? result.signal ?? result.status}`);
}

async function ensure(label: string, operation: (install: boolean) => ToolEnv): Promise<void> {
  let env: ToolEnv;
  try {
    env = operation(false);
  } catch (error) {
    if (!install) throw error;
    if (!yes && process.stdin.isTTY) {
      console.warn(String(error));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((done) => rl.question(`Install the exact ${label} tools? [y/N] `, done));
      rl.close();
      yes = /^(y|yes)$/i.test(answer.trim());
    }
    if (!yes) throw new Error(`${String(error)}\nRun bootstrap --yes to provision exact versions, or install them before retrying.`);
    env = operation(true);
  }
  applyToolchainEnvironment(env);
  console.log(`[bootstrap] ${label} verified`);
}

await ensure('Bun/Node', (provision) => ensureBootstrapToolchain(ROOT, provision));
if (!toolchainOnly) {
  console.log('[bootstrap] materialize recursive submodules');
  if (process.platform === 'win32') {
    run('git', ['submodule', 'sync', '--recursive']);
    run('git', ['submodule', 'update', '--init', '--recursive']);
  } else {
    run('sh', [resolve(ROOT, 'deploy/dev/scripts/materialize-submodules.sh'), ROOT]);
  }
  if (!publicDistribution) run('bun', [resolve(ROOT, 'scripts/packages.ts'), 'ensure', '--only', 'ide']);
}
// Public source distributions carry built Engine artifacts and omit the private IDE.
if (!publicDistribution) await ensure('Engine/native', (provision) => ensureNativeToolchain(ROOT, resolve(ROOT, 'packages/editor/packages/engine'), provision));
if (toolchainOnly) {
  console.log('[bootstrap] toolchain ready (--toolchain-only)');
  process.exit(0);
}

const harnessSync = spawnSync('node', [resolve(ROOT, 'scripts/sync-harness.mjs')], { stdio: 'inherit', cwd: ROOT });
if (harnessSync.status !== 0) throw new Error('harness sync failed');
for (const directory of ['packages/interface', 'packages/server', 'packages/forgeax']) {
  const cwd = resolve(ROOT, directory);
  if (!existsSync(resolve(cwd, 'package.json'))) continue;
  const result = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`frozen bun install failed in ${cwd}`);
}
console.log('Bootstrap complete. Next: bun install, then bun fx start');
