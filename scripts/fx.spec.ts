// @ts-nocheck
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  cleanableFloatingRepoPaths,
  cleanTreeFlags,
  cleanLockAction,
  didCreateStash,
  formatUpdateReport,
  floatingRepoExclusionArgs,
  hasActiveGitProcess,
  localCiEnvironment,
  lifecycleProcessEnv,
  parseSubmodulePaths,
  resolveCommand,
  startBusyPorts,
  stashPopArgsForRef,
  submoduleUpdateArgs,
  updateShouldStash,
} from './fx.ts';
import {
  resolveRuntimeInstance,
  runtimeInstanceProcessEnv,
  writeRuntimeInstanceConfig,
} from './lib/runtime-instance.ts';

const ROOT = resolve(import.meta.dir, '..');
const script = (name: string) => resolve(ROOT, 'scripts', name);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const fixtureRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-fx-runtime-'));
  fixtureRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  it('separates service startup from explicit web-client opening', () => {
    expect(resolveCommand(['start'])).toEqual({ type: 'internal', command: 'start', args: [] });
    expect(resolveCommand(['start', 'web', '--fresh'])).toEqual({ type: 'internal', command: 'start', args: ['web', '--fresh'] });
    expect(resolveCommand(['start', 'desktop', 'debug'])).toEqual({ type: 'internal', command: 'start', args: ['desktop', 'debug'] });
    expect(resolveCommand(['open'])).toEqual({ type: 'script', script: script('open-web.ts'), args: [] });
    expect(resolveCommand(['open', '--managed'])).toEqual({ type: 'script', script: script('open-web.ts'), args: ['--managed'] });

    const source = readFileSync(script('fx.ts'), 'utf8');
    const startWebBody = source.slice(source.indexOf('async function startWeb('), source.indexOf('function sourceProfileFromEnvironment'));
    expect(startWebBody).not.toContain("runScript(script('open-web.ts')");
    expect(startWebBody).toContain('--no-open was removed because start never opens a browser');
  });

  it('checks every fixed stack port before start launches a new stack', () => {
    const { ports } = resolveRuntimeInstance({ root: ROOT });
    const owner = (port: number) => (
      port === ports.server || port === ports.engine ? `pid-${port}` : ''
    );

    expect(startBusyPorts(owner)).toEqual([
      ['server', ports.server, `pid-${ports.server}`],
      ['engine', ports.engine, `pid-${ports.engine}`],
    ]);
  });

  it('isolates editor CI web servers from the current Studio runtime', () => {
    const instance = resolveRuntimeInstance({ root: ROOT });
    const projected = localCiEnvironment({ FORGEAX_E2E_PORT: '41020', EXTRA_CI_FLAG: 'kept' });

    expect(projected.CI).toBe('1');
    expect(projected.EXTRA_CI_FLAG).toBe('kept');
    expect(projected.FORGEAX_E2E_PORT).toBe('41020');
    expect(projected.FORGEAX_E2E_EDIT_PORT).toBe(String(instance.ports.interface + 101));
    expect(projected.FORGEAX_E2E_API_PORT).toBe(String(instance.ports.server + 100));
    expect(projected.FORGEAX_E2E_ENGINE_PORT).toBe(String(instance.ports.engine + 100));
    expect(projected.FORGEAX_E2E_TEMPLATE_PORT).toBe(String(instance.ports.interface + 102));
    expect(projected.FORGEAX_E2E_TEMPLATE_EDIT_PORT).toBe(String(instance.ports.interface + 103));
    expect(projected.FORGEAX_E2E_TEMPLATE_API_PORT).toBe(String(instance.ports.server + 102));
    expect(projected.FORGEAX_E2E_TEMPLATE_ENGINE_PORT).toBe(String(instance.ports.engine + 102));
    expect(projected.FORGEAX_E2E_BRIDGE_PORT).toBe(String(instance.ports.interface + 106));
    expect(projected.FORGEAX_E2E_TEMPLATE_BRIDGE_PORT).toBe(String(instance.ports.interface + 108));
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

  it('routes worktree runtime instance commands to their dedicated CLI', () => {
    expect(resolveCommand(['instance', 'init', '--slot', '1'])).toEqual({
      type: 'script',
      script: script('instance.ts'),
      args: ['init', '--slot', '1'],
    });
    expect(resolveCommand(['instance', 'show'])).toEqual({
      type: 'script',
      script: script('instance.ts'),
      args: ['show'],
    });
  });

  it('routes complete Studio worktree creation through the dedicated bootstrap CLI', () => {
    expect(resolveCommand(['worktree', 'feature-name'])).toEqual({
      type: 'script',
      script: script('worktree.ts'),
      args: ['feature-name'],
    });
    expect(resolveCommand(['wt', 'feature-name', '--fast'])).toEqual({
      type: 'script',
      script: script('worktree.ts'),
      args: ['feature-name', '--fast'],
    });
  });

  it('derives lifecycle environment from RuntimeInstance instead of hardcoding optional ports', () => {
    const source = readFileSync(script('fx.ts'), 'utf8');
    const statusBody = source.slice(source.indexOf('function status()'), source.indexOf('function doctor('));
    const usageBody = source.slice(source.indexOf('function usage()'), source.indexOf('function runSetup('));

    expect(source).toContain('runtimeInstanceProcessEnv(instance)');
    expect(statusBody).toContain('sourceRuntimeStatusPorts(startup)');
    expect(statusBody).not.toContain("['narrative', 8900]");
    expect(statusBody).not.toContain("['face-mask', 18930]");
    expect(usageBody).toContain('instance init --slot N');
    expect(usageBody).not.toContain('start [web|app|local]');
  });

  it('leaves source start projection to source-runtime-launcher while retaining lifecycle projections elsewhere', () => {
    const source = readFileSync(script('fx.ts'), 'utf8');
    const startWebBody = source.slice(source.indexOf('async function startWeb('), source.indexOf('function sourceProfileFromEnvironment'));

    expect(startWebBody).toContain('env: process.env');
    expect(startWebBody).not.toContain('env: lifecycleProcessEnv()');
    expect(source).toContain("runScript(script('desktop.ts'), rest, lifecycleProcessEnv())");
  });

  it('retains only an explicit parent agent-host socket when projecting lifecycle environment', () => {
    const root = fixtureRoot();
    writeRuntimeInstanceConfig({ root, slot: 1 });
    const instance = resolveRuntimeInstance({ root });
    const instanceEnv = runtimeInstanceProcessEnv(instance);
    const projected = lifecycleProcessEnv({
      FORGEAX_AGENT_HOST_SOCK: '/external-agent-host.sock',
      FORGEAX_SERVER_PORT: '1',
      FORGEAX_PROJECT_ROOT: '/wrong-project',
      FORGEAX_RUNTIME_STATE_FILE: '/wrong-state.json',
      FORGEAX_RUNTIME_LOG_FILE: '/wrong.log',
      FORGEAX_PLUGIN_PORT_OFFSET: '999',
      FORGEAX_ASSET_CORS_ORIGINS: 'http://wrong.example',
    }, instance);

    expect(projected.FORGEAX_AGENT_HOST_SOCK).toBe('/external-agent-host.sock');
    expect(projected.FORGEAX_SERVER_PORT).toBe(instanceEnv.FORGEAX_SERVER_PORT);
    expect(projected.FORGEAX_PROJECT_ROOT).toBe(instanceEnv.FORGEAX_PROJECT_ROOT);
    expect(projected.FORGEAX_RUNTIME_STATE_FILE).toBe(instanceEnv.FORGEAX_RUNTIME_STATE_FILE);
    expect(projected.FORGEAX_RUNTIME_LOG_FILE).toBe(instanceEnv.FORGEAX_RUNTIME_LOG_FILE);
    expect(projected.FORGEAX_PLUGIN_PORT_OFFSET).toBe(instanceEnv.FORGEAX_PLUGIN_PORT_OFFSET);
    expect(projected.FORGEAX_ASSET_CORS_ORIGINS).toBe(instanceEnv.FORGEAX_ASSET_CORS_ORIGINS);
  });

  it('uses the instance agent-host socket without an explicit parent override', () => {
    const root = fixtureRoot();
    writeRuntimeInstanceConfig({ root, slot: 1 });
    const instance = resolveRuntimeInstance({ root });

    expect(lifecycleProcessEnv({}, instance).FORGEAX_AGENT_HOST_SOCK)
      .toBe(runtimeInstanceProcessEnv(instance).FORGEAX_AGENT_HOST_SOCK);
  });

  it('routes multi-repo lifecycle commands to repos.ts with the subcommand prepended', () => {
    expect(resolveCommand(['sync', '--dry-run'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['sync', '--dry-run'] });
    expect(resolveCommand(['check', '--all'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['check', '--all'] });
    expect(resolveCommand(['commit', '-m', 'msg', '--push'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['commit', '-m', 'msg', '--push'] });
    expect(resolveCommand(['bump', 'packages/interface'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['bump', 'packages/interface'] });
    expect(resolveCommand(['versions'])).toEqual({ type: 'script', script: script('repos.ts'), args: ['versions'] });
  });

  it('routes recursive input discovery through one internal top-level entry', () => {
    expect(resolveCommand(['recursive-inputs'])).toEqual({ type: 'internal', command: 'recursive-inputs', args: [] });
    expect(resolveCommand(['recursive-inputs', 'status'])).toEqual({
      type: 'internal',
      command: 'recursive-inputs',
      args: ['status'],
    });
    expect(resolveCommand(['recursive-inputs', '--help'])).toEqual({
      type: 'internal',
      command: 'recursive-inputs',
      args: ['--help'],
    });
  });

  it('keeps commit preflight ahead of source-owned repository gates', () => {
    const source = readFileSync(script('repos.ts'), 'utf8');
    const commitBody = source.slice(source.indexOf('function commitCmd('), source.indexOf('// ── bump'));

    expect(commitBody).toContain('verifyRecursiveInputForCommit');
    expect(commitBody.indexOf('verifyRecursiveInputForCommit')).toBeLessThan(commitBody.indexOf('checkCmd('));
    expect(commitBody).not.toContain('--no-verify: gates SKIPPED');
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
    expect(resolveCommand(['ci'])).toEqual({ type: 'internal', command: 'ci', args: [] });
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
      '-e', 'packages/games',
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

  it('updates independent floating repos concurrently', () => {
    const source = readFileSync(script('fx.ts'), 'utf8');
    const floatingBlock = source.slice(
      source.indexOf('// These checkouts are independent.'),
      source.indexOf("console.log('[update] Updating submodules')"),
    );
    expect(floatingBlock).toContain('Promise.all');
    expect(floatingBlock).toContain('updateFloatingHarness(dryRun)');
    expect(floatingBlock).toContain('updateFloatingGames(dryRun)');
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
