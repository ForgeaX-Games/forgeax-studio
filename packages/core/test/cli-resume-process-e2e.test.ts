/**
 * 跨进程 resume e2e —— 驱动**真实 forgeax-core 二进制**两次(两个独立进程),验证
 * `--resume <id>` 让会话历史跨进程持久化 + fold 回灌:
 *   进程 A:`--resume sX -p "..."` 跑 turn1 → 事件流落 per-session WAL(events.jsonl)。
 *   进程 B:`--resume sX -p "..."` 复用同一 WAL → foldSessionHistory 重建历史 → seed 进 loop。
 *
 * 这条补的是覆盖空白:cli-resume.test.ts / cli-resume-fold.test.ts 都是 in-process(直调
 * runTurn + store),没有"两个真进程共享一个会话"的真链路;compaction-resume-e2e 只单进程
 * resume 预置 WAL。本测试钉死跨进程 durability + fold round-trip。
 *
 * 观测点(双锚):
 *   1) WAL 累计两轮的 user_prompt.submit + assistant.message(事件流即真相,跨进程 append)。
 *   2) mock Anthropic 记录每次请求的 messages 条数:进程 B 的请求条数 > 进程 A —— 证明历史
 *      确实被 fold 进了进程 B 的 provider 请求(不是各跑各的)。
 *
 * 全程离线(mock SSE),属 `bun test`。Boundary(test 层):node: + Bun + 相对 import。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');

// ─── mock Anthropic SSE(纯文本回合)+ 记录每次请求的 messages 条数 ────────────
function sse(frames: Array<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}
function textTurn(text: string): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'm', role: 'assistant', model: 'x', usage: { input_tokens: 9, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';
/** 每次主对话请求收到的 messages 条数(按到达顺序)。 */
let msgCounts: number[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { system?: Array<{ text?: string }>; messages?: unknown[] };
      const sys = (body.system ?? []).map((b) => b.text ?? '').join('\n');
      // 只统计主对话请求(排除 auto-memory 的 side-query;本测试 --no-memory,稳妥再排一次)。
      if (!sys.includes('extract durable') && !sys.includes('select which stored memories')) {
        msgCounts.push((body.messages ?? []).length);
      }
      return new Response(textTurn('ack'), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_resume_e2e' } });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});
afterAll(() => server?.stop(true));

async function runProc(sessionsDir: string, sessionId: string, prompt: string): Promise<number> {
  const proc = Bun.spawn(['bun', MAIN, '--no-memory', '--sessions-dir', sessionsDir, '--resume', sessionId, '-p', prompt], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, ANTHROPIC_API_KEY: 'dummy-resume-e2e', ANTHROPIC_BASE_URL: baseUrl, FORGEAX_MODEL: 'forgeax-e2e' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return proc.exited;
}

function walTypes(file: string): string[] {
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push((JSON.parse(line) as { type: string }).type);
    } catch {
      /* skip */
    }
  }
  return out;
}

describe('cross-process --resume (two real binary processes share one session WAL)', () => {
  test('process B resumes process A: WAL accumulates both turns AND B sees A history folded in', async () => {
    msgCounts = [];
    const root = mkdtempSync(join(tmpdir(), 'fxc-resume-proc-'));
    const sessionsDir = join(root, 'sessions');
    const wal = join(sessionsDir, 'sess1', 'events.jsonl');
    try {
      // 进程 A:第一轮,全新会话。
      const codeA = await runProc(sessionsDir, 'sess1', 'first turn');
      expect(codeA).toBe(0);
      const afterA = walTypes(wal);
      expect(afterA.filter((t) => t === 'user_prompt.submit').length).toBe(1);
      expect(afterA.filter((t) => t === 'assistant.message').length).toBe(1);

      // 进程 B:独立进程 resume 同一会话,第二轮。
      const codeB = await runProc(sessionsDir, 'sess1', 'second turn');
      expect(codeB).toBe(0);
      const afterB = walTypes(wal);
      // WAL 跨进程 append:两轮的 user/assistant 都在(durability)。
      expect(afterB.filter((t) => t === 'user_prompt.submit').length).toBe(2);
      expect(afterB.filter((t) => t === 'assistant.message').length).toBe(2);

      // fold round-trip:进程 B 的 provider 请求带了历史 → 条数 > 进程 A 的首轮请求。
      expect(msgCounts.length).toBeGreaterThanOrEqual(2);
      const firstReq = msgCounts[0]; // 进程 A:只有当前 user(可能含 system-reminder 包装,但条数最少)
      const lastReq = msgCounts[msgCounts.length - 1]; // 进程 B:历史 + 新 user
      expect(lastReq).toBeGreaterThan(firstReq);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45000);
});
