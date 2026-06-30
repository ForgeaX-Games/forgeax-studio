/**
 * plan-mode serve→JSON-RPC E2E —— 真栈 + 真 Anthropic。
 *
 * 不是 .test.ts(bun test 不自动收;真 API + 网络 + spawn 子进程)。手动跑(`bun run e2e:plan`):
 *   set -a; source <repo>/.env; set +a
 *   bun packages/core/test/plan-serve-e2e.ts
 * 退出码 = 失败数。无 ANTHROPIC_API_KEY 时清晰跳过(exit 0)。
 *
 * 验证(对位 subagent-serve-e2e.ts 的 serve harness;补 plan 只读强制这条线):
 *   spawn `forgeax-core --serve --sock <tmp.sock>`(cwd=临时目录,隔离写)→ 连 JSON-RPC →
 *   `setPermissionMode(planning)` → `runTurn`(提示模型用 write_file 落一个文件)→
 *   plan 模式在核内 deny 非只读工具(engine.ts:246)→ 文件**不应被创建**,且若模型确有尝试,
 *   应见到一条 tool.result(ok:false)。
 *
 * Boundary:本文件在 test/ 下(不受 core src 边界 lint 约束),仅 import core-local rpc.ts +
 * agent-runtime 契约 + node:,与 src 同源线协议。
 */
import { resolve, join } from 'node:path';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** 等 socket 文件出现再连(connect 对缺失 unix sock 会抛),重试到 serve 就绪。 */
async function connectRetry(sock: string, deadlineMs = 10000): Promise<RpcConnection> {
  const end = Date.now() + deadlineMs;
  while (!existsSync(sock)) {
    if (Date.now() > end) throw new Error(`serve socket never appeared: ${sock}`);
    await sleep(120);
  }
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

function turnReq(callId: string, prompt: string): TurnRequest {
  return {
    session: { threadId: callId, agentId: 'forge' },
    callId,
    input: { text: prompt },
    systemPrompt: { charter: 'You are a terse test agent. Use tools when asked.', persona: '' },
    tools: [],
    budget: { maxTurns: 6 },
    model: MODEL,
    hostSessionId: 'sid-plan-e2e',
    trustTier: 'own',
  } as TurnRequest;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[plan-serve-e2e] 跳过:未设 ANTHROPIC_API_KEY(真 API e2e,需先 `set -a; source .env; set +a`)。');
    process.exit(0);
  }
  console.log(`[plan-serve-e2e] model=${MODEL}\n`);

  const workdir = mkdtempSync(join(tmpdir(), 'fxc-plan-e2e-'));
  const target = join(workdir, 'plan_test.txt'); // plan 模式下不应被创建
  const sock = `/tmp/fx-plan-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`;
  const proc = Bun.spawn({
    cmd: ['bun', CORE_SERVE, '--serve', '--sock', sock],
    cwd: workdir, // serve 本地工具(write_file)的 cwd = 此处 → 写落在隔离目录
    env: process.env as Record<string, string>,
    stdout: 'ignore',
    stderr: 'inherit',
  });

  const events: KernelEvent[] = [];
  const callId = `c-plan-${Date.now()}`;
  try {
    const conn = await connectRetry(sock);
    conn.setRequestHandler(async (method) => {
      // plan 模式应在写工具执行前就 deny —— 正常情况下 host 桥不会被写工具触达。
      throw Object.assign(new Error(`unexpected hostTool in plan mode: ${method}`), { code: -32601 });
    });
    conn.onNotify((method, params) => {
      if (method === 'event') events.push((params as { event: KernelEvent }).event);
    });

    console.log('E2E · serve-direct + 真模型 + plan 模式 → 写被拒、文件不落盘');
    // 先切 plan(planning),再发让其写文件的轮。
    await conn.request('setPermissionMode', { callId, mode: 'planning' });
    await conn.request(
      'runTurn',
      turnReq(
        callId,
        `Use the write_file tool to create a file named "plan_test.txt" in the current directory with the content "hello". ` +
          `Do it now with the tool.`,
      ),
    );
    conn.close();

    const kinds = events.map((e) => e.kind);
    // 主断言:plan 只读强制 → 文件没被创建。
    check('plan 模式下文件未被创建(写被拦)', !existsSync(target), { target });
    // 若模型确有尝试写,应见到一条失败的 tool.result(deny);没尝试也可接受(软断言)。
    const toolResults = events.filter(
      (e): e is Extract<KernelEvent, { kind: 'tool.result' }> => e.kind === 'tool.result',
    );
    const anyDenied = toolResults.some((r) => r.ok === false);
    check('若尝试了写工具,则被 deny(ok:false);未尝试则视为通过', toolResults.length === 0 || anyDenied, kinds);
    // 轮正常收口(没整段崩)。
    check('父轮正常收口(turn.done)', kinds.includes('turn.done'), kinds);
    // 没有写工具触达 host 桥(plan 在核内就 deny 了)。
    check('写工具未触达 host 桥', !events.some((e) => e.kind === 'tool.result' && e.ok === true && /write/i.test(JSON.stringify(e))), kinds);
  } catch (e) {
    check('E2E 未抛异常', false, (e as Error).message);
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n[plan-serve-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[plan-serve-e2e] fatal:', e);
  process.exit(1);
});
