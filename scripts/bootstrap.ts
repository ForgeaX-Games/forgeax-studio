#!/usr/bin/env bun
// scripts/bootstrap.ts — provision toolchain (node 22+ / pnpm / rust→wasm) on a
// fresh host. Replaces bootstrap.sh.
//
// Bun is a PREREQUISITE (this script runs under it), so unlike the bash version
// it never self-installs bun — if you can run `bun scripts/bootstrap.ts` you
// already have bun. It asserts bun is present, then ensures node22 / pnpm /
// rust+wasm-pack, and (unless --toolchain-only) inits submodules + per-subrepo
// installs.
//
// Tool installs inherently shell out to the upstream installers (curl|bash,
// rustup, npm/corepack) — those are OS package operations, not logic, so we
// invoke them directly; the cross-platform value is in the detection + control
// flow, which is what bash made fragile.
//
// Flags: --yes/-y auto-accept · --no-toolchain skip provisioning · --toolchain-only
// Env: FORGEAX_BOOTSTRAP_YES=1 (=--yes) · FORGEAX_SKIP_HARNESS_SYNC=1

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { has } from './lib/sh.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

const bold = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const warn = (s: string) => console.log(`\x1b[33m⚠\x1b[0m ${s}`);
const fail = (s: string): never => {
  console.error(`\x1b[1;31m✗ ${s}\x1b[0m`);
  process.exit(1);
};

let yes = process.env.FORGEAX_BOOTSTRAP_YES === '1';
let doToolchain = true;
let toolchainOnly = false;
for (const a of process.argv.slice(2)) {
  if (a === '--yes' || a === '-y') yes = true;
  else if (a === '--no-toolchain') doToolchain = false;
  else if (a === '--toolchain-only') toolchainOnly = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: bun scripts/bootstrap.ts [--yes] [--no-toolchain] [--toolchain-only]');
    process.exit(0);
  } else fail(`unknown arg: ${a}`);
}
if (!doToolchain && toolchainOnly) fail('--no-toolchain and --toolchain-only are mutually exclusive');

/** Prompt "msg [Y/n]"; respect --yes and non-interactive (default NO). */
async function confirm(msg: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((res) => rl.question(`  ${msg} [Y/n] `, res));
  rl.close();
  return /^(y|yes)?$/i.test(ans.trim());
}

/** Run a shell pipeline string (for upstream curl|bash installers). POSIX only. */
function shPipe(cmd: string): boolean {
  const r = spawnSync('bash', ['-c', cmd], { stdio: 'inherit' });
  return r.status === 0;
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN });
  return r.status === 0;
}

function nodeMajor(): number {
  if (!has('node')) return 0;
  const v = execFileSync('node', ['-v'], { encoding: 'utf8' }).trim();
  return Number.parseInt(v.replace(/^v/, '').split('.')[0] ?? '0', 10);
}

const HAS_BREW = process.platform === 'darwin' && has('brew');

async function ensureNode(): Promise<void> {
  if (nodeMajor() >= 22) {
    ok(`node ${execFileSync('node', ['-v'], { encoding: 'utf8' }).trim()}`);
    return;
  }
  warn(has('node') ? 'node < 22 — forgeax-server needs ≥22' : 'node not found');
  const nvmDir = process.env.NVM_DIR ?? `${process.env.HOME}/.nvm`;
  if (existsSync(`${nvmDir}/nvm.sh`)) {
    if (!(await confirm('Use nvm to install Node 22?'))) return void warn('skipping node upgrade');
    shPipe(`. "${nvmDir}/nvm.sh" && nvm install 22 && nvm use 22`);
    return;
  }
  if (HAS_BREW) {
    if (!(await confirm("Install Node 22 via 'brew install node@22'?"))) return void warn('skipping node install');
    run('brew', ['install', 'node@22']);
    return;
  }
  if (IS_WIN) {
    warn('Node 22+ required. Install from https://nodejs.org or `winget install OpenJS.NodeJS.LTS`, then re-run.');
    return;
  }
  if (!(await confirm('Install nvm + Node 22?'))) return void warn('skipping node install');
  shPipe('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash');
  shPipe(`. "${process.env.HOME}/.nvm/nvm.sh" && nvm install 22 && nvm use 22`);
}

async function ensurePnpm(): Promise<void> {
  if (has('pnpm')) {
    ok(`pnpm ${(execFileSync('pnpm', ['--version'], { encoding: 'utf8' }) || '').trim()}`);
    return;
  }
  warn('pnpm not found (engine submodule build needs it)');
  if (has('corepack')) {
    if (await confirm("Enable pnpm via 'corepack enable pnpm'?")) {
      run('corepack', ['enable', 'pnpm']);
      run('corepack', ['prepare', 'pnpm@latest', '--activate']);
      if (has('pnpm')) return void ok('pnpm enabled (corepack)');
    }
  }
  if (!(await confirm("Install pnpm via 'npm i -g pnpm'?"))) return void warn('skipping pnpm');
  run('npm', ['i', '-g', 'pnpm']);
}

async function ensureRustWasm(): Promise<void> {
  const needRust = !has('rustc');
  const needTarget =
    !needRust &&
    !(execFileSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' }) || '').includes(
      'wasm32-unknown-unknown',
    );
  const needWp = !has('wasm-pack');
  if (!needRust && !needTarget && !needWp) {
    ok('rust + wasm32 target + wasm-pack present');
    return;
  }
  if (needRust) {
    warn('rustc not found');
    if (!(await confirm('Install rust via rustup (https://rustup.rs)?')))
      return void warn('skipping rust — wgpu wasm build will be skipped');
    if (IS_WIN) {
      warn('On Windows install rustup from https://rustup.rs (rustup-init.exe), then re-run.');
      return;
    }
    shPipe("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable");
  }
  if (has('rustup')) run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  if (needWp) {
    warn('wasm-pack not found');
    if (HAS_BREW && (await confirm("Install wasm-pack via 'brew install wasm-pack'?"))) {
      run('brew', ['install', 'wasm-pack']);
    } else if (has('cargo') && (await confirm('Install wasm-pack via cargo install?'))) {
      run('cargo', ['install', 'wasm-pack']);
    } else {
      warn('skipping wasm-pack — engine wasm won\'t build');
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────
if (doToolchain) {
  bold('▶ Toolchain provisioning');
  if (!has('bun')) fail('bun not found — install it first: https://bun.sh (curl -fsSL https://bun.sh/install | bash)');
  ok(`bun ${process.versions.bun ?? execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()}`);
  await ensureNode();
  await ensurePnpm();
  await ensureRustWasm();

  if (!has('bun')) fail('bun still missing.');
  if (nodeMajor() < 22) fail(`node ${nodeMajor()} still < 22 — Studio server needs 22+.`);
  console.log();
}

if (toolchainOnly) {
  ok('toolchain ready (--toolchain-only); skipping submodule + install');
  process.exit(0);
}

bold('▶ git submodule update --init --recursive');
run('git', ['submodule', 'update', '--init', '--recursive']);

bold('▶ node scripts/sync-harness.mjs  (.forgeax-harness floating clone)');
spawnSync('node', [resolve(ROOT, 'scripts/sync-harness.mjs')], { stdio: 'inherit', cwd: ROOT });

for (const d of ['packages/interface', 'packages/server', 'packages/forgeax']) {
  const dir = resolve(ROOT, d);
  if (existsSync(resolve(dir, 'package.json'))) {
    bold(`▶ bun install (${d})`);
    if (!run('bun', ['install', '--frozen-lockfile'])) run('bun', ['install']);
  }
}

console.log('\nBootstrap complete. Next: bun install  (deps + prepare: engine build + plugins + .env), then bun fx start');
