import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectIdeInstallInputs, readInstallProcessState, runIdeWorkspaceInstall } from './ide-install-diagnostics.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ide-install-diagnostics-'));
  roots.push(root);
  const cwd = join(root, '.forgeax/ide-source-workspace');
  mkdirSync(cwd, { recursive: true });
  const ide = join(root, 'packages/ide');
  mkdirSync(join(ide, 'packages/child'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({
    workspaces: ['../../packages/ide', '../../packages/ide/packages/*'],
    overrides: { 'happy-dom': '20.11.0' },
  }));
  writeFileSync(join(ide, 'package.json'), JSON.stringify({ name: '@fixture/ide', dependencies: {
    react: '^19.0.0', child: 'workspace:*', private: 'https://user:SECRET@registry.test/pkg?token=SECRET',
  }, scripts: { install: 'echo SECRET' } }));
  writeFileSync(join(ide, 'packages/child/package.json'), '{"name":"@fixture/child"}');
  spawnSync('git', ['init', '-q', ide]);
  spawnSync('git', ['-C', ide, 'add', '.']);
  spawnSync('git', ['-C', ide, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  return { root, cwd };
}

test('snapshots the actual IDE revision, expanded members, dependency edges and lock fingerprints without secrets', () => {
  const { root, cwd } = fixture();
  writeFileSync(join(root, 'bun.lock'), 'root-lock');
  writeFileSync(join(cwd, '.npmrc'), '//registry.test/:_authToken=SECRET');
  const env = { INTERNAL_TOKEN: 'SECRET', npm_config_registry: 'https://user:SECRET@registry.test/private?token=SECRET', BUN_INSTALL_CACHE_DIR: '/private/SECRET' };
  const before = collectIdeInstallInputs(root, cwd, env);
  expect(before.ideHead).toMatch(/^[a-f0-9]{40}$/);
  expect(before.members).toHaveLength(2);
  expect(before.members[0]?.dependencies).toMatchObject({ dependencies: { react: '^19.0.0', child: 'workspace:*', private: '[redacted]' } });
  expect(before.installManifest.dependencies.overrides).toEqual({ 'happy-dom': '20.11.0' });
  expect(before.locks.installText.state).toBe('missing');
  expect(before.locks.rootText.state).toBe('present');
  expect(JSON.stringify(before)).not.toContain('SECRET');
  expect(JSON.stringify(before)).not.toContain('registry.test');
  expect(JSON.stringify(before)).not.toContain('scripts');
  writeFileSync(join(cwd, 'bun.lock'), 'generated-lock');
  const after = collectIdeInstallInputs(root, cwd, env);
  expect(after.locks.installText.state).toBe('present');
  expect(after.locks.installText.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(after.locks.installText.sha256).not.toBe(before.locks.rootText.sha256);
});

test('reports invalid input without leaking parse errors and rejects patterns outside the checkout', () => {
  const { root, cwd } = fixture();
  writeFileSync(join(cwd, 'package.json'), '{SECRET');
  expect(collectIdeInstallInputs(root, cwd, {}).installManifest.state).toBe('invalid');
  expect(JSON.stringify(collectIdeInstallInputs(root, cwd, {}))).not.toContain('SECRET');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ workspaces: ['../../../../SECRET', '**/SECRET'] }));
  const bounded = collectIdeInstallInputs(root, cwd, {});
  expect(bounded.members).toHaveLength(0);
  expect(bounded.omittedPatterns).toBe(2);
});

test('allowlists process metrics instead of command lines, environment, addresses or arbitrary proc text', () => {
  const { root } = fixture();
  const proc = join(root, '123'); mkdirSync(proc);
  writeFileSync(join(proc, 'stat'), '123 (SECRET with spaces) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21');
  writeFileSync(join(proc, 'status'), 'Name:\tSECRET\nState:\tS (sleeping)\nVmRSS:\t42 kB\nThreads:\t3\n');
  writeFileSync(join(proc, 'io'), 'rchar: 12\nwchar: 34\nread_bytes: 56\nwrite_bytes: 78\nSECRET: 99\n');
  writeFileSync(join(proc, 'wchan'), 'futex_wait_queue');
  expect(readInstallProcessState(123, root)).toMatchObject({ state: 'S', userTicks: 11, systemTicks: 12, rssKiB: 42, threads: 3, readBytes: 56, writeBytes: 78, waitChannel: 'futex_wait_queue' });
  expect(JSON.stringify(readInstallProcessState(123, root))).not.toContain('SECRET');
  expect(readInstallProcessState(999, root).state).toBe('unavailable');
});

test('observes a real waiting subprocess and preserves arguments, environment, exit code and cleanup', async () => {
  const { root, cwd } = fixture();
  const messages: string[] = [];
  const beforeSignals = process.listenerCount('SIGTERM');
  const result = await runIdeWorkspaceInstall({ root, cwd, executable: process.execPath,
    args: ['-e', 'if(process.env.FIXTURE !== "ok") process.exit(9); setTimeout(()=>process.exit(7), 100)'],
    env: { ...process.env, FIXTURE: 'ok', FORGEAX_IDE_INSTALL_DIAGNOSTICS: '1' },
  }, { intervalMs: 10, emit: (line) => messages.push(line) });
  expect(result.status).toBe(7);
  const events = messages.map((line) => JSON.parse(line.slice('[ide-install] '.length)));
  expect(events.some((event) => event.event === 'inputs')).toBe(true);
  expect(events.some((event) => event.event === 'waiting' && event.elapsedMs >= 0)).toBe(true);
  expect(events.at(-1)).toMatchObject({ event: 'exit', status: 7 });
  const count = messages.length;
  await Bun.sleep(35);
  expect(messages).toHaveLength(count);
  expect(process.listenerCount('SIGTERM')).toBe(beforeSignals);
});

test('logging errors never replace the installer result, and launch failure fails closed', async () => {
  const { root, cwd } = fixture();
  const env = { ...process.env, FORGEAX_IDE_INSTALL_DIAGNOSTICS: '1' };
  expect((await runIdeWorkspaceInstall({ root, cwd, env, executable: process.execPath, args: ['-e', 'process.exit(3)'] }, { emit() { throw new Error('SECRET'); } })).status).toBe(3);
  const messages: string[] = [];
  expect((await runIdeWorkspaceInstall({ root, cwd, env, executable: join(root, 'absent-SECRET'), args: [] }, { emit: (line) => messages.push(line) })).status).toBeNull();
  expect(messages.join('\n')).not.toContain('SECRET');
});

test('disabled diagnostics retain the synchronous installer and emit nothing', async () => {
  const { root, cwd } = fixture();
  let emitted = false;
  expect((await runIdeWorkspaceInstall({ root, cwd, env: {}, executable: process.execPath, args: ['-e', 'process.exit(6)'] }, { emit() { emitted = true; } })).status).toBe(6);
  expect(emitted).toBe(false);
});

test('bounds oversized lock inputs and reports truncation of member lists', () => {
  const { root, cwd } = fixture();
  const lock = join(cwd, 'bun.lock');
  writeFileSync(lock, ''); truncateSync(lock, 16 * 1024 * 1024 + 1);
  for (let i = 0; i < 515; i++) mkdirSync(join(root, `packages/ide/packages/member-${i}`));
  const inputs = collectIdeInstallInputs(root, cwd, {});
  expect(inputs.locks.installText.state).toBe('oversize');
  expect(inputs.members).toHaveLength(512);
  expect(inputs.truncatedMembers).toBe(true);
  expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toContain('workspaces');
});

test.skipIf(process.platform === 'win32')('forwards wrapper cancellation to its own child and preserves signal termination', async () => {
  const { root, cwd } = fixture();
  const pidFile = join(root, 'child.pid');
  const helper = join(import.meta.dir, 'ide-install-diagnostics.ts');
  const installer = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000);`;
  const script = `import { runIdeWorkspaceInstall } from ${JSON.stringify(helper)};
    await runIdeWorkspaceInstall(${JSON.stringify({ root, cwd, executable: process.execPath, args: ['-e', installer] })}, { emit() {} });`;
  // Supply env in the wrapper, not in fixture source, so no host secrets are serialized.
  const wrapper = Bun.spawn([process.execPath, '-e', script.replace('}, { emit()', ', env: process.env }, { emit()')], {
    env: { ...process.env, FORGEAX_IDE_INSTALL_DIAGNOSTICS: '1' }, stdout: 'ignore', stderr: 'pipe',
  });
  let childPid: number | undefined;
  try {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    childPid = Number(readFileSync(pidFile, 'utf8'));
    wrapper.kill('SIGTERM');
    await wrapper.exited;
    expect(wrapper.signalCode).toBe('SIGTERM');
    expect(() => process.kill(childPid!, 0)).toThrow();
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    // Only fixture-created processes are eligible for this cleanup.
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
  }
});

test('both IDE install entrypoints use the observer, and CI enables it without changing gates', () => {
  const root = join(import.meta.dir, '../..');
  for (const path of ['scripts/prepare.ts', 'scripts/ci/install-ide-integration-workspace.ts']) {
    expect(readFileSync(join(root, path), 'utf8')).toContain('await runIdeWorkspaceInstall(');
  }
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const lifecycle = ci.split('  studio-integration-lifecycle:')[1]!.split('  studio-integration-aggregate:')[0]!;
  expect(lifecycle).toContain("FORGEAX_IDE_INSTALL_DIAGNOSTICS: '1'");
  expect(lifecycle).toContain('timeout-minutes: 45');
  expect(lifecycle).toContain('bun install --frozen-lockfile');
  expect(lifecycle).not.toContain('continue-on-error');
  expect(ci).toContain('bun test scripts/lib/ide-install-diagnostics.spec.ts');
});
