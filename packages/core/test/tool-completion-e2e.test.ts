/**
 * 工具补齐批次(012)端到端验证 —— 不是单元桩,而是让 6 个新工具经**真实装配路径**
 * (`assembleCapabilities()` / `makeTaskTool()` 的真实子 loop)被 agent 用到。
 *
 * 覆盖:
 *   007 后台 bash 三件套:assemble 注入 backgroundSpawn → bash(run_in_background)
 *        起后台命令 → bash_output 读增量 → kill_shell 终止 → disposers 清理无残留。
 *   008 AskUserQuestion:assemble 注入 askQuestion → 工具经 ctx 转发结构化 questions,
 *        stub host 收到并回灌 answers。
 *   009 notebook_read:经装配的工具读真实 fixture .ipynb(node-fs SandboxFs)。
 *   010 StructuredOutput:子 agent 经 makeTaskTool 真实子 loop,先提交非法 payload
 *        被拒(isError + 逐条错误)→ 再提交合法 payload 成为 structured 返回值。
 *   011 多模态 read_file:经装配的工具读真实 fixture PNG → 产出 image content block。
 *   003 LSP:本机无 typescript-language-server → 走优雅降级端到端路径(isError 结果,
 *        不崩 loop)。若有真 server 再补真用例(见文件尾 describe.skip)。
 *
 * 这些工具的 IO 全部经注入接缝(SandboxFs / backgroundSpawn / askQuestion),core 不打真 IO。
 * 风格对齐 test/builtin-tools.test.ts + test/subagent-background-worktree.test.ts。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleCapabilities } from '../src/runtime/assemble';
import { EventBus } from '../src/events/event-bus';
import type { AgentTool, ToolContext } from '../src/capability/types';
import type {
  SandboxFs,
  DirEnt,
  StatResult,
  Chunk,
  RunOpts,
  AskQuestionItem,
  AskQuestionAnswer,
} from '../src/inject/types';
import type { BackgroundProcess } from '../src/capability/builtin-tools/shell-registry';
import { makeTaskTool, type SubagentResult } from '../src/agent/subagent';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── node-fs 背靠的真实 SandboxFs(只实现 e2e 用到的方法)──────────────────────
//
// notebook_read / read_file 走 readText / readBytes;其余方法 e2e 不触发 → throw。
class NodeFsSandbox implements SandboxFs {
  readTextSync(p: string): string {
    return readFileSync(p, 'utf8');
  }
  writeTextSync(p: string, c: string): void {
    writeFileSync(p, c);
  }
  mkdirSync(): void { }
  existsSync(p: string): boolean {
    return existsSync(p);
  }
  unlinkSync(p: string): void {
    rmSync(p, { force: true });
  }
  renameSync(): void {
    throw new Error('not used');
  }
  statSync(p: string): StatResult {
    const buf = readFileSync(p);
    return { isFile: true, isDir: false, size: buf.length, mtime: 0 };
  }
  readdirSync(): string[] | DirEnt[] {
    return [];
  }
  async readText(p: string): Promise<string> {
    return readFileSync(p, 'utf8');
  }
  async writeText(p: string, c: string): Promise<void> {
    writeFileSync(p, c);
  }
  async readBytes(p: string, offset?: number, limit?: number): Promise<Uint8Array> {
    const buf = readFileSync(p);
    if (offset === undefined && limit === undefined) return new Uint8Array(buf);
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : buf.length;
    return new Uint8Array(buf.subarray(start, end));
  }
  async writeBytes(): Promise<void> {
    throw new Error('not used');
  }
  readStream(): ReadableStream<Uint8Array> {
    throw new Error('not used');
  }
  writeStream(): WritableStream<Uint8Array> {
    throw new Error('not used');
  }
}

// ─── fixtures(临时目录;afterAll 清理)────────────────────────────────────────

let FIX_DIR: string;
let NB_PATH: string;
let PNG_PATH: string;

/** 最小合法 1x1 PNG(magic-bytes 命中 image/png)。 */
const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082';

beforeAll(() => {
  FIX_DIR = mkdtempSync(join(tmpdir(), 'forgeax-tool-e2e-'));
  NB_PATH = join(FIX_DIR, 'fixture.ipynb');
  PNG_PATH = join(FIX_DIR, 'pixel.png');

  const notebook = {
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'intro'], id: 'c1' },
      {
        cell_type: 'code',
        source: 'print("hi")\n',
        id: 'c2',
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }],
        execution_count: 1,
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
  writeFileSync(NB_PATH, JSON.stringify(notebook, null, 1));
  writeFileSync(PNG_PATH, Buffer.from(PNG_HEX, 'hex'));
});

afterAll(() => {
  try {
    rmSync(FIX_DIR, { recursive: true, force: true });
  } catch {
    /* 吞错:临时目录残留无害 */
  }
});

// ─── helpers ───────────────────────────────────────────────────────────────

function findTool(tools: AgentTool[], name: string): AgentTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool "${name}" not assembled — present: ${tools.map((x) => x.name).join(', ')}`);
  return t;
}

/** scripted provider:按轮吐预置事件(对齐 subagent-background-worktree.test.ts)。 */
function scripted(turns: ProviderStreamEvent[][]): LLMProvider {
  let n = 0;
  return {
    api: 'stub',
    async *stream() {
      const t = turns[Math.min(n, turns.length - 1)];
      n++;
      for (const e of t) yield e;
    },
  };
}
function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}
function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 装配面断言:6 个新工具都经 assembleCapabilities 出现在 effective tools 里
// ════════════════════════════════════════════════════════════════════════════

describe('012 装配面 e2e — 新工具经 assembleCapabilities 真实出现', () => {
  test('effective tools 含 007/008/009/003 的工具;010 主集缺席(subagent-only)', async () => {
    const bus = new EventBus();
    const spawned: string[] = [];
    const { tools, shellRegistry, askQuestion, disposers } = await assembleCapabilities({
      bus,
      backgroundSpawn: (cmd, args, _opts, _onChunk): BackgroundProcess => {
        spawned.push([cmd, ...args].join(' '));
        return { kill: () => { } };
      },
      askQuestion: async () => [],
    });
    const names = tools.map((t) => t.name);

    // 007 后台 bash 三件套(bash 自身 + bash_output + kill_shell)。
    expect(names).toContain('bash');
    expect(names).toContain('bash_output');
    expect(names).toContain('kill_shell');
    // 008 结构化提问。
    expect(names).toContain('AskUserQuestion');
    // 009 notebook 读写。
    expect(names).toContain('notebook_read');
    expect(names).toContain('notebook_edit');
    // 011 多模态读(改的是既有 read_file,装配名不变)。
    expect(names).toContain('read_file');
    // 003 LSP。
    expect(names).toContain('lsp');
    // 010 StructuredOutput 是 subagent-only:主 agent 通用工具集里**不该**出现。
    expect(names).not.toContain('StructuredOutput');

    // 007/008 的注入接缝经 assemble 透出。
    expect(shellRegistry).toBeDefined();
    expect(askQuestion).toBeDefined();

    for (const d of disposers) await d();
    expect(spawned.length).toBe(0); // 仅断言注入路径就绪,未实际 spawn
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 007 后台 bash 三件套:assemble 真实装配 → spawn → 读增量 → kill → 清理无残留
// ════════════════════════════════════════════════════════════════════════════

describe('007 后台 bash 三件套 e2e(经 assemble 注入 backgroundSpawn)', () => {
  test('bash run_in_background → bash_output 读增量 → kill_shell → disposers 清理', async () => {
    const bus = new EventBus();

    // 受控 stub host:记录 spawn,保留 onChunk 以便手动驱动输出/退出;记录 kill 信号。
    const procs: Array<{ shellId?: string; killed: 'SIGTERM' | 'SIGKILL' | null }> = [];
    // 用对象持有(而非裸 let),避免 TS 把闭包里写入的回调在调用点窄化为 null。
    const hostCb: { onChunk?: (c: Chunk) => void } = {};
    const backgroundSpawn = (
      _cmd: string,
      _args: string[],
      _opts: RunOpts | undefined,
      onChunk: (c: Chunk) => void,
    ): BackgroundProcess => {
      hostCb.onChunk = onChunk;
      const rec = { killed: null as 'SIGTERM' | 'SIGKILL' | null };
      procs.push(rec);
      return {
        pid: 4242,
        kill: (sig) => {
          rec.killed = sig ?? 'SIGTERM';
        },
      };
    };

    const { tools, shellRegistry, disposers } = await assembleCapabilities({ bus, backgroundSpawn });
    expect(shellRegistry).toBeDefined();

    // host 把 shellRegistry 挂到 toolContext(assemble 约定)。
    const ctx: ToolContext = { signal: new AbortController().signal, shellRegistry };

    const bash = findTool(tools, 'bash');
    const bashOutput = findTool(tools, 'bash_output');
    const killShell = findTool(tools, 'kill_shell');

    // (1) 起后台命令 → 立即拿 shell_id(未阻塞)。
    const started = await bash.call(
      { command: 'while true; do echo tick; sleep 1; done', run_in_background: true },
      ctx,
    );
    const shellId = (started.data as { shellId?: string }).shellId as string;
    expect(typeof shellId).toBe('string');
    expect((started.data as { background?: boolean }).background).toBe(true);

    // host 异步回灌一些 stdout(模拟进程输出)。
    hostCb.onChunk?.({ stream: 'stdout', data: 'tick\n' });
    hostCb.onChunk?.({ stream: 'stdout', data: 'tick\n' });

    // (2) bash_output 读增量 —— 第一次拿到累积输出。
    const read1 = await bashOutput.call({ shell_id: shellId }, ctx);
    expect((read1.data as { status: string }).status).toBe('running');
    expect((read1.data as { stdout: string }).stdout).toBe('tick\ntick\n');

    // 再来一段输出 → 第二次只读到**增量**(游标语义)。
    hostCb.onChunk?.({ stream: 'stdout', data: 'tick\n' });
    const read2 = await bashOutput.call({ shell_id: shellId }, ctx);
    expect((read2.data as { stdout: string }).stdout).toBe('tick\n');

    // filter 正则:只保留匹配行(此处构造 stderr 验证过滤)。
    hostCb.onChunk?.({ stream: 'stderr', data: 'WARN x\nINFO y\nWARN z\n' });
    const read3 = await bashOutput.call({ shell_id: shellId, filter: 'WARN' }, ctx);
    expect((read3.data as { stderr: string }).stderr).toBe('WARN x\nWARN z');

    // (3) kill_shell 终止 → host 收到 kill 信号,状态转 killed。
    const killed = await killShell.call({ shell_id: shellId }, ctx);
    expect((killed.data as { found: boolean }).found).toBe(true);
    expect(procs[0].killed).toBe('SIGTERM');

    // kill 后 bash_output 仍可读到终态。
    const readAfter = await bashOutput.call({ shell_id: shellId }, ctx);
    expect((readAfter.data as { status: string }).status).toBe('killed');

    // (4) disposers 清理:仍残留的注册项会被 killAll 清空(此处已 killed,断言 list 清空)。
    expect(shellRegistry!.list().length).toBeGreaterThanOrEqual(1);
    for (const d of disposers) await d();
    expect(shellRegistry!.list().length).toBe(0); // 无残留
  });

  test('未注入 backgroundSpawn ⇒ bash(run_in_background) 优雅 loud throw(契约违反可见)', async () => {
    const bus = new EventBus();
    const { tools, shellRegistry } = await assembleCapabilities({ bus }); // 不注入 backgroundSpawn
    expect(shellRegistry).toBeUndefined();
    const bash = findTool(tools, 'bash');
    await expect(
      bash.call({ command: 'echo hi', run_in_background: true }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/shellRegistry is missing/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 008 AskUserQuestion:assemble 注入 askQuestion → 工具转发结构化问题 → 回灌答案
// ════════════════════════════════════════════════════════════════════════════

describe('008 AskUserQuestion e2e(经 assemble 注入 askQuestion)', () => {
  test('工具经 ctx.askQuestion 转发结构化 questions,stub host 收到并回灌 answers', async () => {
    const bus = new EventBus();

    // 受控 stub host:记录收到的结构化 questions,按约定回灌 answers(与 questions 同序)。
    let seen: readonly AskQuestionItem[] | null = null;
    const askQuestion = async (questions: readonly AskQuestionItem[]): Promise<AskQuestionAnswer[]> => {
      seen = questions;
      // 第 1 问单选 "React";第 2 问走 Other 自填。
      return [
        { selected: ['React'] },
        { selected: ['Custom build'], other: 'esbuild + bun' },
      ];
    };

    const { tools, askQuestion: exposed } = await assembleCapabilities({ bus, askQuestion });
    expect(exposed).toBeDefined();

    const ask = findTool(tools, 'AskUserQuestion');
    // host 把 askQuestion 挂到 toolContext(assemble 约定)。
    // ToolContext.askQuestion 用结构等价的 readonly 内层形;stub 与其等价,显式标注字段类型。
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      askQuestion: askQuestion as ToolContext['askQuestion'],
    };

    const out = await ask.call(
      {
        questions: [
          {
            question: 'Which framework?',
            header: 'Framework',
            options: [{ label: 'React' }, { label: 'Vue', description: 'progressive' }],
          },
          {
            question: 'Build tool?',
            header: 'Build',
            options: [{ label: 'Vite' }, { label: 'Custom build' }],
            multiSelect: true,
          },
        ],
      },
      ctx,
    );

    // host 确实收到结构化 questions(含 header / options / multiSelect)。
    expect(seen).not.toBeNull();
    expect(seen!.length).toBe(2);
    expect(seen![0].header).toBe('Framework');
    expect(seen![0].options.map((o) => o.label)).toEqual(['React', 'Vue']);
    expect(seen![1].multiSelect).toBe(true);

    // answers 回灌成工具结果(与 questions 同序;Other 文本保留)。
    const data = out.data as {
      answers: Array<{ question: string; header: string; selected: string[]; other?: string }>;
      unsupported?: boolean;
    };
    expect(data.unsupported).toBeUndefined();
    expect(data.answers).toHaveLength(2);
    expect(data.answers[0].selected).toEqual(['React']);
    expect(data.answers[1].selected).toEqual(['Custom build']);
    expect(data.answers[1].other).toBe('esbuild + bun');
  });

  test('未注入 askQuestion ⇒ 优雅降级(unsupported,不断流)', async () => {
    const bus = new EventBus();
    const { tools, askQuestion } = await assembleCapabilities({ bus }); // 不注入
    expect(askQuestion).toBeUndefined();
    const ask = findTool(tools, 'AskUserQuestion');
    const out = await ask.call(
      { questions: [{ question: 'q?', header: 'H', options: [{ label: 'A' }] }] },
      { signal: new AbortController().signal }, // ctx 无 askQuestion
    );
    const data = out.data as { unsupported?: boolean; answers: unknown[] };
    expect(data.unsupported).toBe(true);
    expect(data.answers).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 009 notebook_read:经装配工具读真实 fixture .ipynb
// ════════════════════════════════════════════════════════════════════════════

describe('009 notebook_read e2e(经 assemble 装配 + 真实 fixture .ipynb)', () => {
  test('读 fixture notebook → cells + outputs(node-fs SandboxFs)', async () => {
    const bus = new EventBus();
    const { tools } = await assembleCapabilities({ bus });
    const nbRead = findTool(tools, 'notebook_read');
    const ctx: ToolContext = { signal: new AbortController().signal, sandboxFs: new NodeFsSandbox() };

    const out = await nbRead.call({ notebook_path: NB_PATH }, ctx);
    const data = out.data as {
      cellCount: number;
      cells: Array<{ id?: string; cell_type: string; source: string; outputs: Array<{ output_type: string; text?: string }> }>;
    };
    expect(data.cellCount).toBe(2);
    expect(data.cells[0].id).toBe('c1');
    expect(data.cells[0].cell_type).toBe('markdown');
    expect(data.cells[0].source).toBe('# Title\nintro'); // 数组 source 已 join
    expect(data.cells[1].cell_type).toBe('code');
    expect(data.cells[1].outputs[0].output_type).toBe('stream');
    expect(data.cells[1].outputs[0].text).toBe('hi\n');

    // mapResult 形状(经真实工厂)。
    const ev = nbRead.mapResult(data as never, 'tu_nb');
    expect((ev.payload as { isError: boolean }).isError).toBe(false);
    expect((ev.payload as { cellCount: number }).cellCount).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 011 多模态 read_file:经装配工具读真实 fixture PNG → image content block
// ════════════════════════════════════════════════════════════════════════════

describe('011 多模态 read_file e2e(经 assemble 装配 + 真实 fixture PNG)', () => {
  test('读 PNG fixture → imageBlocks(base64 image/png),mapResult 透出 image block', async () => {
    const bus = new EventBus();
    const { tools } = await assembleCapabilities({ bus });
    const readFile = findTool(tools, 'read_file');
    const ctx: ToolContext = { signal: new AbortController().signal, sandboxFs: new NodeFsSandbox() };

    const out = await readFile.call({ file_path: PNG_PATH }, ctx);
    const data = out.data as {
      imageBlocks?: Array<{ type: string; source: { type: string; media_type: string; data: string } }>;
      content: string;
    };
    expect(data.imageBlocks).toBeDefined();
    expect(data.imageBlocks).toHaveLength(1);
    const block = data.imageBlocks![0];
    expect(block.type).toBe('image');
    expect(block.source.type).toBe('base64');
    expect(block.source.media_type).toBe('image/png'); // magic-bytes 命中
    // base64 解回应 = 原始 PNG 字节。
    const decoded = Buffer.from(block.source.data, 'base64');
    expect(decoded.equals(Buffer.from(PNG_HEX, 'hex'))).toBe(true);
    expect(data.content).toContain('image content block'); // 人类可读占位

    // mapResult:imageBlocks 透到 tool.result payload(供 loop 组 content 数组)。
    const ev = readFile.mapResult(data as never, 'tu_png');
    expect((ev.payload as { imageBlocks?: unknown[] }).imageBlocks).toBeDefined();
  });

  test('文本文件零回归:read_file 仍走文本路径(无 imageBlocks)', async () => {
    const bus = new EventBus();
    const { tools } = await assembleCapabilities({ bus });
    const readFile = findTool(tools, 'read_file');
    const txtPath = join(FIX_DIR, 'plain.txt');
    writeFileSync(txtPath, 'line1\nline2\nline3');
    const ctx: ToolContext = { signal: new AbortController().signal, sandboxFs: new NodeFsSandbox() };
    const out = await readFile.call({ file_path: txtPath }, ctx);
    const data = out.data as { imageBlocks?: unknown[]; content: string; totalLines: number };
    expect(data.imageBlocks).toBeUndefined();
    expect(data.totalLines).toBe(3);
    expect(data.content).toContain('1\tline1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 010 StructuredOutput:子 agent 经 makeTaskTool 真实子 loop —— 非法重试 → 合法返回
// ════════════════════════════════════════════════════════════════════════════

describe('010 StructuredOutput e2e(经 makeTaskTool 真实子 loop)', () => {
  test('子 agent 给 schema → 非法 payload 被拒(重试)→ 合法 payload 成为 structured 返回值', async () => {
    // 目标 schema:{ verdict: 'pass'|'fail', score: integer } 必填。
    const schema = {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        score: { type: 'integer' },
      },
      required: ['verdict', 'score'],
      additionalProperties: false,
    };

    // 子 loop 三轮脚本:
    //   轮0:提交**非法** StructuredOutput(verdict 非枚举 + score 非整数 + 多余键)→ 工具回灌错误。
    //   轮1:提交**合法** StructuredOutput → onValid 记录为 structured 返回值。
    //   轮2:end_turn 收尾。
    const childProvider = scripted([
      [asstToolUse('s1', 'StructuredOutput', { verdict: 'maybe', score: 3.5, extra: true })],
      [asstToolUse('s2', 'StructuredOutput', { verdict: 'pass', score: 9 })],
      [asstText('done')],
    ]);

    const task = makeTaskTool({
      provider: childProvider,
      model: 'm',
      resolveTools: () => [], // 子工具集仅由 schema 注入 StructuredOutput(010 真实路径)
      schema, // deps.schema 缺省 → 所有 Task 调用都挂 StructuredOutput
    });

    const out = await task.call(
      { prompt: 'judge the work', subagent_type: 'judge' },
      { signal: new AbortController().signal },
    );
    const data = out.data as SubagentResult;

    // 子经 StructuredOutput 提交的**已校验**对象作 structured 返回(父取已校验对象)。
    expect(data.structured).toEqual({ verdict: 'pass', score: 9 });
    expect(data.terminalReason).toBe('completed');
    // 至少跑了 2 个工具调用(非法 1 次 + 合法 1 次)。
    expect(data.toolCalls).toBeGreaterThanOrEqual(2);

    // mapResult 透出 structured 给父。
    const ev = task.mapResult(data, 'tu_task');
    expect((ev.payload as { structured?: unknown }).structured).toEqual({ verdict: 'pass', score: 9 });
  });

  test('无 schema ⇒ 子工具集不含 StructuredOutput(零回归,自由文本返回)', async () => {
    const childProvider = scripted([[asstText('free-form answer')]]);
    const task = makeTaskTool({
      provider: childProvider,
      model: 'm',
      resolveTools: () => [],
      // 不给 schema
    });
    const out = await task.call({ prompt: 'x' }, { signal: new AbortController().signal });
    const data = out.data as SubagentResult;
    expect(data.text).toBe('free-form answer');
    expect(data.structured).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 003 LSP:本机无 typescript-language-server → 端到端优雅降级(isError 结果,不崩)
// ════════════════════════════════════════════════════════════════════════════

describe('003 LSP e2e(无 server → 端到端优雅降级)', () => {
  test('lsp 工具经 assemble 装配;无注入 spawner / 真 server 时降级为 isError 结果(不抛崩)', async () => {
    const bus = new EventBus();
    const { tools } = await assembleCapabilities({ bus });
    const lsp = findTool(tools, 'lsp');

    // 注入一个永远「起不来」的 spawner(模拟本机无 typescript-language-server),
    // 走与「server 缺失」同形的端到端降级路径:call 不抛,返回 isError 结果。
    const failingSpawner = () => {
      throw new Error('spawn typescript-language-server ENOENT');
    };
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      sandboxFs: new NodeFsSandbox(),
      lspSpawner: failingSpawner,
      workspaceRoot: FIX_DIR,
    };

    // 写一个真实 .ts 文件(语言可识别),但 server 起不来 → 降级。
    const tsPath = join(FIX_DIR, 'sample.ts');
    writeFileSync(tsPath, 'export const x = 1;\nexport function f() { return x; }\n');

    const out = await lsp.call(
      { operation: 'documentSymbol', filePath: tsPath },
      ctx,
    );
    const data = out.data as { operation: string; error?: string; result?: unknown };
    // 端到端:不崩 loop,优雅返回 error 字段。
    expect(data.operation).toBe('documentSymbol');
    expect(typeof data.error).toBe('string');
    expect(data.error).toMatch(/typescript-language-server|ENOENT|spawn|server/i);

    // mapResult:error → isError true。
    const ev = lsp.mapResult(data as never, 'tu_lsp');
    expect((ev.payload as { isError: boolean }).isError).toBe(true);
  });

  test('不支持的语言(无配置 server)→ 端到端优雅降级', async () => {
    const bus = new EventBus();
    const { tools } = await assembleCapabilities({ bus });
    const lsp = findTool(tools, 'lsp');
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      sandboxFs: new NodeFsSandbox(),
      workspaceRoot: FIX_DIR,
    };
    const out = await lsp.call(
      { operation: 'hover', filePath: join(FIX_DIR, 'weird.xyzlang'), line: 1, character: 1 },
      ctx,
    );
    const data = out.data as { error?: string };
    expect(typeof data.error).toBe('string'); // unsupported language → error,不崩
  });
});

// 真 server 用例:本机若装了 typescript-language-server 才有意义(否则设计性跳过)。
// 当前 CI / 本机均无 → describe.skip。装上后可手动改成 describe 跑真 documentSymbol。
describe.skip('003 LSP e2e(真 typescript-language-server,本机无 → skip)', () => {
  test('documentSymbol 返回真实符号(需外部 server)', () => {
    // 占位:本机无 typescript-language-server,无法 e2e 真 LSP 往返。
    // 已用上面的「优雅降级」端到端路径替代验证(无 server 时不崩 loop)。
    expect(true).toBe(true);
  });
});