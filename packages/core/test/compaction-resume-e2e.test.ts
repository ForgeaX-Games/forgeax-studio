/**
 * 上下文压缩触发 e2e —— 驱动**真实 forgeax-core 二进制**(子进程,`--demo` 免 API key),
 * 用脚本预置一段长历史 WAL,验证「`--resume` 这个会话 + 发一条消息」一上来就越过压缩水位、
 * 触发 compaction,整条链路在真实进程下闭环:
 *   seed WAL → resume fold 出历史 → loop 估 token 越水位 → V2 闸放行 → 压缩 → 事件落盘。
 *
 * 观测点是 WAL 本身(SSOT、事件流即真相):压缩成功会把 `compaction.applied` 经同一 bus
 * connectStore 落进 events.jsonl,跨进程可读、确定性断言,不依赖 stdout 渲染文字。
 *
 * 触发靠 `FORGEAX_COMPACT_WINDOW` 把模型窗口钳小(effective = 钳后窗口 - 20000;
 * emergency = effective×0.92),让一段适中历史就越线 —— 无需造 660KB 真实历史。
 * 负向 control 用同一份历史、不钳窗口(真 200k 窗口)→ 不触发,证明断言非恒真。
 *
 * hermetic:`--demo` 内置 echo provider(连 summarize 也走它),全程不打网络;属 `bun test`。
 * Boundary(HOST/test 层):node: + Bun + 相对 import(含 scripts/ 的 seed builder)。
 */
import { test, expect, describe, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSession } from '../scripts/seed-session';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');

interface RunResult {
  code: number | null;
  /** WAL 里每个事件的 type(顺序保留)。 */
  types: string[];
  /** compaction.applied 事件的 payload(若有)。 */
  applied: Array<{ coveredFrom?: number; coveredTo?: number; replacement?: unknown }>;
}

/** 读 WAL events.jsonl → 投影出 type 列表 + compaction.applied 载荷(坏行跳过)。 */
function readWal(file: string): Pick<RunResult, 'types' | 'applied'> {
  const types: string[] = [];
  const applied: RunResult['applied'] = [];
  if (!existsSync(file)) return { types, applied };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { type: string; payload?: unknown };
      types.push(e.type);
      if (e.type === 'compaction.applied') applied.push((e.payload ?? {}) as RunResult['applied'][number]);
    } catch {
      /* skip corrupt line */
    }
  }
  return { types, applied };
}

/** seed 一段历史 → `--demo --resume <id> -p` 发一条消息 → 读回 WAL。extraEnv 控制窗口钳制。 */
async function seedAndResume(
  dir: string,
  sessionId: string,
  extraEnv: Record<string, string>,
): Promise<RunResult & { estTokens: number }> {
  const sessionsDir = join(dir, 'sessions');
  const { file, estTokens } = seedSession({ sessionsDir, sessionId, turns: 20 });
  const proc = Bun.spawn(['bun', MAIN, '--demo', '--no-memory', '--sessions-dir', sessionsDir, '--resume', sessionId, '-p', '继续'], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, ANTHROPIC_API_KEY: '', ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, estTokens, ...readWal(file) };
}

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeax-compact-resume-'));
});

describe('compaction trigger on resume (real binary, --demo, no network)', () => {
  test(
    'clamped window + seeded history → compaction fires (compaction.applied in WAL)',
    async () => {
      // effective = 22000 - 20000 = 2000;emergency = 1840。seed ~5200 token ≫ 1840。
      const r = await seedAndResume(root, 'trigger', { FORGEAX_COMPACT_WINDOW: '22000' });
      expect(r.code).toBe(0);
      expect(r.estTokens).toBeGreaterThan(1840); // 预置历史确实越过 emergency 水位
      // 压缩发生:applied 事件落了盘,且 pre/post 也在(完整 PreCompact→Applied→PostCompact)。
      expect(r.applied.length).toBeGreaterThanOrEqual(1);
      expect(r.types).toContain('compaction.pre');
      expect(r.types).toContain('compaction.post');
      // 载荷成形:覆盖了历史区间 + 有非空 replacement。
      const a = r.applied[0];
      expect(a.coveredFrom).toBe(0);
      expect(a.coveredTo).toBeGreaterThan(0);
      expect(a.replacement).toBeTruthy();
    },
    60_000,
  );

  test(
    'same history, full real window → no compaction (assertion is not vacuous)',
    async () => {
      // 不钳窗口:默认 claude-opus-4-8 → 200k 窗口,emergency ~165k ≫ ~5200 token → 不触发。
      const r = await seedAndResume(root, 'control', {});
      expect(r.code).toBe(0);
      expect(r.applied.length).toBe(0);
      expect(r.types).not.toContain('compaction.applied');
      // 但这一轮确实正常跑完了(新的 user_prompt.submit 落了盘),证明"没触发"≠"没跑"。
      expect(r.types.filter((t) => t === 'user_prompt.submit').length).toBeGreaterThan(20);
    },
    60_000,
  );
});
