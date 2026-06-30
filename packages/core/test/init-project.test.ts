/**
 * /init 子流程【A 层底层能力】测试(019)。
 *
 * 验证:
 *   - detectExistingAgentsDoc:据 sandboxFs.existsSync 探测既有项目文档(命中优先级 + 兜底)。
 *   - buildInitPrompt:预置 prompt 含目标绝对路径 + 覆盖/补充措辞。
 *   - runInitProject:预置 prompt 驱动一轮隔离子 loop,模型据此调 write_file 把 AGENTS.md 落盘。
 *
 * 用脚本化 provider(对齐 test/subagent.test.ts 风格),离线、可单跑:
 *   bun test packages/core/test/init-project.test.ts
 */
import { test, expect, describe } from 'bun:test';
import { resolve as resolvePath } from 'node:path';
import {
  runInitProject,
  detectExistingAgentsDoc,
  buildInitPrompt,
  AGENTS_DOC_CANDIDATES,
  DEFAULT_AGENTS_DOC,
} from '../src/cli/init-project';
import { buildTool } from '../src/capability/types';
import type { SandboxFs } from '../src/inject/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── 脚本化 provider(同 subagent.test.ts)─────────────────────────────────
function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
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

/** 最小内存 SandboxFs:够 existsSync / writeTextSync / readTextSync 三件事。 */
function memFs(seed: Record<string, string> = {}): SandboxFs & { files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  return {
    files,
    existsSync: (p: string) => p in files,
    readTextSync: (p: string) => files[p] ?? '',
    writeTextSync: (p: string, c: string) => {
      files[p] = c;
    },
    mkdirSync: () => {},
    unlinkSync: (p: string) => {
      delete files[p];
    },
    renameSync: () => {},
    statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 0, mtimeMs: 0 }) as never,
    readdirSync: () => [],
    readText: async (p: string) => files[p] ?? '',
    writeText: async (p: string, c: string) => {
      files[p] = c;
    },
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    readStream: () => new ReadableStream(),
    writeStream: () => new WritableStream(),
  };
}

describe('detectExistingAgentsDoc', () => {
  test('未命中任何候选 → exists:false', () => {
    const fs = memFs();
    const r = detectExistingAgentsDoc(fs, '/proj');
    expect(r.exists).toBe(false);
    expect(r.fileName).toBeUndefined();
  });

  test('命中 AGENTS.md → 返回绝对路径与文件名', () => {
    const root = '/proj';
    const fs = memFs({ [resolvePath(root, 'AGENTS.md')]: '# old' });
    const r = detectExistingAgentsDoc(fs, root);
    expect(r.exists).toBe(true);
    expect(r.fileName).toBe('AGENTS.md');
    expect(r.path).toBe(resolvePath(root, 'AGENTS.md'));
  });

  test('AGENTS.md 优先于 CLAUDE.md(候选顺序)', () => {
    const root = '/proj';
    const fs = memFs({
      [resolvePath(root, 'AGENTS.md')]: '# a',
      [resolvePath(root, 'CLAUDE.md')]: '# c',
    });
    const r = detectExistingAgentsDoc(fs, root);
    expect(r.fileName).toBe(AGENTS_DOC_CANDIDATES[0]);
  });

  test('existsSync 抛错时按未命中兜底', () => {
    const fs = memFs();
    fs.existsSync = () => {
      throw new Error('boom');
    };
    expect(detectExistingAgentsDoc(fs, '/proj').exists).toBe(false);
  });
});

describe('buildInitPrompt', () => {
  const base = { targetPath: '/proj/AGENTS.md', fileName: 'AGENTS.md', projectRoot: '/proj' };

  test('新建:prompt 含目标绝对路径 + 新建措辞', () => {
    const p = buildInitPrompt({ ...base, existing: { exists: false }, force: false });
    expect(p).toContain('/proj/AGENTS.md');
    expect(p).toContain('write_file');
    expect(p).toContain('新建');
  });

  test('已存在 + 未授权:指示保留并增量补充,不整篇覆写', () => {
    const p = buildInitPrompt({
      ...base,
      existing: { exists: true, fileName: 'AGENTS.md', path: '/proj/AGENTS.md' },
      force: false,
    });
    expect(p).toContain('增量补充');
    expect(p).not.toContain('整篇重写');
  });

  test('已存在 + 已授权:指示整篇重写', () => {
    const p = buildInitPrompt({
      ...base,
      existing: { exists: true, fileName: 'AGENTS.md', path: '/proj/AGENTS.md' },
      force: true,
    });
    expect(p).toContain('整篇重写');
  });
});

describe('runInitProject — 预置 prompt 驱动子 loop 写 AGENTS.md', () => {
  // 模型行为:第一轮调 write_file 落盘,第二轮收尾文本。write_file 用注入的 memFs 真写。
  function writeFileToolOn(fs: SandboxFs) {
    return buildTool({
      name: 'write_file',
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      call: async (i: { path: string; content: string }) => {
        fs.writeTextSync(i.path, i.content);
        return { data: { ok: true, path: i.path } };
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
  }

  test('模型经 write_file 把 AGENTS.md 落到项目根;结果回报目标路径与终态', async () => {
    const root = '/proj';
    const target = resolvePath(root, DEFAULT_AGENTS_DOC);
    const fs = memFs();
    const provider = scripted([
      [asstToolUse('w1', 'write_file', { path: target, content: '# Proj\n## 项目结构\n...' })],
      [asstText('已生成 AGENTS.md')],
    ]);
    const r = await runInitProject({
      provider,
      model: 'm',
      tools: [writeFileToolOn(fs)],
      toolContext: { sandboxFs: fs, cwd: root },
      projectRoot: root,
    });

    expect(r.fileName).toBe('AGENTS.md');
    expect(r.targetPath).toBe(target);
    expect(r.existing.exists).toBe(false); // 跑前不存在
    expect(r.subagent.terminalReason).toBe('completed');
    expect(r.subagent.toolCalls).toBe(1);
    // 真落盘:文件已被 write_file 工具写到项目根
    expect(fs.files[target]).toContain('项目结构');
  });

  test('既有文档被探测进 existing(供 B 层覆盖确认决策)', async () => {
    const root = '/proj';
    const target = resolvePath(root, 'AGENTS.md');
    const fs = memFs({ [target]: '# old doc' });
    const provider = scripted([[asstText('保留旧文档并补充完毕')]]);
    const r = await runInitProject({
      provider,
      model: 'm',
      tools: [writeFileToolOn(fs)],
      toolContext: { sandboxFs: fs, cwd: root },
      projectRoot: root,
    });
    expect(r.existing.exists).toBe(true);
    expect(r.existing.fileName).toBe('AGENTS.md');
  });

  test('缺 sandboxFs 时仍可跑(existing 退化为 not-exists,不崩)', async () => {
    const provider = scripted([[asstText('done')]]);
    const r = await runInitProject({
      provider,
      model: 'm',
      tools: [],
      projectRoot: '/proj',
    });
    expect(r.existing.exists).toBe(false);
    expect(r.subagent.terminalReason).toBe('completed');
  });
});
