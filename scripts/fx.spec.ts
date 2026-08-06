// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanableFloatingRepoPaths,
  cleanTreeFlags,
  cleanLockAction,
  didCreateStash,
  formatUpdateReport,
  floatingRepoExclusionArgs,
  hasActiveGitProcess,
  parseSubmodulePaths,
  resolveCommand,
  startBusyPorts,
  stashPopArgsForRef,
  submoduleUpdateArgs,
  updateShouldStash,
} from './fx.ts';

const ROOT = resolve(import.meta.dir, '..');
const script = (name: string) => resolve(ROOT, 'scripts', name);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('scripts/fx.ts command routing', () => {
  it('starts the dev stack with a development NODE_ENV regardless of its parent shell', () => {
    const source = readFileSync(script('run.ts'), 'utf8');

    expect(source).toContain("const DEV_NODE_ENV = 'development'");
    expect(source).toMatch(/const devServiceEnv[\s\S]*NODE_ENV:\s*DEV_NODE_ENV/);
    expect(source).toContain('new ServiceSupervisor({');
    expect(source).toContain("spawn: { ...opts, env: devServiceEnv(opts.env) }");
  });

  it('keeps package.json scripts focused on fx plus checks', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.fx).toBe('bun scripts/fx.ts');
    expect(pkg.scripts.prepare).toBe('bun scripts/prepare.ts');
    for (const legacy of ['setup', 'bootstrap', 'dev', 'dev:local', 'start', 'stop', 'app', 'web', 'build:plugins', 'version']) {
      expect(pkg.scripts[legacy]).toBeUndefined();
    }
  });

  it('routes setup as an internal deprecated command (not setup.ts)', () => {
    expect(resolveCommand(['setup'])).toEqual({ type: 'internal', command: 'setup', args: [] });
    expect(resolveCommand(['setup', '--start', '--no-plugins'])).toEqual({ type: 'internal', command: 'setup', args: ['--start', '--no-plugins'] });
  });

  it('documents setup as deprecated in usage text', () => {
    const source = readFileSync(script('fx.ts'), 'utf8');
    expect(source).toMatch(/deprecated|delegates to: bun install/i);
    expect(source).toContain('bun install');
    expect(source).not.toContain("['setup', 'setup.ts']");
  });

  it('does not keep install as a setup alias', () => {
    expect(resolveCommand(['install', '--no-plugins'])).toEqual({
      type: 'unknown',
      command: 'install',
      args: ['--no-plugins'],
    });
  });

  it('does not expose bootstrap as a user-facing fx command', () => {
    expect(resolveCommand(['bootstrap'])).toEqual({
      type: 'unknown',
      command: 'bootstrap',
      args: [],
    });
  });

  it('keeps start as the single client-launching lifecycle command', () => {
    expect(resolveCommand(['start'])).toEqual({ type: 'internal', command: 'start', args: [] });
    expect(resolveCommand(['start', 'web', '--fresh'])).toEqual({ type: 'internal', command: 'start', args: ['web', '--fresh'] });
    expect(resolveCommand(['start', 'desktop', 'debug'])).toEqual({ type: 'internal', command: 'start', args: ['desktop', 'debug'] });
  });

  it('checks every fixed stack port before start launches a new stack', () => {
    const owner = (port: number) => (port === 18900 || port === 15173 ? `pid-${port}` : '');

    expect(startBusyPorts(owner)).toEqual([
      ['server', 18900, 'pid-18900'],
      ['engine', 15173, 'pid-15173'],
    ]);
  });

  it('does not declare or launch the retired Studio-owned gateway relay', () => {
    const runSource = readFileSync(script('run.ts'), 'utf8');
    const portsSource = readFileSync(resolve(ROOT, 'scripts', 'lib', 'ports.ts'), 'utf8');
    expect(runSource).not.toContain('PORT_GATEWAY_BRIDGE');
    expect(runSource).not.toContain('VITE_FORGEAX_BRIDGE');
    expect(runSource).not.toContain('gateway-bridge-server.mjs');
    expect(runSource).not.toContain('gw-bridge');
    expect(portsSource).not.toContain('PORT_GATEWAY_BRIDGE');
    expect(portsSource).not.toContain('15295');
    expect(startBusyPorts((port) => (port === 15295 ? 'pid-15295' : ''))).toEqual([]);
  });

  it('does not expose legacy dev/web/app commands at the fx top level', () => {
    expect(resolveCommand(['dev'])).toEqual({ type: 'unknown', command: 'dev', args: [] });
    expect(resolveCommand(['dev:local'])).toEqual({ type: 'unknown', command: 'dev:local', args: [] });
    expect(resolveCommand(['web'])).toEqual({ type: 'unknown', command: 'web', args: [] });
    expect(resolveCommand(['app'])).toEqual({ type: 'unknown', command: 'app', args: [] });
  });

  it('routes stop to the existing TS implementation', () => {
    expect(resolveCommand(['stop'])).toEqual({ type: 'script', script: script('stop.ts'), args: [] });
  });

  it('routes multi-repo lifecycle commands to repos.ts with the subcommand prepended', () => {
    expect(resolveCommand(['sync', '--dry-run'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['sync', '--dry-run'] });
    expect(resolveCommand(['check', '--all'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['check', '--all'] });
    expect(resolveCommand(['commit', '-m', 'msg', '--push'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['commit', '-m', 'msg', '--push'] });
    expect(resolveCommand(['bump', 'packages/interface'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['bump', 'packages/interface'] });
    expect(resolveCommand(['versions'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['versions'] });
  });

  it('routes build and version aliases', () => {
    expect(resolveCommand(['build', 'plugins', '--force'])).toEqual({
      type: 'script',
      script: script('build-extensions.ts'),
      args: ['--force'],
    });
    expect(resolveCommand(['build', 'desktop'])).toEqual({ type: 'script', script: script('desktop.ts'), args: ['build'] });
    expect(resolveCommand(['build', 'app'])).toEqual({ type: 'internal', command: 'build', args: ['app'] });
    expect(resolveCommand(['build:plugins'])).toEqual({ type: 'script', script: script('build-extensions.ts'), args: [] });
    expect(resolveCommand(['version', 'json'])).toEqual({ type: 'script', script: script('lib/version.ts'), args: ['json'] });
  });

  it('keeps meta commands inside scripts/fx.ts', () => {
    expect(resolveCommand(['update', '--dry-run'])).toEqual({ type: 'internal', command: 'update', args: ['--dry-run'] });
    expect(resolveCommand(['status'])).toEqual({ type: 'internal', command: 'status', args: [] });
    expect(resolveCommand(['doctor', '--fix'])).toEqual({ type: 'internal', command: 'doctor', args: ['--fix'] });
    expect(resolveCommand(['restart'])).toEqual({ type: 'internal', command: 'restart', args: [] });
  });

  it('respects gitignore during standard clean and only removes ignored files in deep mode', () => {
    expect(cleanTreeFlags(false, false)).toBe('-ffd');
    expect(cleanTreeFlags(false, true)).toBe('-ffnd');
    expect(cleanTreeFlags(true, false)).toBe('-ffdx');
    expect(cleanTreeFlags(true, true)).toBe('-ffndx');
  });

  it('cleans the runtime floating repo while preserving Studio loop state', () => {
    expect(cleanableFloatingRepoPaths()).toEqual(['packages/harness']);
    expect(floatingRepoExclusionArgs()).toEqual([
      '-e', '.forgeax-harness',
      '-e', 'packages/harness',
    ]);

    const source = readFileSync(script('fx.ts'), 'utf8');
    const cleanBody = source.slice(source.indexOf('function clean('), source.indexOf('/** Remove local'));
    expect(cleanBody).toContain('scrubFloatingRepos(cleanFlags, dryRun, gitPrefix)');
    expect(cleanBody).toContain('...floatingRepoExclusionArgs()');
  });

  it('stops the Studio stack before destructive clean work', () => {
    const source = readFileSync(script('fx.ts'), 'utf8');
    const cleanBody = source.slice(source.indexOf('function clean('), source.indexOf('/** Remove local'));
    expect(cleanBody.indexOf('stopBeforeClean(dryRun)')).toBeGreaterThanOrEqual(0);
    expect(cleanBody.indexOf('stopBeforeClean(dryRun)')).toBeLessThan(cleanBody.indexOf('step(\'.\', [\'reset\''));
  });

  it('repairs stale index locks but blocks when Git is still active', () => {
    expect(cleanLockAction(false, false, false)).toBe('none');
    expect(cleanLockAction(true, false, false)).toBe('remove');
    expect(cleanLockAction(true, false, true)).toBe('plan-remove');
    expect(cleanLockAction(true, true, false)).toBe('block');
  });

  it('recognizes active git and git-lfs processes without counting itself', () => {
    const ps = [
      ' 101 /usr/bin/git reset --hard /workspace',
      ' 102 /usr/local/bin/git-lfs filter-process',
      ' 103 bun scripts/fx.ts clean',
    ].join('\n');
    expect(hasActiveGitProcess(ps, '103')).toBe(true);
    expect(hasActiveGitProcess(' 103 bun scripts/fx.ts clean', '103')).toBe(false);
  });

  it('keeps update separate from setup and build work', () => {
    const source = readFileSync(script('fx.ts'), 'utf8');
    const updateBody = source.slice(source.indexOf('function update('), source.indexOf('function restartStack('));

    expect(updateBody).not.toContain("script('setup.ts')");
    expect(updateBody).not.toContain('Running setup');
    expect(updateBody).not.toContain('--no-plugins');
    expect(updateBody).not.toContain('--skip-bootstrap');
  });

  it('refreshes the floating runtime harness only from update', () => {
    const source = readFileSync(script('fx.ts'), 'utf8');
    const updateBody = source.slice(source.indexOf('function update('), source.indexOf('function restartStack('));
    expect(source).toContain('function updateFloatingHarness');
    expect(updateBody).toContain('updateFloatingHarness(dryRun)');
    expect(readFileSync(script('prepare.ts'), 'utf8')).toContain('syncPackageHarness();');
  });

  it('updates submodules explicitly after updating the root repo', () => {
    expect(parseSubmodulePaths([
      'submodule.packages/engine.path packages/engine',
      'submodule.packages/interface.path packages/interface',
      '',
    ].join('\n'))).toEqual(['packages/engine', 'packages/interface']);
    expect(submoduleUpdateArgs('packages/engine')).toEqual(['submodule', 'update', '--init', '--recursive', '--', 'packages/engine']);
  });

  it('formats update results as a repo result table', () => {
    expect(stripAnsi(formatUpdateReport([
      { repoType: 'root', repo: '.', result: 'ok', detail: 'pulled latest root code' },
      { repoType: 'submodule', repo: 'packages/engine', result: 'failed', detail: 'git submodule update exited 1' },
      { repoType: 'root', repo: '.', result: 'failed', detail: 'stash restore exited 1' },
    ]))).toBe([
      'RESULT  REPO             REPO TYPE  DETAIL',
      '------  ---------------  ---------  -----------------------------',
      'OK      .                root       pulled latest root code',
      'FAILED  packages/engine  submodule  git submodule update exited 1',
      'FAILED  .                root       stash restore exited 1',
    ].join('\n'));
  });

  it('uses stash by default for update dirty worktrees', () => {
    expect(updateShouldStash([])).toBe(true);
    expect(updateShouldStash(['--stash'])).toBe(true);
    expect(updateShouldStash(['--dry-run'])).toBe(true);
    expect(updateShouldStash(['--no-stash'])).toBe(false);
  });

  it('restores only a stash that was actually created by update', () => {
    expect(didCreateStash('', 'abc123')).toBe(true);
    expect(didCreateStash('old123', 'new456')).toBe(true);
    expect(didCreateStash('same123', 'same123')).toBe(false);
    expect(didCreateStash('same123', '')).toBe(false);

    expect(stashPopArgsForRef('stash@{0}')).toEqual([
      'stash',
      'pop',
      'stash@{0}',
    ]);
  });
});
