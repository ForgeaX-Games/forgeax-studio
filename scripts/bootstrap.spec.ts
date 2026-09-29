import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const SOURCE_ROOT = resolve(import.meta.dir, '..');
const PACKAGES = ['interface', 'server', 'forgeax'];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgeax-bootstrap-')));
  const scripts = join(root, 'scripts');
  const bin = join(root, 'bin');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  mkdirSync(join(root, 'deploy/dev/scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(SOURCE_ROOT, 'scripts/bootstrap.ts'), join(scripts, 'bootstrap.ts'));
  copyFileSync(join(SOURCE_ROOT, 'scripts/lib/sh.ts'), join(scripts, 'lib/sh.ts'));
  copyFileSync(join(SOURCE_ROOT, 'scripts/lib/toolchain.ts'), join(scripts, 'lib/toolchain.ts'));
  mkdirSync(join(scripts, 'ci'));
  const engine = join(root, 'packages/editor/packages/engine');
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(root, '.bun-version'), `${Bun.version}\n`);
  writeFileSync(join(root, '.nvmrc'), '22.22.3\n');
  writeFileSync(join(root, '.pnpm-version'), '11.7.0\n');
  writeFileSync(join(scripts, 'ci/check-toolchain-mirrors.cjs'), `exports.checkToolchainMirrors = () => (${JSON.stringify({ bun: Bun.version, node: '22.22.3', pnpm: '11.7.0', rust: '1.93.1', wasmPack: '0.14.0', engine })});\n`);
  writeFileSync(join(scripts, 'sync-harness.mjs'), 'process.exit(Number(process.env.FORGEAX_TEST_HARNESS_EXIT ?? 0));\n');
  writeFileSync(join(root, 'deploy/dev/scripts/materialize-submodules.sh'), '#!/bin/sh\nexit 0\n');
  for (const name of PACKAGES) {
    const dir = join(root, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}\n');
  }
  writeFileSync(join(bin, 'tools.cjs'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const command = process.argv[2];
    const args = process.argv.slice(3);
    fs.appendFileSync(process.env.FORGEAX_TEST_TOOL_LOG, JSON.stringify({ command, args, cwd: process.cwd(), rust: process.env.RUSTUP_TOOLCHAIN }) + '\\n');
    const expected = { bun: '${Bun.version}', node: 'v22.22.3', pnpm: '11.7.0', rustc: 'rustc 1.93.1 (fixture)', 'wasm-pack': 'wasm-pack 0.14.0' };
    if (args[0] === '--version') {
      if (command === 'pnpm' && process.cwd() !== ${JSON.stringify(engine)}) process.exit(21);
      console.log(process.env['FORGEAX_TEST_' + command.toUpperCase().replaceAll('-', '_')] ?? expected[command]);
    } else if (command === 'rustup') {
      if (args[0] === 'run') {
        if (process.env.FORGEAX_TEST_MISSING_RUST === '1') process.exit(1);
        console.log(expected.rustc);
      } else console.log(process.env.FORGEAX_TEST_TARGETS ?? 'wasm32-unknown-unknown');
    } else if (command === 'node') {
      const result = require('node:child_process').spawnSync(process.execPath, args, { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    } else if (command === 'bun' && args[0] === 'install') {
      fs.appendFileSync(process.env.FORGEAX_TEST_BUN_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
      if (path.basename(process.cwd()) === process.env.FORGEAX_TEST_FAIL_PACKAGE) process.exit(37);
    } else if (command === 'npm') {
      process.exit(39);
    }
  `);
  for (const command of ['bun', 'node', 'pnpm', 'rustc', 'rustup', 'wasm-pack', 'git', 'npm']) {
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${command}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0tools.cjs" ${command} %*\r\n`);
    } else {
      const executable = join(bin, command);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bin, 'tools.cjs'))} ${command} "$@"\n`);
      chmodSync(executable, 0o755);
    }
  }
  return { root, bin, engine, log: join(root, 'bun.log'), toolLog: join(root, 'tools.log') };
}

function runBootstrap(setup: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}, args = ['--no-toolchain']) {
  return spawnSync(process.execPath, [join(setup.root, 'scripts/bootstrap.ts'), ...args], {
    cwd: setup.bin,
    env: {
      ...process.env,
      PATH: `${setup.bin}${delimiter}${process.env.PATH ?? ''}`,
      FORGEAX_TEST_BUN_LOG: setup.log,
      FORGEAX_TEST_TOOL_LOG: setup.toolLog,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function installs(log: string) {
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { cwd: string; args: string[] });
}

describe('bootstrap package installation', () => {
  it('runs frozen installs in each package directory', () => {
    const setup = fixture();
    try {
      const result = runBootstrap(setup);
      expect(result.status).toBe(0);
      expect(installs(setup.log)).toEqual(PACKAGES.map((name) => ({
        cwd: join(setup.root, 'packages', name),
        args: ['install', '--frozen-lockfile'],
      })));
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  });

  it('stops on a failed frozen install without retrying unfrozen', () => {
    const setup = fixture();
    try {
      const result = runBootstrap(setup, { FORGEAX_TEST_FAIL_PACKAGE: 'server' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`frozen bun install failed in ${join(setup.root, 'packages/server')}`);
      expect(installs(setup.log).map(({ cwd }) => cwd)).toEqual([
        join(setup.root, 'packages/interface'),
        join(setup.root, 'packages/server'),
      ]);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  });

  it('propagates harness-sync failure before installing packages', () => {
    const setup = fixture();
    try {
      const result = runBootstrap(setup, { FORGEAX_TEST_HARNESS_EXIT: '7' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('harness sync failed');
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
    }
  });
});

describe('bootstrap exact toolchain enforcement', () => {
  for (const [name, env] of [
    ['wrong Node', { FORGEAX_TEST_NODE: 'v22.99.0' }],
    ['wrong PATH Bun', { FORGEAX_TEST_BUN: '1.4.0' }],
    ['wrong pnpm', { FORGEAX_TEST_PNPM: '9.0.0' }],
    ['wrong Rust', { FORGEAX_TEST_RUSTC: 'rustc 1.94.0 (fixture)' }],
    ['wrong wasm-pack', { FORGEAX_TEST_WASM_PACK: 'wasm-pack 0.15.0' }],
    ['missing wasm target', { FORGEAX_TEST_TARGETS: 'x86_64-unknown-linux-gnu' }],
  ] as const) {
    it(`rejects ${name} even when provisioning is disabled`, () => {
      const setup = fixture();
      try {
        const result = runBootstrap(setup, env);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/version mismatch|missing wasm32/);
        expect(() => readFileSync(setup.log)).toThrow();
      } finally { rmSync(setup.root, { recursive: true, force: true }); }
    });
  }

  it('rejects latest/stable and partial declarations before executing tools', () => {
    const setup = fixture();
    try {
      for (const value of ['latest', 'stable', '22']) {
        writeFileSync(join(setup.root, '.nvmrc'), value);
        const result = runBootstrap(setup);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('exact major.minor.patch');
      }
      expect(() => readFileSync(setup.toolLog)).toThrow();
    } finally { rmSync(setup.root, { recursive: true, force: true }); }
  });

  it('does not invoke the rustc proxy or install when the pinned toolchain is missing', () => {
    const setup = fixture();
    try {
      const result = runBootstrap(setup, { FORGEAX_TEST_MISSING_RUST: '1' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('rustc version mismatch');
      const calls = readFileSync(setup.toolLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.some((call) => call.command === 'rustc')).toBe(false);
      expect(calls.some((call) => call.args.includes('install') || call.args.includes('--install'))).toBe(false);
    } finally { rmSync(setup.root, { recursive: true, force: true }); }
  });

  it('probes pnpm in Engine and pins Rust for native commands', () => {
    const setup = fixture();
    try {
      expect(runBootstrap(setup).status).toBe(0);
      const calls = readFileSync(setup.toolLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.filter((call) => call.command === 'pnpm').every((call) => call.cwd === setup.engine)).toBe(true);
      expect(calls.find((call) => call.command === 'rustc').rust).toBe('1.93.1');
    } finally { rmSync(setup.root, { recursive: true, force: true }); }
  });

  it('stops when exact pnpm provisioning fails', () => {
    const setup = fixture();
    try {
      const result = runBootstrap(setup, { FORGEAX_TEST_PNPM: '9.0.0' }, ['--yes']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('pnpm@11.7.0 failed');
      const calls = readFileSync(setup.toolLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const npm = calls.find((call) => call.command === 'npm');
      expect(npm.cwd).toBe(setup.engine);
      expect(npm.args).toContain('--ignore-scripts');
      expect(npm.args).toContain('pnpm@11.7.0');
      expect(() => readFileSync(setup.log)).toThrow();
    } finally { rmSync(setup.root, { recursive: true, force: true }); }
  });
});
