import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
export type ToolEnv = NodeJS.ProcessEnv;
export type ToolVersions = { bun: string; node: string; pnpm: string };
export type ProductToolVersions = ToolVersions & { rust: string; wasmPack: string; engine: string };

export function exactVersion(value: string, source: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${source} must declare an exact major.minor.patch version; got ${JSON.stringify(value)}`);
  return value;
}

export function bootstrapVersions(root: string): ToolVersions {
  return Object.fromEntries([
    ['bun', '.bun-version'], ['node', '.nvmrc'], ['pnpm', '.pnpm-version'],
  ].map(([name, file]) => [name, exactVersion(readFileSync(join(root, file), 'utf8').trim(), file)])) as ToolVersions;
}

export function productToolVersions(root: string): ProductToolVersions {
  const { checkToolchainMirrors } = require(join(root, 'scripts/ci/check-toolchain-mirrors.cjs'));
  return checkToolchainMirrors(root);
}

function probe(command: string, cwd: string, env: ToolEnv, args = ['--version']): string | null {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function execute(command: string, args: string[], cwd: string, env: ToolEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${result.error?.message ?? result.signal ?? result.status}`);
}

function prepend(env: ToolEnv, directory: string): void {
  env.PATH = `${directory}${delimiter}${env.PATH ?? ''}`;
}

function requireVersion(command: string, expected: string, cwd: string, env: ToolEnv): void {
  const actual = probe(command, cwd, env);
  if (actual !== expected) throw new Error(`${command} version mismatch in ${cwd}: expected ${expected}, got ${actual ?? 'missing or failed probe'}`);
}

// No source repositories are required at this stage. Root files are verified
// against their owners as soon as the product sources have been materialized.
export function ensureBootstrapToolchain(root: string, install: boolean, input: ToolEnv = process.env): ToolEnv {
  const versions = bootstrapVersions(root);
  const env = { ...input };
  if (process.versions.bun !== versions.bun) throw new Error(`running Bun version mismatch: expected ${versions.bun}, got ${process.versions.bun ?? 'not Bun'}`);
  requireVersion('bun', versions.bun, root, env);
  if (probe('node', root, env) !== `v${versions.node}` && install) {
    // Use an existing nvm installation, whose Node installer verifies the
    // upstream archive checksum. Never execute an unverified downloaded script.
    const nvm = join(env.NVM_DIR ?? join(env.HOME ?? '', '.nvm'), 'nvm.sh');
    if (process.platform === 'win32' || !existsSync(nvm)) {
      throw new Error(`Install Node ${versions.node} (or configure an existing nvm installation), then rerun bootstrap.`);
    }
    execute('bash', ['-c', '. "$1" && nvm install "$2"', 'forgeax-nvm', nvm, versions.node], root, env);
    const node = probe('bash', root, env, ['-c', '. "$1" && nvm which "$2"', 'forgeax-nvm', nvm, versions.node]);
    if (!node || !existsSync(node)) throw new Error(`nvm did not return a Node ${versions.node} executable`);
    prepend(env, dirname(node));
  }
  requireVersion('node', `v${versions.node}`, root, env);
  return env;
}

export function ensureEngineToolchain(root: string, install: boolean, input: ToolEnv = process.env): ToolEnv {
  const versions = productToolVersions(root);
  const env = ensureBootstrapToolchain(root, install, input);
  const prefix = join(root, '.forgeax/toolchain', `pnpm-${versions.pnpm}`);
  const bin = join(prefix, 'node_modules/.bin');
  if (existsSync(bin)) prepend(env, bin);
  if (probe('pnpm', versions.engine, env) !== versions.pnpm && install) {
    // npm verifies registry integrity; install no lifecycle scripts and change
    // neither the global package manager nor the Engine lockfile.
    execute('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', `pnpm@${versions.pnpm}`], versions.engine, env);
    prepend(env, bin);
  }
  requireVersion('pnpm', versions.pnpm, versions.engine, env);
  return env;
}

export function ensureNativeToolchain(root: string, engine: string, install: boolean, input: ToolEnv = process.env): ToolEnv {
  const versions = productToolVersions(root);
  if (realpathSync(engine) !== realpathSync(versions.engine)) throw new Error(`wrong Engine working directory: expected ${versions.engine}, got ${engine}`);
  const env = ensureEngineToolchain(root, install, input);
  env.RUSTUP_TOOLCHAIN = versions.rust;
  // `rustc` through a rustup proxy can implicitly install a missing toolchain.
  // `rustup run` without --install fails instead, keeping verification read-only.
  const rustMatches = () => probe('rustup', engine, env, ['run', versions.rust, 'rustc', '--version'])?.startsWith(`rustc ${versions.rust} `) === true
    && probe('rustc', engine, env)?.startsWith(`rustc ${versions.rust} `) === true;
  if (!rustMatches() && install) execute('rustup', ['toolchain', 'install', versions.rust, '--profile', 'minimal'], engine, env);
  if (!rustMatches()) throw new Error(`rustc version mismatch: expected ${versions.rust}; run rustup toolchain install ${versions.rust}`);
  const targets = () => probe('rustup', engine, env, ['target', 'list', '--installed', '--toolchain', versions.rust]);
  if (!targets()?.split(/\r?\n/).includes('wasm32-unknown-unknown') && install) {
    execute('rustup', ['target', 'add', 'wasm32-unknown-unknown', '--toolchain', versions.rust], engine, env);
  }
  if (!targets()?.split(/\r?\n/).includes('wasm32-unknown-unknown')) throw new Error(`Rust ${versions.rust} is missing wasm32-unknown-unknown`);
  const prefix = join(root, '.forgeax/toolchain', `wasm-pack-${versions.wasmPack}`);
  const bin = join(prefix, 'bin');
  if (existsSync(bin)) prepend(env, bin);
  if (probe('wasm-pack', engine, env) !== `wasm-pack ${versions.wasmPack}` && install) {
    execute('cargo', ['install', 'wasm-pack', '--version', versions.wasmPack, '--locked', '--root', prefix], engine, env);
    prepend(env, bin);
  }
  requireVersion('wasm-pack', `wasm-pack ${versions.wasmPack}`, engine, env);
  return env;
}

export function applyToolchainEnvironment(env: ToolEnv): void {
  // Propagate only fields this module owns; never copy secrets or a whole
  // environment snapshot into generated state or a receipt.
  if (env.PATH !== undefined) process.env.PATH = env.PATH;
  if (env.RUSTUP_TOOLCHAIN !== undefined) process.env.RUSTUP_TOOLCHAIN = env.RUSTUP_TOOLCHAIN;
}
