/**
 * 真 CLI e2e 跑全 case —— 用真实 forgeax-core 二进制 + 真 Anthropic API 逐条验证。
 * 不是 .test.ts(bun test 不自动收;真 API + 网络),手动跑:
 *   set -a; source <repo>/.env; set +a
 *   bun test/e2e-real.ts
 * 退出码 = 失败数。每条:真 spawn CLI → 断言 stdout / 真实落盘副作用。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('需要 ANTHROPIC_API_KEY(先 `set -a; source .env; set +a`)。');
  process.exit(2);
}

interface CaseDef {
  name: string;
  setup?: (dir: string) => void;
  args: (dir: string) => string[];
  assert: (r: { code: number; out: string; dir: string }) => string | null; // null=pass,否则失败原因
  reuseDir?: string; // 复用某 case 的 dir(用于 recall)
}

async function spawnCli(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', MAIN, ...args], {
    cwd: dir,
    env: { ...process.env, ANTHROPIC_API_KEY: KEY, FORGEAX_MODEL: process.env.FORGEAX_MODEL ?? 'claude-opus-4-8' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const code = await proc.exited;
  return { code, out };
}

const has = (out: string, s: string) => out.toLowerCase().includes(s.toLowerCase());
const toolsUsed = (out: string) => [...out.matchAll(/⏺ (\w+)/g)].map((m) => m[1]);

const cases: CaseDef[] = [
  {
    name: 'loop/text turn (end_turn 渲染)',
    args: () => ['-p', 'Reply with exactly this token and nothing else: PASS_TEXT', '--no-memory'],
    assert: (r) => (r.code === 0 && has(r.out, 'PASS_TEXT') ? null : 'no PASS_TEXT'),
  },
  {
    name: 'tool/bash (真 NodeTerminal 写盘)',
    args: () => ['-p', 'Use the bash tool to run exactly: echo BASH_OK > a.txt', '--no-memory'],
    assert: (r) =>
      existsSync(join(r.dir, 'a.txt')) && readFileSync(join(r.dir, 'a.txt'), 'utf8').includes('BASH_OK')
        ? null
        : 'a.txt 未由 bash 写出',
  },
  {
    name: 'tool/write_file (真写盘)',
    args: () => ['-p', 'Use the write_file tool to create b.txt whose content is exactly: WRITE_OK', '--no-memory'],
    assert: (r) =>
      existsSync(join(r.dir, 'b.txt')) && readFileSync(join(r.dir, 'b.txt'), 'utf8').includes('WRITE_OK')
        ? null
        : 'b.txt 未由 write_file 写出',
  },
  {
    name: 'tool/read_file (真读盘回报)',
    setup: (d) => writeFileSync(join(d, 'c.txt'), 'READ_SECRET_42'),
    args: () => ['-p', 'Use the read_file tool to read c.txt and reply with its exact content.', '--no-memory'],
    assert: (r) => (has(r.out, 'READ_SECRET_42') ? null : '未读出 c.txt 内容'),
  },
  {
    name: 'tool/grep (真搜索)',
    setup: (d) => {
      writeFileSync(join(d, 'f1.txt'), 'nothing here');
      writeFileSync(join(d, 'f2.txt'), 'contains NEEDLE_X here');
    },
    args: () => ['-p', 'Use the grep tool to find which file contains NEEDLE_X, then reply with just that filename.', '--no-memory'],
    assert: (r) => (has(r.out, 'f2.txt') ? null : '未定位到 f2.txt'),
  },
  {
    name: 'tool/glob (真匹配)',
    setup: (d) => {
      writeFileSync(join(d, 'doc1.md'), '# a');
      writeFileSync(join(d, 'note.txt'), 'b');
      writeFileSync(join(d, 'doc2.md'), '# c');
    },
    args: () => ['-p', 'Use the glob tool to list all *.md files and reply with their names.', '--no-memory'],
    assert: (r) => (has(r.out, 'doc1.md') && has(r.out, 'doc2.md') ? null : '未列出 md 文件'),
  },
  {
    name: 'loop/multi-turn 多工具任务',
    args: () => ['-p', 'First use a tool to write d.txt containing the word COUNTVALUE, then read it back and tell me what it says.', '--no-memory'],
    assert: (r) =>
      existsSync(join(r.dir, 'd.txt')) && has(r.out, 'COUNTVALUE') ? null : 'd.txt 写读回环未完成',
  },
  {
    name: 'auto-memory/extract (回合末真抽取落盘)',
    args: () => ['-p', 'Please remember for future sessions: my favorite color is teal.'],
    assert: (r) => {
      const mem = join(r.dir, '.forgeax', 'memory');
      if (!existsSync(mem)) return '无 memory 目录';
      const md = readdirSync(mem).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      if (md.length === 0) return '未抽取出 .md';
      const all = md.map((f) => readFileSync(join(mem, f), 'utf8')).join('\n').toLowerCase();
      return all.includes('teal') ? null : 'memory 未含 teal';
    },
  },
  {
    name: 'subagent/Task (派子 agent → 隔离上下文 → 返回结果)',
    args: () => ['-p', 'Use the Task tool to delegate to a subagent: ask it to compute 6 times 7 and report just the number. Then tell me the subagent\'s answer.', '--no-memory'],
    assert: (r) => (has(r.out, '42') ? null : 'subagent 未返回 42'),
  },
  {
    name: 'cli/--help',
    args: () => ['--help'],
    assert: (r) => (r.code === 0 && has(r.out, 'forgeax-core') && has(r.out, '--print') ? null : 'help 输出异常'),
  },
  {
    name: 'cli/--version',
    args: () => ['--version'],
    assert: (r) => (r.code === 0 && has(r.out, 'forgeax-core 0.1.0') ? null : 'version 输出异常'),
  },
  {
    name: 'cli/--demo (无 key echo)',
    args: () => ['--demo', '-p', 'hello-demo', '--no-memory'],
    assert: (r) => (r.code === 0 && has(r.out, 'demo') && has(r.out, 'hello-demo') ? null : 'demo 异常'),
  },
  {
    name: 'cli/--no-memory (不建目录)',
    args: () => ['-p', 'Reply OK', '--no-memory'],
    assert: (r) => (!existsSync(join(r.dir, '.forgeax', 'memory')) ? null : '不应建 memory 目录'),
  },
];

// ── auto-memory recall:在 extract case 的 dir 上再跑一轮,验证召回 ──
// ── 新增能力的本地 fixture 服务(web_fetch / web_search / mcp)──────────────────
function startFixtures() {
  const web = Bun.serve({
    port: 0,
    fetch: () => new Response('<html><body><p>WEBFETCH_OK</p></body></html>', { headers: { 'content-type': 'text/html' } }),
  });
  const search = Bun.serve({
    port: 0,
    fetch: async () => Response.json({ results: [{ title: 'SEARCH_HIT_42', url: 'http://x', snippet: 's' }] }),
  });
  const mcp = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { id?: unknown; method?: string; params?: { arguments?: { text?: string } } };
      const { id, method } = body;
      if (method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: { tools: [{ name: 'echo', description: 'echo back text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] },
        });
      }
      if (method === 'tools/call') {
        const text = body.params?.arguments?.text ?? '';
        return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `ECHO:${text}` }] } });
      }
      return Response.json({ jsonrpc: '2.0', id, result: {} });
    },
  });
  return { web, search, mcp, stop: () => { web.stop(); search.stop(); mcp.stop(); } };
}

function dynamicCases(ports: { web: number; search: number; mcp: number }): CaseDef[] {
  return [
    {
      name: 'tool/web_fetch (真 fetch 本地页 → 抽正文)',
      args: () => ['-p', `Use the web_fetch tool to fetch http://localhost:${ports.web}/ then reply with the page's text content.`, '--no-memory'],
      assert: (r) => (has(r.out, 'WEBFETCH_OK') ? null : '未取回网页正文'),
    },
    {
      name: 'tool/web_search (注入后端)',
      args: () => ['-p', 'Use the web_search tool to search for "anything" and reply with the title of the first result.', '--no-memory', '--search-url', `http://localhost:${ports.search}/search`],
      assert: (r) => (has(r.out, 'SEARCH_HIT_42') ? null : '未返回搜索结果标题'),
    },
    {
      name: 'tool/notebook_edit (改 .ipynb cell)',
      setup: (d) =>
        writeFileSync(
          join(d, 'nb.ipynb'),
          JSON.stringify({ cells: [{ cell_type: 'code', source: 'old', id: 'c1', metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
        ),
      args: (d) => ['-p', `Use the notebook_edit tool to replace cell c1 in ${join(d, 'nb.ipynb')} with new_source exactly: NOTEBOOK_OK`, '--no-memory'],
      assert: (r) => {
        try {
          return JSON.stringify(JSON.parse(readFileSync(join(r.dir, 'nb.ipynb'), 'utf8'))).includes('NOTEBOOK_OK') ? null : 'cell 未更新';
        } catch (e) {
          return `读 ipynb 失败: ${String(e)}`;
        }
      },
    },
    {
      name: 'skill/use (--skills + Skill 工具)',
      setup: (d) => {
        const sd = join(d, 'skills', 'marker');
        mkdirSync(sd, { recursive: true });
        writeFileSync(
          join(sd, 'SKILL.md'),
          `---\nname: marker\ndescription: writes a marker file when invoked\n---\nWhen invoked, immediately use the write_file tool to create a file named skill-out.txt (in the current working directory) with content exactly: SKILL_RAN\n`,
        );
      },
      args: (d) => ['-p', 'Invoke the "marker" skill via the Skill tool, then carry out its instructions exactly.', '--no-memory', '--skills', join(d, 'skills')],
      assert: (r) =>
        existsSync(join(r.dir, 'skill-out.txt')) && readFileSync(join(r.dir, 'skill-out.txt'), 'utf8').includes('SKILL_RAN') ? null : 'skill 未执行其指令',
    },
    {
      name: 'mcp/call (http JSON-RPC server → echo)',
      setup: (d) => writeFileSync(join(d, 'mcp.json'), JSON.stringify({ mcpServers: { echo: { type: 'http', url: `http://localhost:${ports.mcp}/rpc` } } })),
      args: (d) => ['-p', 'Use the mcp__echo__echo tool with text set to "MCP_PING" and report exactly what it returns.', '--no-memory', '--mcp', join(d, 'mcp.json')],
      assert: (r) => (has(r.out, 'MCP_PING') ? null : 'MCP 工具未回显'),
    },
    {
      name: 'hook/block (PreToolUse 拦 bash)',
      setup: (d) => writeFileSync(join(d, 'hooks.json'), JSON.stringify({ PreToolUse: [{ matcher: 'bash', command: 'exit 2' }] })),
      args: (d) => ['-p', 'Use the bash tool to run exactly: echo SHOULD_NOT > blocked.txt', '--no-memory', '--hooks', join(d, 'hooks.json')],
      assert: (r) => (!existsSync(join(r.dir, 'blocked.txt')) ? null : 'bash 未被 hook 拦截(文件被写出)'),
    },
    {
      name: 'thinking/on (--thinking 不破坏回环)',
      args: () => ['-p', 'Think briefly, then reply with exactly this token and nothing else: THINK_OK', '--no-memory', '--thinking'],
      assert: (r) => (has(r.out, 'THINK_OK') ? null : 'thinking 模式未正常作答'),
    },
  ];
}

async function run(): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string; tools: string[] }> = [];
  let memoryDir = '';

  const fixtures = startFixtures();
  const allCases: CaseDef[] = [
    ...cases,
    ...dynamicCases({ web: Number(fixtures.web.port), search: Number(fixtures.search.port), mcp: Number(fixtures.mcp.port) }),
  ];

  for (const c of allCases) {
    const dir = mkdtempSync(join(tmpdir(), 'fxc-real-'));
    try {
      c.setup?.(dir);
      const r = await spawnCli(dir, c.args(dir));
      const fail = c.assert({ ...r, dir });
      results.push({ name: c.name, ok: fail === null, detail: fail ?? 'PASS', tools: toolsUsed(r.out) });
      if (c.name.startsWith('auto-memory/extract') && fail === null) {
        // 保留该 dir 用于 recall 验证(复制 memory 到新 dir 跑第二轮)
        memoryDir = dir;
      }
    } catch (e) {
      results.push({ name: c.name, ok: false, detail: String(e), tools: [] });
    } finally {
      if (dir !== memoryDir) rmSync(dir, { recursive: true, force: true });
    }
  }

  // recall:在带记忆的 dir 上问颜色,期望命中 teal(召回注入 system-reminder)
  if (memoryDir) {
    try {
      // 注意:**不能** --no-memory —— 那会关掉 auto-recall。memory 默认开 → 召回该 dir 的记忆注入。
      const r = await spawnCli(memoryDir, ['-p', 'Based ONLY on your injected memory (do not use file tools), what is my favorite color? Answer in one word.']);
      const ok = has(r.out, 'teal');
      results.push({ name: 'auto-memory/recall (二轮召回)', ok, detail: ok ? 'PASS' : '未召回 teal', tools: toolsUsed(r.out) });
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  }

  // 报告
  console.log('\n================ 真 CLI e2e 结果 ================');
  let fails = 0;
  for (const r of results) {
    const tag = r.ok ? '✅ PASS' : '❌ FAIL';
    if (!r.ok) fails++;
    const tools = r.tools.length ? `  [tools: ${r.tools.join(',')}]` : '';
    console.log(`${tag}  ${r.name}${tools}${r.ok ? '' : '  —— ' + r.detail}`);
  }
  console.log('================================================');
  console.log(`${results.length - fails}/${results.length} 通过`);
  fixtures.stop();
  process.exit(fails);
}

await run();
