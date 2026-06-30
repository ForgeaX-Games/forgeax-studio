/**
 * L7 子 agent 可观测性 serve→JSON-RPC E2E —— 真栈 + 真 Anthropic。
 *
 * 不是 .test.ts(bun test 不自动收;真 API + 网络 + spawn 子进程)。手动跑:
 *   set -a; source <repo>/.env; set +a
 *   bun packages/core/test/subagent-serve-e2e.ts
 * 退出码 = 失败数。无 ANTHROPIC_API_KEY 时清晰跳过(exit 0)。
 *
 * 验证(对位 test/e2e-real.ts 的 subagent/Task case + server/test/serve-e2e.ts 的 serve harness):
 *   spawn `forgeax-core --serve --sock <tmp.sock>` → 连 JSON-RPC → runTurn(带 host 工具 +
 *   提示模型用 Task 派子 agent)→ serve 内核派子 agent → onSubagentEvent → `x.subagent.*`
 *   KernelEvent 经 `event` 通知流回。断言收到 x.subagent.start/turn/tool/done,
 *   且 start 携 agentId/agentType/role/depth(契约字段)。
 *
 * Boundary:本文件在 test/ 下(不受 core src 边界 lint 约束),但仍只 import core-local
 * rpc.ts + agent-runtime 契约 + node:,与 src 同源线协议。
 */
import { resolve } from 'node:path';
import { connect } from 'node:net';
import { RpcConnection } from '../src/cli/rpc';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

const CORE_SERVE = resolve(import.meta.dir, '..', 'src', 'cli', 'main.ts');
const MODEL = process.env.FORGEAX_E2E_MODEL || process.env.FORGEAX_MODEL || 'claude-opus-4-8';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 连 unix-sock,重试到 serve listen 就绪。返回一条已连的 RpcConnection。 */
async function connectRetry(sock: string, deadlineMs = 8000): Promise<RpcConnection> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const conn = await new Promise<RpcConnection | null>((res) => {
      const s = connect(sock, () => res(new RpcConnection(s)));
      s.on('error', () => res(null));
    });
    if (conn) return conn;
    if (Date.now() > end) throw new Error(`serve endpoint not reachable: ${sock}`);
    await sleep(150);
  }
}

/** 一个永远成功的 host 工具(子 agent 经反向 hostTool 桥执行它)。 */
const TOOL = {
  name: 'compute',
  description: 'Compute and return a number. Always succeeds.',
  inputSchema: { type: 'object', properties: { expr: { type: 'string' } } },
};

function turnReq(prompt: string): TurnRequest {
  return {
    session: { threadId: `t-${Date.now()}`, agentId: 'forge' },
    callId: `c-${Date.now()}`,
    input: { text: prompt },
    systemPrompt: { charter: 'You are a terse test agent.', persona: '' },
    tools: [TOOL],
    budget: { maxTurns: 6 },
    model: MODEL,
    hostSessionId: 'sid-sub-e2e',
    trustTier: 'own',
  } as TurnRequest;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[subagent-serve-e2e] 跳过:未设 ANTHROPIC_API_KEY(真 API e2e,需先 `set -a; source .env; set +a`)。');
    process.exit(0);
  }
  console.log(`[subagent-serve-e2e] model=${MODEL}\n`);

  const sock = `/tmp/fx-sub-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`;
  const proc = Bun.spawn({
    cmd: ['bun', CORE_SERVE, '--serve', '--sock', sock],
    env: process.env as Record<string, string>,
    stdout: 'ignore',
    stderr: 'inherit',
  });

  const events: KernelEvent[] = [];
  try {
    const conn = await connectRetry(sock);
    // 反向 host-tool 桥:子 agent 调 compute 时,serve 回调宿主执行(返回固定数)。
    conn.setRequestHandler(async (method, params) => {
      if (method === 'hostTool') {
        void params;
        return { result: 42 };
      }
      throw Object.assign(new Error(`unknown ${method}`), { code: -32601 });
    });
    conn.onNotify((method, params) => {
      if (method === 'event') events.push((params as { event: KernelEvent }).event);
    });

    console.log('E2E · serve-direct + 真模型 + Task 派子 agent → x.subagent.* 出墙');
    await conn.request(
      'runTurn',
      turnReq(
        'Use the Task tool to delegate a subagent (subagent_type "math") with this prompt: ' +
          '"Use the compute tool with expr set to 6*7, then report just the number." ' +
          'After the subagent finishes, reply with the single word DONE.',
      ),
    );
    conn.close();

    const kinds = events.map((e) => e.kind);
    const start = events.find((e) => e.kind === 'x.subagent.start') as
      | { agentId: string; agentType?: string; role?: string; depth: number }
      | undefined;
    check('收到 x.subagent.start', kinds.includes('x.subagent.start'), kinds);
    check('x.subagent.start 携 agentId', !!start?.agentId, start);
    check('x.subagent.start 携 depth(number)', typeof start?.depth === 'number', start);
    // agentType/role 取决于父模型选的类型;至少 start 事件结构成立即记一笔(软断言)。
    check('x.subagent.start 携 agentType(非空)', !!start?.agentType, start);
    check('收到 x.subagent.turn', kinds.includes('x.subagent.turn'), kinds);
    check('收到 x.subagent.tool', kinds.includes('x.subagent.tool'), kinds);
    const done = events.find((e) => e.kind === 'x.subagent.done') as
      | { reason: string; turns: number; toolCalls: number }
      | undefined;
    check('收到 x.subagent.done', kinds.includes('x.subagent.done'), kinds);
    check('x.subagent.done 携 turns/toolCalls(number)', typeof done?.turns === 'number' && typeof done?.toolCalls === 'number', done);
    // 顺序:start 必在 done 之前。
    check('x.subagent.start 在 x.subagent.done 之前', kinds.indexOf('x.subagent.start') < kinds.lastIndexOf('x.subagent.done'), kinds);
    check('父轮正常收口(turn.done)', events.some((e) => e.kind === 'turn.done'));
  } catch (e) {
    check('E2E 未抛异常', false, (e as Error).message);
  } finally {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }

  console.log(`\n[subagent-serve-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[subagent-serve-e2e] fatal:', e);
  process.exit(1);
});
