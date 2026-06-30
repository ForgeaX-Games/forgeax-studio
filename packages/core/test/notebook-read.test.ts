/**
 * TOOLS test — notebook_read (补齐「有写无读」)。
 *
 * 用内存 stub 的 SandboxFs 测 notebook_read:解析多 cell + 多种 output 的
 * .ipynb fixture,断言 cell 数 / 每 cell 的 id/type/source/outputs 解析正确。
 * 风格对齐 test/builtin-tools.test.ts(内存 fs,不打真 IO)。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, DirEnt, StatResult } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import { CoreEventType } from '../src/events/events';
import {
  notebookReadTool,
  notebookToolsPack,
} from '../src/capability/builtin-tools/notebook-tools';

// ─── stub SandboxFs (内存树,仅用到 readText) ────────────────────────────────

class MemFs implements SandboxFs {
  files = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }
  readTextSync(path: string): string {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
  writeTextSync(path: string, content: string): void {
    this.files.set(path, content);
  }
  mkdirSync(): void {}
  existsSync(path: string): boolean {
    return this.files.has(path);
  }
  unlinkSync(path: string): void {
    this.files.delete(path);
  }
  renameSync(from: string, to: string): void {
    const v = this.readTextSync(from);
    this.files.set(to, v);
    this.files.delete(from);
  }
  statSync(path: string): StatResult {
    const isFile = this.files.has(path);
    return { isFile, isDir: false, size: isFile ? (this.files.get(path) as string).length : 0, mtime: 0 };
  }
  readdirSync(): string[] | DirEnt[] {
    return [];
  }
  async readText(path: string): Promise<string> {
    return this.readTextSync(path);
  }
  async writeText(path: string, content: string): Promise<void> {
    this.writeTextSync(path, content);
  }
  async readBytes(): Promise<Uint8Array> {
    throw new Error('not used');
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

function ctxWith(extra: Record<string, unknown>, signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, ...extra };
}

// ─── fixture:多 cell + 多种 output 的 .ipynb ────────────────────────────────
//
// cell 1: markdown(source 为数组,需 join,无 outputs)
// cell 2: code(stream output + execute_result text/plain)
// cell 3: code(error output)
// cell 4: code(display_data 仅图片,无 text/plain → 占位 + imageMimeType)

const NB_FIXTURE = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: 'md-1',
      cell_type: 'markdown',
      source: ['# Title\n', 'some text'],
      metadata: {},
    },
    {
      id: 'code-1',
      cell_type: 'code',
      source: 'print("hi")\nx',
      execution_count: 1,
      metadata: {},
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['hi\n'] },
        { output_type: 'execute_result', execution_count: 1, data: { 'text/plain': '42' }, metadata: {} },
      ],
    },
    {
      id: 'code-2',
      cell_type: 'code',
      source: 'raise ValueError("boom")',
      execution_count: 2,
      metadata: {},
      outputs: [
        { output_type: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['Traceback', 'ValueError: boom'] },
      ],
    },
    {
      id: 'code-3',
      cell_type: 'code',
      source: 'plot()',
      execution_count: 3,
      metadata: {},
      outputs: [{ output_type: 'display_data', data: { 'image/png': 'BASE64DATA' }, metadata: {} }],
    },
  ],
});

// ─── pack assembly ───────────────────────────────────────────────────────────

describe('notebookToolsPack', () => {
  test('includes both notebook_edit and notebook_read', () => {
    const pack = notebookToolsPack();
    expect(pack.layer).toBe('builtin');
    expect(pack.name).toBe('notebook-tools');
    const names = (pack.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['notebook_edit', 'notebook_read']);
  });
});

// ─── notebook_read ─────────────────────────────────────────────────────────

describe('notebook_read', () => {
  test('predicates: read-only + concurrency-safe + maxResultSizeChars=Infinity', () => {
    const t = notebookReadTool();
    expect(t.isReadOnly({ notebook_path: '/a.ipynb' })).toBe(true);
    expect(t.isConcurrencySafe({ notebook_path: '/a.ipynb' })).toBe(true);
    expect(t.maxResultSizeChars).toBe(Infinity);
    expect(t.aliases).toContain('NotebookRead');
  });

  test('parses cell count + each cell id/type/source', async () => {
    const fs = new MemFs({ '/nb.ipynb': NB_FIXTURE });
    const t = notebookReadTool();
    const { data } = await t.call({ notebook_path: '/nb.ipynb' }, ctxWith({ sandboxFs: fs }));

    expect(data.cellCount).toBe(4);
    expect(data.cells.map((c) => c.id)).toEqual(['md-1', 'code-1', 'code-2', 'code-3']);
    expect(data.cells.map((c) => c.cell_type)).toEqual(['markdown', 'code', 'code', 'code']);

    // markdown source 数组被 join
    expect(data.cells[0].source).toBe('# Title\nsome text');
    expect(data.cells[0].outputs).toEqual([]);

    // code source 字符串原样
    expect(data.cells[1].source).toBe('print("hi")\nx');
  });

  test('parses stream + execute_result(text/plain) outputs to text', async () => {
    const fs = new MemFs({ '/nb.ipynb': NB_FIXTURE });
    const t = notebookReadTool();
    const { data } = await t.call({ notebook_path: '/nb.ipynb' }, ctxWith({ sandboxFs: fs }));

    const outs = data.cells[1].outputs;
    expect(outs).toHaveLength(2);
    expect(outs[0]).toEqual({ output_type: 'stream', text: 'hi\n' });
    expect(outs[1]).toEqual({ output_type: 'execute_result', text: '42' });
  });

  test('parses error output (ename/evalue/traceback) to text', async () => {
    const fs = new MemFs({ '/nb.ipynb': NB_FIXTURE });
    const t = notebookReadTool();
    const { data } = await t.call({ notebook_path: '/nb.ipynb' }, ctxWith({ sandboxFs: fs }));

    const out = data.cells[2].outputs[0];
    expect(out.output_type).toBe('error');
    expect(out.text).toContain('ValueError: boom');
    expect(out.text).toContain('Traceback');
  });

  test('image-only output → placeholder text + imageMimeType hook', async () => {
    const fs = new MemFs({ '/nb.ipynb': NB_FIXTURE });
    const t = notebookReadTool();
    const { data } = await t.call({ notebook_path: '/nb.ipynb' }, ctxWith({ sandboxFs: fs }));

    const out = data.cells[3].outputs[0];
    expect(out.output_type).toBe('display_data');
    expect(out.imageMimeType).toBe('image/png');
    expect(out.text).toBe('[image/png output]');
  });

  test('mapResult → tool.result CoreEvent with cellCount', async () => {
    const fs = new MemFs({ '/nb.ipynb': NB_FIXTURE });
    const t = notebookReadTool();
    const { data } = await t.call({ notebook_path: '/nb.ipynb' }, ctxWith({ sandboxFs: fs }));
    const ev = t.mapResult(data, 'tu_nbr');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    expect((ev.payload as Record<string, unknown>).toolUseId).toBe('tu_nbr');
    expect((ev.payload as Record<string, unknown>).isError).toBe(false);
    expect((ev.payload as Record<string, unknown>).cellCount).toBe(4);
    expect(typeof ev.ts).toBe('number');
  });

  test('throws on non-JSON content', async () => {
    const fs = new MemFs({ '/bad.ipynb': 'not json {' });
    const t = notebookReadTool();
    await expect(t.call({ notebook_path: '/bad.ipynb' }, ctxWith({ sandboxFs: fs }))).rejects.toThrow(
      /not valid JSON/,
    );
  });

  test('throws when cells array missing', async () => {
    const fs = new MemFs({ '/nocells.ipynb': JSON.stringify({ nbformat: 4 }) });
    const t = notebookReadTool();
    await expect(t.call({ notebook_path: '/nocells.ipynb' }, ctxWith({ sandboxFs: fs }))).rejects.toThrow(
      /no cells array/,
    );
  });

  test('throws loud when sandboxFs missing from ctx', async () => {
    const t = notebookReadTool();
    await expect(t.call({ notebook_path: '/a.ipynb' }, ctxWith({}))).rejects.toThrow(/sandboxFs is missing/);
  });

  test('throws when notebook_path empty', async () => {
    const fs = new MemFs();
    const t = notebookReadTool();
    await expect(t.call({ notebook_path: '' }, ctxWith({ sandboxFs: fs }))).rejects.toThrow(
      /non-empty string/,
    );
  });
});
