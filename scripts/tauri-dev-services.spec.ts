import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTauriDevUrl, withTauriServiceLifetime } from './tauri-dev-services.ts';

test('Tauri URL must agree with the runtime instance before starting services', () => {
  expect(() => assertTauriDevUrl('http://127.0.0.1:19920/', 'http://127.0.0.1:19920')).not.toThrow();
  expect(() => assertTauriDevUrl('http://127.0.0.1:18920', 'http://127.0.0.1:19920')).toThrow('RuntimeInstance');
});

for (const event of ['end', 'SIGINT', 'SIGTERM']) {
  test(`hook cleans up once on ${event}, including shutdown during startup`, async () => {
    const input = new PassThrough();
    const signals = new EventEmitter();
    let resolveStart!: (value: { alive: () => boolean; stop: () => Promise<void> }) => void;
    let stopped = 0;
    const done = withTauriServiceLifetime(() => new Promise(resolve => { resolveStart = resolve; }), input, signals);
    if (event === 'end') { input.end(); await Bun.sleep(0); }
    else { signals.emit(event); signals.emit(event); }
    resolveStart({ alive: () => true, stop: async () => { stopped++; } });
    await done;
    expect(stopped).toBe(1);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
}

test('hook propagates a service failure after cleanup', async () => {
  let stopped = false;
  await expect(withTauriServiceLifetime(async () => ({
    alive: () => false, stop: async () => { stopped = true; },
  }), new PassThrough(), new EventEmitter())).rejects.toThrow('services exited');
  expect(stopped).toBe(true);
});

test('closed Tauri stdin terminates a real detached child and the hook', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tauri-hook-'));
  const fixture = join(dir, 'hook.ts');
  writeFileSync(fixture, `
    import { spawn } from 'node:child_process';
    import { withTauriServiceLifetime } from ${JSON.stringify(new URL('./tauri-dev-services.ts', import.meta.url).pathname)};
    await withTauriServiceLifetime(async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      const exited = new Promise(resolve => child.once('exit', resolve));
      console.log(child.pid);
      return { alive: () => child.exitCode === null, stop: async () => { child.kill('SIGTERM'); await exited; } };
    });
  `);
  const hook = spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>(resolve => hook.once('exit', resolve));
  let childPid = 0;
  try {
    childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hook startup timed out')), 10000);
      hook.stdout.once('data', data => { clearTimeout(timer); resolve(Number(String(data).trim())); });
      hook.once('error', reject);
    });
    expect(childPid).toBeGreaterThan(0);
    hook.stdin.end();
    expect(await Promise.race([exited, Bun.sleep(5000).then(() => 'timeout')])).toBe(0);
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    hook.kill();
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
