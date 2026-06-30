/** 跨进程集成:起真 agent-host 进程,经 socket 验进程监督(R3-06/07/08/09/11/13/16)。 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { connect, type RpcConnection } from '../src/ipc';
import type { ExitInfo, PingResult, SessionGrant } from '../src/types';

let dir: string;
let sock: string;
let seq = 0;
const procs: Subprocess[] = [];

function spawnHost(): Subprocess {
  const p = Bun.spawn({
    cmd: ['bun', 'src/main.ts'],
    cwd: import.meta.dir + '/..',
    env: { ...process.env, FORGEAX_AGENT_HOST_SOCK: sock } as Record<string, string>,
    stdout: 'inherit', stderr: 'inherit',
  });
  procs.push(p);
  return p;
}

async function waitConnect(timeoutMs = 8000): Promise<RpcConnection> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try { const c = await connect(sock, 1000); await c.request('ping'); return c; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`agent-host not reachable on ${sock}: ${(lastErr as Error)?.message}`);
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ah-int-'));
  // unix socket sun_path 限 104 字节 → 必须用短路径(/var/folders mkdtemp 太长)。fug 文件仍放 dir。
  sock = `/tmp/fxah-${process.pid}-${seq++}.sock`;
});
afterEach(async () => {
  for (const p of procs.splice(0)) { try { p.kill(); } catch {} }
  await new Promise((r) => setTimeout(r, 100));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  try { rmSync(sock, { force: true }); } catch {}
  try { rmSync(`${sock}.pid`, { force: true }); } catch {}
});

describe('agent-host integration', () => {
  test('ping + startSession(进程组) + getProcess + shutdown 整组 reap 逃兵(R3-06/07/11)', async () => {
    spawnHost();
    const c = await waitConnect();
    const pong = (await c.request('ping')) as PingResult;
    expect(pong.pid).toBeGreaterThan(0);
    expect(pong.sessions).toBe(0);

    const fug = join(dir, 'fug.pid');
    const exits: ExitInfo[] = [];
    c.onNotify((m, params) => { if (m === 'exit') exits.push(params as ExitInfo); });

    const grant = (await c.request('startSession', {
      sessionId: 's1', agentId: 'a', trustTier: 'imported',
      kernel: { kind: 'codex', credential: 'user-managed', cmd: 'bash',
        args: ['-c', `sleep 999 & echo $! > ${fug}; sleep 30`] },
    })) as SessionGrant;
    expect(grant.pid).toBeGreaterThan(0);
    expect(grant.pgid).toBe(grant.pid);

    // 等逃兵落 pid 文件
    for (let i = 0; i < 40 && !existsSync(fug); i++) await new Promise((r) => setTimeout(r, 50));
    const fugitivePid = Number(readFileSync(fug, 'utf8').trim());
    expect(pidAlive(fugitivePid)).toBe(true);

    const handle = (await c.request('getProcess', { sessionId: 's1' })) as { pid: number; pgid: number } | null;
    expect(handle?.pid).toBe(grant.pid);

    await c.request('shutdownSession', { sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 500));
    expect(pidAlive(fugitivePid)).toBe(false);          // 逃兵随整组被 reap
    expect(exits.some((e) => e.sessionId === 's1')).toBe(true); // 收到 onExit
  }, 20000);

  test('stdout 经 data 通知转发 + exit{done}(S1b 数据路径)', async () => {
    spawnHost();
    const c = await waitConnect();
    const chunks: string[] = [];
    const exits: ExitInfo[] = [];
    c.onNotify((m, params) => {
      if (m === 'data' && (params as { stream: string }).stream === 'stdout') chunks.push((params as { chunk: string }).chunk);
      if (m === 'exit') exits.push(params as ExitInfo);
    });
    await c.request('startSession', {
      sessionId: 'sd', agentId: 'a', trustTier: 'own',
      kernel: { kind: 'bc', credential: 'user-managed', cmd: 'bash',
        args: ['-c', 'echo \'{"a":1}\'; echo \'{"b":2}\''] },
    });
    // 等进程吐完 + 退出
    for (let i = 0; i < 40 && !exits.some((e) => e.sessionId === 'sd'); i++) await new Promise((r) => setTimeout(r, 50));
    const lines = chunks.join('').split('\n').filter((l) => l.trim());
    expect(lines).toContain('{"a":1}');
    expect(lines).toContain('{"b":2}');
    expect(exits.find((e) => e.sessionId === 'sd')?.reason).toBe('done');
  }, 20000);

  test('cancel(callId) → 组杀 + ExitInfo{cancelled}(R3-08)', async () => {
    spawnHost();
    const c = await waitConnect();
    const exits: ExitInfo[] = [];
    c.onNotify((m, params) => { if (m === 'exit') exits.push(params as ExitInfo); });
    await c.request('startSession', {
      sessionId: 's2', agentId: 'a', trustTier: 'own', callId: 'call-xyz',
      kernel: { kind: 'codex', credential: 'user-managed', cmd: 'bash', args: ['-c', 'sleep 30'] },
    });
    await c.request('cancel', { callId: 'call-xyz' });
    await new Promise((r) => setTimeout(r, 400));
    expect(exits.find((e) => e.sessionId === 's2')?.reason).toBe('cancelled');
  }, 20000);

  test('崩溃 → ExitInfo{crash}(R3-09)', async () => {
    spawnHost();
    const c = await waitConnect();
    const exits: ExitInfo[] = [];
    c.onNotify((m, params) => { if (m === 'exit') exits.push(params as ExitInfo); });
    await c.request('startSession', {
      sessionId: 's3', agentId: 'a', trustTier: 'own',
      kernel: { kind: 'codex', credential: 'user-managed', cmd: 'bash', args: ['-c', 'exit 3'] },
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(exits.find((e) => e.sessionId === 's3')?.reason).toBe('crash');
  }, 20000);

  test('单例:二次启动接管,旧实例退出,不报 EADDRINUSE(R3-13)', async () => {
    const p1 = spawnHost();
    await waitConnect();
    const p2 = spawnHost();          // 复用同 sock → 应令 p1 shutdown 并接管
    const c2 = await waitConnect();  // 仍能 ping(接管成功)
    expect(((await c2.request('ping')) as PingResult).pid).toBeGreaterThan(0);
    await p1.exited;                 // 旧实例已退出
    expect(p1.exitCode).not.toBeNull();
    void p2;
  }, 20000);
});
