/**
 * 暴力破坏性 —— 恢复 / 生命周期(跨真进程)。
 *
 * 起真 agent-host 子进程,用各种"死法"折腾:优雅 SIGTERM、单例接管、硬杀 SIGKILL,
 * 验证进程组收割 + 孤儿登记/启动 sweep + 陈旧 socket 重领。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { connect, type RpcConnection } from '../src/ipc';
import type { SessionGrant } from '../src/types';

let dir: string;
let sock: string;
let seq = 0;
const procs: Subprocess[] = [];
const conns: RpcConnection[] = [];

function spawnHost(): Subprocess {
  const p = Bun.spawn({
    cmd: ['bun', 'src/main.ts'],
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, FORGEAX_AGENT_HOST_SOCK: sock } as Record<string, string>,
    stdout: 'ignore', stderr: 'ignore',
  });
  procs.push(p);
  return p;
}
async function waitConnect(timeoutMs = 8000): Promise<RpcConnection> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { const c = await connect(sock, 1000); await c.request('ping'); conns.push(c); return c; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error(`agent-host not reachable: ${(lastErr as Error)?.message}`);
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(pred: () => boolean, ms = 6000, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, step)); }
  return pred();
}
async function startFugitiveSession(c: RpcConnection, sid: string): Promise<{ grant: SessionGrant; fug: number }> {
  const fugFile = join(dir, `${sid}.fug`);
  const grant = (await c.request('startSession', {
    sessionId: sid, agentId: 'a', trustTier: 'own',
    kernel: { kind: 'codex', credential: 'user-managed', cmd: 'bash',
      args: ['-c', `sleep 999 & echo $! > ${fugFile}; sleep 999`], cwd: dir },
  })) as SessionGrant;
  await until(() => existsSync(fugFile));
  const fug = Number(readFileSync(fugFile, 'utf8').trim());
  return { grant, fug };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ah-rec-'));
  sock = `/tmp/fxah-rec-${process.pid}-${seq++}.sock`;
});
afterEach(async () => {
  for (const c of conns.splice(0)) { try { c.close(); } catch { /* ignore */ } }
  for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 150));
  // 兜底:扫掉本轮可能漏网的 fugitive(sleep 999),防污染其它测试。
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(sock, { force: true }); } catch { /* ignore */ }
  try { rmSync(`${sock}.pid`, { force: true }); } catch { /* ignore */ }
  try { rmSync(`${sock}.orphans`, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('agent-host — recovery / lifecycle (destructive)', () => {
  test('优雅 SIGTERM → 整组收割(无残留孤儿)', async () => {
    spawnHost();
    const c = await waitConnect();
    const { grant, fug } = await startFugitiveSession(c, 'g1');
    expect(pidAlive(grant.pid)).toBe(true);
    expect(pidAlive(fug)).toBe(true);
    procs[0].kill('SIGTERM');                 // 触发 main 的 shutdown → srv.close → reap
    expect(await until(() => !pidAlive(grant.pid))).toBe(true);
    expect(await until(() => !pidAlive(fug))).toBe(true);
  }, 25000);

  test('单例接管(带活会话):旧实例退出并收割其会话,新实例可服务', async () => {
    const p1 = spawnHost();
    const c1 = await waitConnect();
    const { grant, fug } = await startFugitiveSession(c1, 'g2');
    expect(pidAlive(fug)).toBe(true);

    spawnHost();                              // p2 复用同 sock → 令 p1 shutdown 接管
    const c2 = await waitConnect();
    expect((await c2.request('ping') as { pid: number }).pid).toBeGreaterThan(0);
    await p1.exited;                          // 旧实例退出
    // 旧实例优雅退出时 reap 了它的会话组。
    expect(await until(() => !pidAlive(grant.pid))).toBe(true);
    expect(await until(() => !pidAlive(fug))).toBe(true);
  }, 25000);

  test('硬杀 SIGKILL → 孤儿存活 → 新实例启动 sweep 收割(登记恢复)', async () => {
    spawnHost();
    const c = await waitConnect();
    const { grant, fug } = await startFugitiveSession(c, 'g3');
    expect(pidAlive(grant.pid)).toBe(true);

    procs[0].kill('SIGKILL');                 // 无优雅关停 → detached 内核组成孤儿
    await procs[0].exited;
    // 确认确实成孤儿(硬杀不会自动收割 detached 子组)——这正是登记/sweep 要救的场景。
    expect(pidAlive(grant.pid)).toBe(true);

    spawnHost();                              // 新实例 boot:reclaim 陈旧 sock + sweepOrphans
    await waitConnect();
    expect(await until(() => !pidAlive(grant.pid))).toBe(true); // 孤儿组被启动 sweep 收割
    expect(await until(() => !pidAlive(fug))).toBe(true);
  }, 25000);

  test('陈旧 socket(硬杀残留)→ 新实例重领并正常服务', async () => {
    const p1 = spawnHost();
    await waitConnect();
    p1.kill('SIGKILL');                       // 留下陈旧 sock 文件(未 unlink)
    await p1.exited;
    expect(existsSync(sock)).toBe(true);      // 陈旧 socket 仍在
    spawnHost();                              // reclaimSocket:连不上 → unlink → listen 新的
    const c2 = await waitConnect();
    expect((await c2.request('ping') as { sessions: number }).sessions).toBe(0);
  }, 25000);
});
