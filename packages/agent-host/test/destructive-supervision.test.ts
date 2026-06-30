/**
 * 暴力破坏性 —— 进程监督(Host)。
 *
 * 目标:不留僵尸、不漏 session、外部杀/拒信号/spawn 失败/海量并发都收敛干净。
 * 直接驱动 Host(进程监督本体),用 bash 当假内核。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Host } from '../src/host';
import { closeCredVault } from '../src/cred-vault';
import type { ExitInfo, StartSessionReq } from '../src/types';

let host: Host;
let dir: string;
const exits: ExitInfo[] = [];

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(pred: () => boolean, ms = 5000, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, step)); }
  return pred();
}
function req(p: Partial<StartSessionReq> & { sessionId: string; cmd: string; args: string[] }): StartSessionReq {
  return {
    sessionId: p.sessionId,
    agentId: p.agentId ?? 'a',
    trustTier: p.trustTier ?? 'own',
    ...(p.callId ? { callId: p.callId } : {}),
    kernel: { kind: 'codex', credential: 'user-managed', cmd: p.cmd, args: p.args, cwd: dir },
  };
}

beforeEach(() => {
  host = new Host();
  exits.length = 0;
  host.onExit((e) => exits.push(e));
  dir = mkdtempSync(join(tmpdir(), 'ah-sup-'));
});
afterEach(async () => {
  await host.shutdownAll().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  await closeCredVault().catch(() => {});
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Host — supervision chaos', () => {
  test('海量并发 spawn(30) → 全部 reap,无残留,均收 onExit', async () => {
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) => host.startSession(req({ sessionId: `m${i}`, cmd: 'bash', args: ['-c', 'sleep 60'] }))),
    );
    expect(host.listSessions()).toHaveLength(N);
    const pids = host.listSessions().map((s) => s.pid);
    await host.shutdownAll();
    expect(await until(() => host.listSessions().length === 0)).toBe(true);
    expect(await until(() => pids.every((p) => !pidAlive(p)))).toBe(true);
    expect(new Set(exits.map((e) => e.sessionId)).size).toBe(N);
  }, 30000);

  test('外部 SIGKILL 内核 leader → onExit{crash} + 整组兜底收割孤儿子进程', async () => {
    const child = join(dir, 'child.pid');
    // leader 派生一个后台子进程(同组),写下 pid,然后自己 sleep。SIGKILL 只杀 leader →
    // 子进程成孤儿;Host onExit 的整组兜底应把它一并收割(否则泄漏)。
    const g = await host.startSession(
      req({ sessionId: 'k1', cmd: 'bash', args: ['-c', `sleep 999 & echo $! > ${child}; sleep 60`] }),
    );
    expect(await until(() => existsSync(child))).toBe(true);
    const cpid = Number(readFileSync(child, 'utf8').trim());
    expect(pidAlive(cpid)).toBe(true);
    process.kill(g.pid, 'SIGKILL'); // 只杀 leader
    expect(await until(() => exits.some((e) => e.sessionId === 'k1'))).toBe(true);
    expect(exits.find((e) => e.sessionId === 'k1')?.reason).toBe('crash');
    expect(host.getProcess('k1')).toBeNull();
    expect(await until(() => !pidAlive(cpid))).toBe(true); // 孤儿被整组兜底收割
  }, 15000);

  test('拒信号进程(trap "" TERM)→ terminate 升级 SIGKILL 收割', async () => {
    // trap '' TERM 让 leader 忽略 SIGTERM;in-shell while 循环(短 sleep 子进程死了就重起)
    // 保证 leader 不会因前台子进程被 TERM 杀而提前结束 → 必须靠 SIGKILL 升级才收割。
    let ready = false;
    host.onData((sid, stream, chunk) => { if (sid === 'ig' && stream === 'stdout' && chunk.includes('READY')) ready = true; });
    await host.startSession(req({ sessionId: 'ig', cmd: 'bash', args: ['-c', "trap '' TERM; echo READY; while true; do sleep 0.2; done"] }));
    const pid = host.getProcess('ig')!.pid;
    // 必须等 trap 安装完(READY)再发 TERM——否则信号早到、默认动作直接杀死 leader(竞态,非升级)。
    expect(await until(() => ready)).toBe(true);
    await host.shutdownSession('ig'); // SIGTERM(被忽略)→ 宽限 → SIGKILL
    expect(await until(() => !pidAlive(pid))).toBe(true);
    expect(exits.find((e) => e.sessionId === 'ig')?.signal).toBe('SIGKILL');
  }, 15000);

  test('组内逃兵(nohup &)随 shutdown 整组收割', async () => {
    const fug = join(dir, 'fug.pid');
    await host.startSession(
      req({ sessionId: 'f1', cmd: 'bash', args: ['-c', `nohup sleep 999 >/dev/null 2>&1 & echo $! > ${fug}; sleep 60`] }),
    );
    expect(await until(() => existsSync(fug))).toBe(true);
    const fpid = Number(readFileSync(fug, 'utf8').trim());
    expect(pidAlive(fpid)).toBe(true);
    await host.shutdownSession('f1');
    expect(await until(() => !pidAlive(fpid))).toBe(true);
  }, 15000);

  test('spawn ENOENT → SPAWN_FAILED 或 crash 退出,且 session 不残留(无泄漏)', async () => {
    let threw = false;
    try {
      await host.startSession(req({ sessionId: 'bad', cmd: 'definitely-not-a-real-binary-xyz', args: [] }));
    } catch {
      threw = true;
    }
    // 两条路都可接受:① pid<=0 → 立抛 SPAWN_FAILED;② 异步 'error' → onExit{crash}。
    const settled = await until(() => threw || exits.some((e) => e.sessionId === 'bad'));
    expect(settled).toBe(true);
    expect(host.getProcess('bad')).toBeNull(); // 关键:不留挂账
  }, 15000);

  test('幂等:shutdown 未知/重复不抛;cancel 未知 callId → SESSION_NOT_FOUND', async () => {
    await host.shutdownSession('ghost'); // 未知,静默
    await host.startSession(req({ sessionId: 'd1', cmd: 'bash', args: ['-c', 'sleep 60'] }));
    await host.shutdownSession('d1');
    await host.shutdownSession('d1'); // 重复,不抛
    let code: unknown;
    await host.cancel('no-such-call').catch((e: { code?: number }) => { code = e.code; });
    expect(code).toBe(-32000); // SESSION_NOT_FOUND
  }, 15000);

  test('start+立即 cancel 竞态 → onExit{cancelled} + 清理', async () => {
    await host.startSession(req({ sessionId: 's-race', callId: 'c-race', cmd: 'bash', args: ['-c', 'sleep 60'] }));
    await host.cancel('c-race');
    expect(await until(() => exits.some((e) => e.sessionId === 's-race'))).toBe(true);
    expect(exits.find((e) => e.sessionId === 's-race')?.reason).toBe('cancelled');
    expect(host.getProcess('s-race')).toBeNull();
  }, 15000);

  test('churn:40 轮短命 spawn+退出 无泄漏(终态 0 session)', async () => {
    for (let i = 0; i < 40; i++) {
      const g = await host.startSession(req({ sessionId: `c${i}`, cmd: 'bash', args: ['-c', 'exit 0'] }));
      expect(g.pid).toBeGreaterThan(0);
      // eslint-disable-next-line no-await-in-loop
      await until(() => exits.some((e) => e.sessionId === `c${i}`), 3000);
    }
    expect(await until(() => host.listSessions().length === 0)).toBe(true);
  }, 30000);

  test('stdout 洪流(10万行)全程转发不崩,exit{done}', async () => {
    let bytes = 0;
    host.onData((sid, stream, chunk) => { if (sid === 'flood' && stream === 'stdout') bytes += chunk.length; });
    await host.startSession(
      req({ sessionId: 'flood', cmd: 'bash', args: ['-c', 'for i in $(seq 1 100000); do echo "line-$i-payloadpayload"; done'] }),
    );
    expect(await until(() => exits.some((e) => e.sessionId === 'flood'), 20000)).toBe(true);
    expect(exits.find((e) => e.sessionId === 'flood')?.reason).toBe('done');
    expect(bytes).toBeGreaterThan(1_000_000);
  }, 25000);
});
