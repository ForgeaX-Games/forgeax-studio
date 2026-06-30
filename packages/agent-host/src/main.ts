#!/usr/bin/env bun
/**
 * forgeax-agent-host 进程入口 —— 解析 socket 路径 + 单例/陈旧 socket 恢复(R3-13)+ 起 server。
 *
 * 单例:socket 存在 → 试连 + ping;活着 → 令旧实例 `shutdown` → 接管;连不上(陈旧)→ unlink。
 * 不报 EADDRINUSE。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect } from './ipc';
import { startAgentHostServer } from './server';
import { sweepOrphans } from './orphan-registry';
import { DEFAULT_SOCK_ENV } from './types';

export function resolveSockPath(): string {
  const fromEnv = process.env[DEFAULT_SOCK_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return join(homedir(), '.forgeax', 'agent-host.sock');
}

/** 处理已存在的 socket:活实例 → 请它 shutdown;陈旧 → unlink。返回后可安全 listen。 */
async function reclaimSocket(sockPath: string): Promise<void> {
  try {
    const conn = await connect(sockPath, 1500);
    // 活着 → 让旧实例优雅退出。**立刻关探测连接**:否则旧实例 server.close 会被本连接挂住,
    // 而我们又在等它放 socket → 死锁。
    await conn.request('shutdown').catch(() => {});
    conn.close();
    for (let i = 0; i < 20; i++) {
      if (process.platform !== 'win32' && !existsSync(sockPath)) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch {
    /* 连不上 = 陈旧 socket (或原本就不存在) */
  }
  try { rmSync(sockPath, { force: true }); } catch { /* ignore */ }
}

export async function main(): Promise<void> {
  const sockPath = resolveSockPath();
  mkdirSync(dirname(sockPath), { recursive: true });
  await reclaimSocket(sockPath);

  // 硬杀恢复:收割上一条命(被 SIGKILL,没走优雅关停)残留的内核进程组孤儿。
  const reaped = sweepOrphans(`${sockPath}.orphans`);
  if (reaped > 0) process.stderr.write(`[agent-host] swept ${reaped} orphan process group(s) from a prior hard kill\n`);

  const srv = await startAgentHostServer(sockPath);

  const pidFile = `${sockPath}.pid`;
  try { writeFileSync(pidFile, String(process.pid)); } catch { /* ignore */ }
  process.stderr.write(`[agent-host] listening on ${sockPath} (pid ${process.pid})\n`);

  const shutdown = async (): Promise<void> => {
    await srv.close().catch(() => {});
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// 直接 `bun src/main.ts` 运行(非被 import 时)。
if (import.meta.main) {
  main().catch((e) => { process.stderr.write(`[agent-host] fatal: ${(e as Error).message}\n`); process.exit(1); });
}
