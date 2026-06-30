/**
 * CLI 形态补验证用例(「运行时 + CLI + 真实 IO」同包形态)。
 *
 * 覆盖 cli/io.ts(NodeSandboxFs 全方法 + NodeTerminal 真 sh)与 cli/main.ts 的
 * 未覆盖分支(parseArgs 全 flag / buildContext demo·无 key·override / runTurn 渲染 /
 * runCli help·version·-p override·无 key 退 1)。
 *
 * 全程真实 IO:用 node:os.tmpdir + mkdtempSync 开真临时目录,跑真 `sh -c`,不打网络
 * (provider 用 stub override / --demo 内置 echo)。Boundary: 仅 core 相对 import + node:。
 */
import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSandboxFs, NodeTerminal } from '../src/cli/io';
import { parseArgs, buildContext, runTurn, runCli } from '../src/cli/main';
import { DEFAULT_MAIN_MAX_TURNS } from '../src/cli/host-context';
import type { DirEnt } from '../src/inject/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── temp scaffolding ──────────────────────────────────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), 'forgeax-cli-cases-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function textProvider(text: string): LLMProvider {
  return {
    api: 'stub',
    async *stream(): AsyncIterable<ProviderStreamEvent> {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

// ─── NodeSandboxFs — real temp-dir IO, every method ────────────────────────────

describe('NodeSandboxFs — sync text/dir/stat (real temp dir)', () => {
  const fs = new NodeSandboxFs();

  test('writeTextSync + readTextSync round-trip', () => {
    const p = join(ROOT, 'sync.txt');
    fs.writeTextSync(p, 'hello-sync');
    expect(fs.readTextSync(p)).toBe('hello-sync');
  });

  test('existsSync true/false', () => {
    const p = join(ROOT, 'exists.txt');
    expect(fs.existsSync(p)).toBe(false);
    fs.writeTextSync(p, 'x');
    expect(fs.existsSync(p)).toBe(true);
  });

  test('mkdirSync recursive then statSync isDir', () => {
    const dir = join(ROOT, 'a', 'b', 'c');
    fs.mkdirSync(dir, { recursive: true });
    expect(fs.existsSync(dir)).toBe(true);
    const st = fs.statSync(dir);
    expect(st.isDir).toBe(true);
    expect(st.isFile).toBe(false);
  });

  test('mkdirSync default (non-recursive) opts undefined path', () => {
    const dir = join(ROOT, 'plain-dir');
    fs.mkdirSync(dir); // opts omitted → recursive defaults false
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('statSync on a file reports isFile + size + mtime', () => {
    const p = join(ROOT, 'stat.txt');
    fs.writeTextSync(p, 'abcde');
    const st = fs.statSync(p);
    expect(st.isFile).toBe(true);
    expect(st.isDir).toBe(false);
    expect(st.size).toBe(5);
    expect(typeof st.mtime).toBe('number');
  });

  test('renameSync moves a file', () => {
    const from = join(ROOT, 'from.txt');
    const to = join(ROOT, 'to.txt');
    fs.writeTextSync(from, 'movable');
    fs.renameSync(from, to);
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readTextSync(to)).toBe('movable');
  });

  test('unlinkSync deletes a file', () => {
    const p = join(ROOT, 'doomed.txt');
    fs.writeTextSync(p, 'x');
    fs.unlinkSync(p);
    expect(fs.existsSync(p)).toBe(false);
  });

  test('readdirSync names only (default opts)', () => {
    const dir = join(ROOT, 'listdir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeTextSync(join(dir, 'one.txt'), '1');
    fs.writeTextSync(join(dir, 'two.txt'), '2');
    const names = fs.readdirSync(dir) as string[];
    expect(names.sort()).toEqual(['one.txt', 'two.txt']);
  });

  test('readdirSync withFileTypes returns DirEnt with file/dir flags', () => {
    const dir = join(ROOT, 'listdir2');
    fs.mkdirSync(join(dir, 'sub'), { recursive: true });
    fs.writeTextSync(join(dir, 'file.txt'), 'f');
    const ents = fs.readdirSync(dir, { withFileTypes: true }) as DirEnt[];
    const byName = Object.fromEntries(ents.map((e) => [e.name, e]));
    expect(byName['file.txt'].isFile).toBe(true);
    expect(byName['file.txt'].isDir).toBe(false);
    expect(byName['sub'].isDir).toBe(true);
    expect(byName['sub'].isSymlink).toBe(false);
  });
});

describe('NodeSandboxFs — async text/bytes (real temp dir)', () => {
  const fs = new NodeSandboxFs();

  test('writeText + readText round-trip', async () => {
    const p = join(ROOT, 'async.txt');
    await fs.writeText(p, 'hello-async');
    expect(await fs.readText(p)).toBe('hello-async');
  });

  test('writeBytes + readBytes whole file', async () => {
    const p = join(ROOT, 'bytes.bin');
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await fs.writeBytes(p, data);
    const got = await fs.readBytes(p);
    expect(Array.from(got)).toEqual([1, 2, 3, 4, 5]);
  });

  test('readBytes with offset only', async () => {
    const p = join(ROOT, 'bytes2.bin');
    await fs.writeBytes(p, new Uint8Array([10, 20, 30, 40]));
    const got = await fs.readBytes(p, 2);
    expect(Array.from(got)).toEqual([30, 40]);
  });

  test('readBytes with offset + limit', async () => {
    const p = join(ROOT, 'bytes3.bin');
    await fs.writeBytes(p, new Uint8Array([10, 20, 30, 40, 50]));
    const got = await fs.readBytes(p, 1, 2);
    expect(Array.from(got)).toEqual([20, 30]);
  });

  test('writeStream + readStream round-trip', async () => {
    const p = join(ROOT, 'stream.bin');
    const w = fs.writeStream(p).getWriter();
    await w.write(new TextEncoder().encode('CLI_STREAM_OK'));
    await w.close();
    const reader = fs.readStream(p).getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toBe('CLI_STREAM_OK');
  });
});

// ─── NodeTerminal — real child_process(sh) ─────────────────────────────────────

describe('NodeTerminal — real sh execution', () => {
  const term = new NodeTerminal();

  test('run echo: exitCode 0 + stdout captured', async () => {
    const r = await term.run('sh', ['-c', 'echo hi']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
    expect(typeof r.durationMs).toBe('number');
  });

  test('run failing command: exitCode ≠ 0', async () => {
    const r = await term.run('sh', ['-c', 'exit 3']);
    expect(r.exitCode).toBe(3);
  });

  test('run captures stderr', async () => {
    const r = await term.run('sh', ['-c', 'echo oops 1>&2']);
    expect(r.stderr.trim()).toBe('oops');
  });

  test('run honours cwd opt', async () => {
    const r = await term.run('sh', ['-c', 'pwd'], { cwd: ROOT });
    // macOS tmp paths may resolve via /private symlink; assert suffix match.
    expect(r.stdout.trim().endsWith(ROOT) || ROOT.endsWith(r.stdout.trim())).toBe(true);
  });

  test('run merges env opt over process.env', async () => {
    const r = await term.run('sh', ['-c', 'echo $FORGEAX_TEST_VAR'], { env: { FORGEAX_TEST_VAR: 'zz' } });
    expect(r.stdout.trim()).toBe('zz');
  });

  test('run forwards stdin', async () => {
    const r = await term.run('sh', ['-c', 'cat'], { stdin: 'piped-in' });
    expect(r.stdout).toBe('piped-in');
  });

  test('run on a nonexistent binary → error path exitCode 1', async () => {
    const r = await term.run('forgeax-nonexistent-binary-xyz', []);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test('stream yields a stdout chunk', async () => {
    const chunks: Array<{ stream: string; data: string }> = [];
    for await (const c of term.stream('sh', ['-c', 'echo streamed'])) chunks.push(c);
    expect(chunks.some((c) => c.stream === 'stdout' && c.data.includes('streamed'))).toBe(true);
  });

  test('stream yields a stderr chunk', async () => {
    const chunks: Array<{ stream: string; data: string }> = [];
    for await (const c of term.stream('sh', ['-c', 'echo e 1>&2'])) chunks.push(c);
    expect(chunks.some((c) => c.stream === 'stderr' && c.data.includes('e'))).toBe(true);
  });

  test('runBackground returns a tracked TaskHandle', async () => {
    const h = await term.runBackground('sh', ['-c', 'sleep 0.05']);
    expect(h.id).toMatch(/^task-/);
    expect(h.agentId).toBe('cli');
    expect(h.cmd).toContain('sleep');
    expect(term.list('cli').some((t) => t.id === h.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 120)); // 自然结束后从 list 移除
    expect(term.list('cli').some((t) => t.id === h.id)).toBe(false);
  });

  test('kill/killAll terminate tracked tasks', async () => {
    const h = await term.runBackground('sh', ['-c', 'sleep 5']);
    expect(term.list('cli').some((t) => t.id === h.id)).toBe(true);
    await term.kill(h.id, 'SIGKILL');
    expect(term.list('cli').some((t) => t.id === h.id)).toBe(false);
    const h2 = await term.runBackground('sh', ['-c', 'sleep 5']);
    expect(term.list('cli').length).toBeGreaterThan(0);
    await term.killAll('cli');
    expect(term.list('cli').length).toBe(0);
    void h2;
  });

  test('readStream / writeStream round-trip', async () => {
    const fs = new NodeSandboxFs();
    const dir = mkdtempSync(join(tmpdir(), 'fxc-iostream-'));
    const p = join(dir, 'stream.txt');
    const ws = fs.writeStream(p);
    const w = ws.getWriter();
    await w.write(new TextEncoder().encode('STREAM_RT'));
    await w.close();
    const rs = fs.readStream(p);
    const reader = rs.getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toBe('STREAM_RT');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── parseArgs — every flag ────────────────────────────────────────────────────

describe('parseArgs — all flags & positional', () => {
  test('-p sets prompt', () => {
    expect(parseArgs(['-p', 'hello']).prompt).toBe('hello');
  });
  test('--print is alias of -p', () => {
    expect(parseArgs(['--print', 'p2']).prompt).toBe('p2');
  });
  test('--model overrides model', () => {
    expect(parseArgs(['--model', 'gemini-x']).model).toBe('gemini-x');
  });
  test('--demo sets demo true', () => {
    expect(parseArgs(['--demo']).demo).toBe(true);
  });
  test('--memory sets memoryDir', () => {
    expect(parseArgs(['--memory', '/tmp/mem']).memoryDir).toBe('/tmp/mem');
  });
  test('--no-memory disables memoryDir', () => {
    expect(parseArgs(['--no-memory']).memoryDir).toBeUndefined();
  });
  test('-h / --help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });
  test('-v / --version', () => {
    expect(parseArgs(['-v']).version).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
  });
  test('positional arg becomes prompt when no -p', () => {
    expect(parseArgs(['just a prompt']).prompt).toBe('just a prompt');
  });
  test('positional is ignored when -p already set', () => {
    const a = parseArgs(['-p', 'first', 'second']);
    expect(a.prompt).toBe('first');
  });
  test('default memoryDir derives from cwd when no env override', () => {
    const saved = process.env.FORGEAX_MEMORY_DIR;
    delete process.env.FORGEAX_MEMORY_DIR;
    try {
      expect(parseArgs([]).memoryDir).toBe(`${process.cwd()}/.forgeax/memory`);
    } finally {
      if (saved != null) process.env.FORGEAX_MEMORY_DIR = saved;
    }
  });
});

// ─── buildContext — demo / providerOverride / no-key throw ─────────────────────

describe('buildContext — provider selection paths', () => {
  const baseArgs = { model: 'm', demo: false, help: false, version: false } as const;

  test('--demo path builds a demo provider (no key needed)', () => {
    const ctx = buildContext({ ...baseArgs, demo: true });
    expect(ctx.provider.api).toBe('demo');
    expect(ctx.toolContext?.cwd).toBe(process.cwd());
  });

  test('providerOverride wins even without --demo', () => {
    const ctx = buildContext({ ...baseArgs }, textProvider('x'));
    expect(ctx.provider.api).toBe('stub');
  });

  test('no API key + no demo + no override → throws guidance', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => buildContext({ ...baseArgs })).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved != null) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('with API key + no demo → resolves a real anthropic provider', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    try {
      const ctx = buildContext({ ...baseArgs });
      // resolveProvider(pickApi('m')='anthropic-messages') — provider constructed, no network.
      expect(ctx.provider).toBeDefined();
      expect(ctx.config.model).toBe('m');
    } finally {
      if (saved != null) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test('config carries leading text + builtin tools + maxTurns', () => {
    const ctx = buildContext({ ...baseArgs, demo: true });
    expect(ctx.config.maxTurns).toBe(DEFAULT_MAIN_MAX_TURNS);
    expect(Array.isArray(ctx.config.tools)).toBe(true);
    expect(typeof ctx.config.leadingSystemText).toBe('string');
  });
});

// ─── runTurn — renders assistant text to out ───────────────────────────────────

describe('runTurn — renders stub assistant output', () => {
  test('out receives assistant text, reason completed', async () => {
    const ctx = buildContext({ model: 'm', demo: false, help: false, version: false }, textProvider('RUN_TURN_OK'));
    let out = '';
    const reason = await runTurn(ctx, 'hi', (s) => (out += s));
    expect(out).toContain('RUN_TURN_OK');
    expect(reason).toBe('completed');
  });
});

// ─── runCli — entry returns codes ──────────────────────────────────────────────

describe('runCli — return codes', () => {
  test('--help returns 0', async () => {
    expect(await runCli(['--help'])).toBe(0);
  });
  test('--version returns 0', async () => {
    expect(await runCli(['--version'])).toBe(0);
  });
  test('-p with provider override + --no-memory returns 0', async () => {
    expect(await runCli(['-p', 'hi', '--no-memory'], textProvider('ok'))).toBe(0);
  });
  test('-p with provider override + memory dir runs (auto-memory wired)', async () => {
    const memDir = join(ROOT, 'cli-mem');
    expect(await runCli(['-p', 'hi', '--memory', memDir], textProvider('ok'))).toBe(0);
  });
  test('--demo -p runs the built-in echo provider end-to-end (no key, no network)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // prove demo needs no key
    try {
      // exercises demoProvider().stream — yields "forgeax-core(demo) 收到: ...".
      expect(await runCli(['--demo', '-p', 'ping', '--no-memory'])).toBe(0);
    } finally {
      if (saved != null) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
  test('--demo buildContext + runTurn echoes the prompt back', async () => {
    const ctx = buildContext({ model: 'm', demo: true, help: false, version: false });
    let out = '';
    const reason = await runTurn(ctx, 'echo-me', (s) => (out += s));
    expect(out).toContain('forgeax-core(demo) 收到');
    expect(out).toContain('echo-me');
    expect(reason).toBe('completed');
  });
  test('no API key + no demo + no override → exit 1 with guidance to stderr', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await runCli(['-p', 'hi'])).toBe(1);
    } finally {
      if (saved != null) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
  // touch ROOT helpers so unused-import lints stay quiet & confirm scaffolding.
  test('temp ROOT exists for the suite', () => {
    expect(existsSync(ROOT)).toBe(true);
    // sanity: a file written earlier is readable through node:fs directly too.
    const p = join(ROOT, 'direct.txt');
    new NodeSandboxFs().writeTextSync(p, 'direct');
    expect(readFileSync(p, 'utf8')).toBe('direct');
  });
});
