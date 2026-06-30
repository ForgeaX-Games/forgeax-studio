/**
 * 可观测性 serve→RPC→落盘 真栈 E2E(非 .test.ts;真 Anthropic + spawn 子进程)。
 * 跑:  set -a; source <repo>/.env; set +a;  bun packages/core/test/observability-serve-e2e.ts
 *
 * 真实链路:spawn `forgeax-core --serve` → 真模型跑一轮(带 host 工具)→ serve.ts 里
 *   makeNodeObservability 把 span/log 经 `conn.notify('telemetry',{records})` 回流 →
 *   本客户端(扮演 server adapter 角色)收 telemetry → 按 kind 落 append-JSONL:
 *     <repo>/.forgeax-obs-e2e/<sid>/logs/{trace,log}.jsonl
 * 末尾回读文件,打印真实 trace + log 样本与落盘绝对路径。
 */
import { resolve, join } from 'node:path';
import { connect } from 'node:net';
import { mkdirSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { RpcConnection } from '../src/cli/rpc';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

const CORE_MAIN = resolve(import.meta.dir, '..', 'src', 'cli', 'main.ts');
const REPO = resolve(import.meta.dir, '..', '..', '..');
const MODEL = process.env.FORGEAX_E2E_MODEL || process.env.FORGEAX_MODEL || 'claude-opus-4-8';
const SID = `obs-e2e-${Date.now()}`;
const LOGS_DIR = join(REPO, '.forgeax-obs-e2e', SID, 'logs');
const TRACE_FILE = join(LOGS_DIR, 'trace.jsonl');
const LOG_FILE = join(LOGS_DIR, 'log.jsonl');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    hostSessionId: SID,
    trustTier: 'own',
  } as TurnRequest;
}

/** 扮演 server adapter 的 telemetry 落盘:按 kind 分流 append-JSONL(与 telemetry-file-sink 同形)。 */
function persist(records: unknown[]): { spans: number; logs: number } {
  mkdirSync(LOGS_DIR, { recursive: true });
  let spans = 0;
  let logs = 0;
  const spanLines: string[] = [];
  const logLines: string[] = [];
  for (const r of records) {
    const kind = (r as { kind?: unknown } | null)?.kind;
    let line: string;
    try {
      line = JSON.stringify(r) + '\n';
    } catch {
      continue;
    }
    if (kind === 'span') {
      spanLines.push(line);
      spans++;
    } else if (kind === 'log') {
      logLines.push(line);
      logs++;
    }
  }
  if (spanLines.length) appendFileSync(TRACE_FILE, spanLines.join(''));
  if (logLines.length) appendFileSync(LOG_FILE, logLines.join(''));
  return { spans, logs };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[obs-serve-e2e] 跳过:未设 ANTHROPIC_API_KEY(需 `set -a; source .env; set +a`)。');
    process.exit(0);
  }
  // 干净起步
  try { rmSync(join(REPO, '.forgeax-obs-e2e', SID), { recursive: true, force: true }); } catch { /* noop */ }

  console.log(`[obs-serve-e2e] model=${MODEL}  sid=${SID}`);
  const sock = `/tmp/fx-obs-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}.sock`;
  const proc = Bun.spawn({
    cmd: ['bun', CORE_MAIN, '--serve', '--sock', sock],
    env: process.env as Record<string, string>,
    stdout: 'ignore',
    stderr: 'ignore',
  });

  let totalSpans = 0;
  let totalLogs = 0;
  const events: KernelEvent[] = [];
  try {
    const conn = await connectRetry(sock);
    // host-tool 桥:模型调 compute → serve 回调宿主 → 返回固定数(触发真 tool 子 span)。
    conn.setRequestHandler(async (method) => {
      if (method === 'hostTool') return { result: 42 };
      throw Object.assign(new Error(`unknown ${method}`), { code: -32601 });
    });
    // 关键:收 serve.ts 经 makeNodeObservability 回流的 telemetry → 落盘。
    conn.onNotify((method, params) => {
      if (method === 'telemetry') {
        const records = (params as { records?: unknown[] })?.records ?? [];
        const { spans, logs } = persist(records);
        totalSpans += spans;
        totalLogs += logs;
        process.stdout.write(`  ← telemetry batch: +${spans} span / +${logs} log\n`);
      } else if (method === 'event') {
        events.push((params as { event: KernelEvent }).event);
      }
    });

    console.log('\nrunTurn(真模型;提示用 compute 工具后回 DONE)…');
    await conn.request(
      'runTurn',
      turnReq('Call the compute tool once with expr set to "6*7". After it returns, reply with the single word DONE.'),
    );
    // 让 80ms coalesce 窗口把尾批刷尽。
    await sleep(400);
    conn.close();
  } finally {
    proc.kill();
  }

  // ── 回读落盘文件,展示真实 trace + log ──
  console.log('\n================ 落盘回读 ================');
  console.log(`trace.jsonl: ${existsSync(TRACE_FILE) ? 'OK' : 'MISSING'}  →  ${TRACE_FILE}`);
  console.log(`log.jsonl  : ${existsSync(LOG_FILE) ? 'OK' : 'MISSING'}  →  ${LOG_FILE}`);

  const traceLines = existsSync(TRACE_FILE) ? readFileSync(TRACE_FILE, 'utf8').trim().split('\n').filter(Boolean) : [];
  const logLines = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean) : [];

  console.log(`\n[trace] ${traceLines.length} 行(provisional + final)。样本(final span 名 · traceId · dur):`);
  const finals = traceLines.map((l) => JSON.parse(l)).filter((s) => s.endTs != null);
  for (const s of finals.slice(0, 8)) {
    console.log(`  · ${s.name.padEnd(12)} trace=${String(s.traceId).slice(0, 12)} span=${String(s.spanId).slice(0, 8)} parent=${String(s.parentSpanId ?? '-').slice(0, 8)} dur=${(s.endTs - s.startTs).toFixed(1)}ms ${s.attrs?.tool ? `tool=${s.attrs.tool}` : ''}`);
  }

  console.log(`\n[log] ${logLines.length} 行。样本(level · msg · traceId):`);
  for (const l of logLines.slice(0, 10).map((x) => JSON.parse(x))) {
    console.log(`  · ${String(l.level).padEnd(5)} "${l.msg}" trace=${String(l.traceId ?? '-').slice(0, 12)} ${l.fields?.tool ? `tool=${l.fields.tool}` : ''}`);
  }

  // ── 断言:有真实 span + 真实 log,且 log 的 traceId 命中某 span ──
  const okSpans = finals.length > 0 && finals.some((s) => s.name === 'agent.run');
  const okLogs = logLines.length > 0;
  const spanTraceIds = new Set(traceLines.map((l) => JSON.parse(l).traceId));
  const logHitsTrace = logLines.map((x) => JSON.parse(x)).some((l) => l.traceId && spanTraceIds.has(l.traceId));
  const sawDone = events.some((e) => JSON.stringify(e).includes('DONE') || JSON.stringify(e).toLowerCase().includes('text'));

  console.log('\n================ 断言 ================');
  console.log(`  ${okSpans ? '✅' : '❌'} 真实 span 落盘(含 agent.run)`);
  console.log(`  ${okLogs ? '✅' : '❌'} 真实 log 落盘`);
  console.log(`  ${logHitsTrace ? '✅' : '❌'} 某条 log 的 traceId 命中同轮 span(log↔trace 关联)`);
  console.log(`  ${sawDone ? '✅' : '⚠️ '} 模型完成了一轮(收到 assistant 文本事件)`);

  const ok = okSpans && okLogs && logHitsTrace;
  console.log(`\n${ok ? '✅ E2E 通过' : '❌ E2E 失败'} · 落盘目录: ${LOGS_DIR}`);
  process.exit(ok ? 0 : 1);
}

void main();
