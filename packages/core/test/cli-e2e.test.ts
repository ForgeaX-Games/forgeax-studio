/**
 * CLI e2e —— 驱动**真实 forgeax-core 二进制**(子进程),指向本地 mock Anthropic
 * 服务(脚本化 SSE),验证整条链路在真实进程 + 真实 IO 下符合预期:
 *   loop · provider(真 fetch)· tool dispatch(真 NodeTerminal 跑 bash 写盘)·
 *   auto-memory(真 extract 写 .md)· 渲染 · 退出码。
 * 不需 API key(baseUrl 指 localhost)。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');

// ─── mock Anthropic SSE ────────────────────────────────────────────────────
function sse(frames: Array<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}
function toolUseTurn(name: string, input: unknown): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'm', role: 'assistant', model: 'x', usage: { input_tokens: 9, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
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
let mainCalls = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { system?: Array<{ text?: string }> };
      const sys = (body.system ?? []).map((b) => b.text ?? '').join('\n');
      let payload: string;
      if (sys.includes('extract durable')) {
        // auto-extract sideQuery → 返回记忆 JSON
        payload = textTurn(JSON.stringify({ memories: [{ type: 'user', name: 'E2E Pref', description: 'set in e2e', body: 'user validated forgeax-core via e2e' }] }));
      } else if (sys.includes('select which stored memories')) {
        payload = textTurn(JSON.stringify({ selected: ['e2e-pref.md'] }));
      } else {
        // 主对话:第 1 次要工具,第 2 次结束
        mainCalls++;
        payload = mainCalls === 1 ? toolUseTurn('bash', { command: 'echo E2E_TOOL_RAN > proof.txt' }) : textTurn('All done via e2e.');
      }
      return new Response(payload, { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_e2e' } });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});
afterAll(() => server?.stop(true));

async function runCli(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: 'dummy-e2e', ANTHROPIC_BASE_URL: baseUrl, FORGEAX_MODEL: 'forgeax-e2e', ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out, err };
}

describe('CLI e2e — real binary against mock Anthropic', () => {
  test('tool-call turn: loop → real bash via NodeTerminal → file written → assistant text', async () => {
    mainCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), 'fxc-e2e-'));
    try {
      const { code, out } = await runCli(['-p', 'please run the tool', '--no-memory'], cwd);
      expect(code).toBe(0);
      // 渲染:工具调用 + 结果 + assistant 文本
      expect(out).toContain('⏺ bash');
      expect(out).toContain('All done via e2e.');
      // 真实副作用:NodeTerminal 真跑了 bash,proof.txt 落盘
      const proof = join(cwd, 'proof.txt');
      expect(existsSync(proof)).toBe(true);
      expect(readFileSync(proof, 'utf8')).toContain('E2E_TOOL_RAN');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  test('auto-memory: end-of-turn extract writes a real .md + MEMORY.md index', async () => {
    mainCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), 'fxc-e2e-'));
    try {
      const { code } = await runCli(['-p', 'remember my preference'], cwd); // memory 默认开
      expect(code).toBe(0);
      const memDir = join(cwd, '.forgeax', 'memory');
      expect(existsSync(memDir)).toBe(true);
      const files = readdirSync(memDir);
      expect(files.some((f) => f.endsWith('.md') && f !== 'MEMORY.md')).toBe(true);
      expect(files).toContain('MEMORY.md');
      const mem = files.find((f) => f.endsWith('.md') && f !== 'MEMORY.md')!;
      expect(readFileSync(join(memDir, mem), 'utf8')).toContain('validated forgeax-core via e2e');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  test('--no-memory: no memory dir created', async () => {
    mainCalls = 0;
    const cwd = mkdtempSync(join(tmpdir(), 'fxc-e2e-'));
    try {
      const { code } = await runCli(['-p', 'hi', '--no-memory'], cwd);
      expect(code).toBe(0);
      expect(existsSync(join(cwd, '.forgeax', 'memory'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  test('--help / --version (form factor, no network)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fxc-e2e-'));
    try {
      const h = await runCli(['--help'], cwd);
      expect(h.code).toBe(0);
      expect(h.out).toContain('forgeax-core');
      expect(h.out).toContain('-p, --print');
      const v = await runCli(['--version'], cwd);
      expect(v.code).toBe(0);
      expect(v.out).toContain('forgeax-core 0.1.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  test('--demo: built-in echo provider, no key needed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fxc-e2e-'));
    try {
      const proc = Bun.spawn(['bun', MAIN, '--demo', '-p', '贪吃蛇', '--no-memory'], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '' }, stdout: 'pipe' });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(out).toContain('forgeax-core(demo)');
      expect(out).toContain('贪吃蛇');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
