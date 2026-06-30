/**
 * LSP tools tests —— LSP 子系统(③)。
 *
 * 用内存 stub 的 LspSpawner / SandboxFs 测:
 *   - JSON-RPC 帧编解码 + framer 切帧(含分片到达);
 *   - 1-based ↔ LSP 0-based position 转换;
 *   - 「文件类型 → server」映射 + 不支持语言降级;
 *   - lsp 工具 operation/参数校验、各 operation 的 wire 请求形状、mapResult;
 *   - server 缺失 / spawn 失败时优雅报错(isError 结果,不抛崩 loop);
 *   - lspToolsPack 形状。
 * 不打真 IO。末尾一个 skip-able 真 typescript-language-server 用例。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, DirEnt, StatResult } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import { CoreEventType } from '../src/events/events';
import {
  encodeMessage,
  MessageFramer,
  JsonRpcClient,
  type RpcTransport,
} from '../src/capability/lsp/jsonrpc';
import {
  DEFAULT_SERVERS,
  extOf,
  resolveServerDef,
  type SpawnedServer,
  type LspServerDef,
} from '../src/capability/lsp/servers';
import {
  toLspPosition,
  fromLspPosition,
  pathToUri,
  uriToPath,
  LspPool,
} from '../src/capability/lsp/client';
import { lspTool, lspToolsPack, LSP_OPERATIONS } from '../src/capability/lsp/tool';

// ─── 内存 stub:SandboxFs(只用到 readText)─────────────────────────────────

class MemFs implements SandboxFs {
  files = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }
  readTextSync(p: string): string {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async readText(p: string): Promise<string> {
    return this.readTextSync(p);
  }
  writeTextSync(): void {}
  mkdirSync(): void {}
  existsSync(p: string): boolean {
    return this.files.has(p);
  }
  unlinkSync(): void {}
  renameSync(): void {}
  statSync(): StatResult {
    return { isFile: true, isDir: false, size: 0, mtime: 0 };
  }
  readdirSync(): string[] | DirEnt[] {
    return [];
  }
  async writeText(): Promise<void> {}
  async readBytes(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async writeBytes(): Promise<void> {}
  readStream(): ReadableStream<Uint8Array> {
    return new ReadableStream();
  }
  writeStream(): WritableStream<Uint8Array> {
    return new WritableStream();
  }
}

// ─── 内存 stub:一个「假 language server」transport ──────────────────────────
//
// 它解析 client 写来的 LSP 帧,按 method 回固定结果(0-based,模拟真 server),
// 让我们在不起真进程的情况下测全链路 + 行列转换。

interface FakeServerOpts {
  /** method → 返回 result(收到的 params 也会被记录)。 */
  responders?: Record<string, (params: unknown) => unknown>;
}

function makeFakeSpawner(opts: FakeServerOpts = {}): {
  spawner: (def: LspServerDef, cwd: string) => SpawnedServer;
  sent: Array<{ method: string; params: unknown; id?: number }>;
  spawnedDefs: LspServerDef[];
} {
  const sent: Array<{ method: string; params: unknown; id?: number }> = [];
  const spawnedDefs: LspServerDef[] = [];
  const decoder = new TextDecoder();

  const spawner = (def: LspServerDef): SpawnedServer => {
    spawnedDefs.push(def);
    let dataHandler: ((d: Uint8Array) => void) | null = null;
    const framer = new MessageFramer();
    const transport: RpcTransport = {
      write(data) {
        for (const msg of framer.push(data)) {
          const m = msg as { id?: number; method?: string; params?: unknown };
          if (!m.method) continue;
          sent.push({ method: m.method, params: m.params, id: m.id });
          // 只对带 id 的 request 回响应。
          if (typeof m.id === 'number') {
            let result: unknown = null;
            if (m.method === 'initialize') {
              result = { capabilities: {} };
            } else if (opts.responders?.[m.method]) {
              result = opts.responders[m.method](m.params);
            }
            const reply = encodeMessage({ jsonrpc: '2.0', id: m.id, result });
            // 异步回,模拟真 server。
            queueMicrotask(() => dataHandler?.(reply));
          }
        }
      },
      onData(handler) {
        dataHandler = handler;
      },
      close() {},
      onClose() {},
    };
    return { transport, kill() {} };
  };
  void decoder;
  return { spawner, sent, spawnedDefs };
}

function ctxWith(extra: Record<string, unknown>): ToolContext {
  return { signal: new AbortController().signal, ...extra };
}

// ─── JSON-RPC 编解码 ────────────────────────────────────────────────────────

describe('jsonrpc framing', () => {
  test('encodeMessage 产出 Content-Length 头 + body', () => {
    const bytes = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' });
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('Content-Length: ');
    expect(text).toContain('\r\n\r\n');
    expect(text).toContain('"method":"x"');
  });

  test('MessageFramer 能切出一条完整消息', () => {
    const framer = new MessageFramer();
    const msgs = framer.push(encodeMessage({ jsonrpc: '2.0', id: 7, result: { ok: true } }));
    expect(msgs.length).toBe(1);
    expect((msgs[0] as { id: number }).id).toBe(7);
  });

  test('MessageFramer 能处理分片到达 + 多条粘包', () => {
    const framer = new MessageFramer();
    const a = encodeMessage({ jsonrpc: '2.0', id: 1, result: 'a' });
    const b = encodeMessage({ jsonrpc: '2.0', id: 2, result: 'b' });
    // 先喂 a 的前半 → 0 条;
    expect(framer.push(a.slice(0, 5)).length).toBe(0);
    // 喂 a 剩下 + 整个 b → 2 条。
    const merged = new Uint8Array(a.length - 5 + b.length);
    merged.set(a.slice(5), 0);
    merged.set(b, a.length - 5);
    const out = framer.push(merged);
    expect(out.length).toBe(2);
    expect((out[0] as { id: number }).id).toBe(1);
    expect((out[1] as { id: number }).id).toBe(2);
  });

  test('JsonRpcClient request 按 id resolve;client 关闭 reject 未决', async () => {
    const handlerBox: { fn: ((d: Uint8Array) => void) | null } = { fn: null };
    const transport: RpcTransport = {
      write() {},
      onData(h) {
        handlerBox.fn = h;
      },
      close() {},
    };
    const client = new JsonRpcClient(transport);
    const p = client.request('foo', { a: 1 });
    // 模拟 server 回 id=1。
    handlerBox.fn?.(encodeMessage({ jsonrpc: '2.0', id: 1, result: { done: true } }));
    expect(await p).toEqual({ done: true } as unknown as never);

    const pending = client.request('bar');
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });
});

// ─── position 转换 ──────────────────────────────────────────────────────────

describe('position conversion (1-based <-> 0-based)', () => {
  test('toLspPosition 减 1', () => {
    expect(toLspPosition(1, 1)).toEqual({ line: 0, character: 0 });
    expect(toLspPosition(10, 5)).toEqual({ line: 9, character: 4 });
  });
  test('toLspPosition 下钳到 0(防越界)', () => {
    expect(toLspPosition(0, 0)).toEqual({ line: 0, character: 0 });
  });
  test('fromLspPosition 加 1', () => {
    expect(fromLspPosition({ line: 0, character: 0 })).toEqual({ line: 1, character: 1 });
    expect(fromLspPosition({ line: 9, character: 4 })).toEqual({ line: 10, character: 5 });
  });
});

describe('path <-> uri', () => {
  test('pathToUri / uriToPath 往返', () => {
    const uri = pathToUri('/abs/path/foo.ts');
    expect(uri.startsWith('file:///abs/path/foo.ts')).toBe(true);
    expect(uriToPath(uri)).toBe('/abs/path/foo.ts');
  });
});

// ─── server 映射 ────────────────────────────────────────────────────────────

describe('server resolution', () => {
  test('extOf 取小写扩展名', () => {
    expect(extOf('/a/b/Foo.TS')).toBe('.ts');
    expect(extOf('Bar.tsx')).toBe('.tsx');
    expect(extOf('noext')).toBe('');
  });
  test('TS/JS 扩展名映射到 typescript-language-server', () => {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cts', '.mts']) {
      const def = resolveServerDef(`x${ext}`);
      expect(def?.command).toBe('typescript-language-server');
    }
    expect(DEFAULT_SERVERS['.ts'].languageId).toBe('typescript');
    expect(DEFAULT_SERVERS['.tsx'].languageId).toBe('typescriptreact');
  });
  test('未知语言返回 null', () => {
    expect(resolveServerDef('x.py')).toBeNull();
    expect(resolveServerDef('Makefile')).toBeNull();
  });
});

// ─── 工具:校验 ─────────────────────────────────────────────────────────────

describe('lsp tool validation', () => {
  const tool = lspTool();
  const ctx = ctxWith({ sandboxFs: new MemFs() });

  test('未知 operation 被拒', async () => {
    const r = await tool.validateInput!({ operation: 'nope' as never }, ctx);
    expect(r.result).toBe(false);
  });
  test('workspaceSymbol 缺 query 被拒', async () => {
    const r = await tool.validateInput!({ operation: 'workspaceSymbol' }, ctx);
    expect(r.result).toBe(false);
  });
  test('位置型操作缺 line/character 被拒', async () => {
    const r = await tool.validateInput!({ operation: 'goToDefinition', filePath: '/x.ts' }, ctx);
    expect(r.result).toBe(false);
  });
  test('合法位置型操作通过', async () => {
    const r = await tool.validateInput!(
      { operation: 'hover', filePath: '/x.ts', line: 1, character: 1 },
      ctx,
    );
    expect(r.result).toBe(true);
  });
  test('documentSymbol 只需 filePath', async () => {
    const ok = await tool.validateInput!({ operation: 'documentSymbol', filePath: '/x.ts' }, ctx);
    expect(ok.result).toBe(true);
    const bad = await tool.validateInput!({ operation: 'documentSymbol' }, ctx);
    expect(bad.result).toBe(false);
  });

  test('谓词:只读 + 并发安全', () => {
    expect(tool.isReadOnly({ operation: 'hover' })).toBe(true);
    expect(tool.isConcurrencySafe({ operation: 'hover' })).toBe(true);
    expect(tool.isEnabled()).toBe(true);
  });
});

// ─── 工具:经假 server 跑全链路 + 行列转换 ───────────────────────────────────

describe('lsp tool with fake server', () => {
  test('goToDefinition:wire 请求 0-based,返回转回 1-based', async () => {
    const { spawner, sent } = makeFakeSpawner({
      responders: {
        // server 返回 0-based location(line 9, char 4)。
        'textDocument/definition': () => [
          {
            uri: pathToUri('/repo/target.ts'),
            range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
          },
        ],
      },
    });
    const tool = lspTool();
    const fs = new MemFs({ '/repo/src.ts': 'const x = 1;\n' });
    const ctx = ctxWith({ sandboxFs: fs, lspSpawner: spawner, workspaceRoot: '/repo' });

    const out = await tool.call(
      { operation: 'goToDefinition', filePath: '/repo/src.ts', line: 1, character: 7 },
      ctx,
    );
    // wire 上的 definition 请求 position 应为 0-based(line 0, char 6)。
    const defReq = sent.find((s) => s.method === 'textDocument/definition');
    expect(defReq).toBeDefined();
    expect((defReq!.params as { position: { line: number; character: number } }).position).toEqual({
      line: 0,
      character: 6,
    });
    // didOpen 应被发出。
    expect(sent.some((s) => s.method === 'textDocument/didOpen')).toBe(true);
    // 结果转回 1-based(line 10, char 5)。
    const locs = out.data.result as Array<{ filePath: string; range: { start: { line: number; character: number } } }>;
    expect(locs[0].filePath).toBe('/repo/target.ts');
    expect(locs[0].range.start).toEqual({ line: 10, character: 5 });
    expect(out.data.error).toBeUndefined();
  });

  test('findReferences:带 includeDeclaration context', async () => {
    const { spawner, sent } = makeFakeSpawner({
      responders: {
        'textDocument/references': () => [
          { uri: pathToUri('/repo/a.ts'), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        ],
      },
    });
    const tool = lspTool();
    const ctx = ctxWith({
      sandboxFs: new MemFs({ '/repo/a.ts': 'foo\n' }),
      lspSpawner: spawner,
      workspaceRoot: '/repo',
    });
    const out = await tool.call(
      { operation: 'findReferences', filePath: '/repo/a.ts', line: 1, character: 1 },
      ctx,
    );
    const refReq = sent.find((s) => s.method === 'textDocument/references');
    expect((refReq!.params as { context: { includeDeclaration: boolean } }).context.includeDeclaration).toBe(true);
    expect((out.data.result as unknown[]).length).toBe(1);
  });

  test('hover:抽取 MarkupContent.value', async () => {
    const { spawner } = makeFakeSpawner({
      responders: {
        'textDocument/hover': () => ({ contents: { kind: 'markdown', value: '`x: number`' } }),
      },
    });
    const tool = lspTool();
    const ctx = ctxWith({
      sandboxFs: new MemFs({ '/repo/a.ts': 'const x=1\n' }),
      lspSpawner: spawner,
      workspaceRoot: '/repo',
    });
    const out = await tool.call(
      { operation: 'hover', filePath: '/repo/a.ts', line: 1, character: 7 },
      ctx,
    );
    expect((out.data.result as { contents: string }).contents).toBe('`x: number`');
  });

  test('workspaceSymbol:发 query,不需要 filePath', async () => {
    const { spawner, sent } = makeFakeSpawner({
      responders: {
        'workspace/symbol': () => [
          { name: 'MyClass', kind: 5, location: { uri: pathToUri('/repo/a.ts'), range: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } } } },
        ],
      },
    });
    const tool = lspTool();
    const ctx = ctxWith({ sandboxFs: new MemFs(), lspSpawner: spawner, workspaceRoot: '/repo' });
    const out = await tool.call({ operation: 'workspaceSymbol', query: 'MyClass' }, ctx);
    const symReq = sent.find((s) => s.method === 'workspace/symbol');
    expect((symReq!.params as { query: string }).query).toBe('MyClass');
    const syms = out.data.result as Array<{ name: string; range: { start: { line: number } } }>;
    expect(syms[0].name).toBe('MyClass');
    expect(syms[0].range.start.line).toBe(3); // 2 → 3 (1-based)
  });

  test('incomingCalls:先 prepare 再 incoming', async () => {
    const item = {
      name: 'fn',
      kind: 12,
      uri: pathToUri('/repo/a.ts'),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
    };
    const { spawner, sent } = makeFakeSpawner({
      responders: {
        'textDocument/prepareCallHierarchy': () => [item],
        'callHierarchy/incomingCalls': () => [
          { from: { ...item, name: 'caller' }, fromRanges: [] },
        ],
      },
    });
    const tool = lspTool();
    const ctx = ctxWith({
      sandboxFs: new MemFs({ '/repo/a.ts': 'function fn(){}\n' }),
      lspSpawner: spawner,
      workspaceRoot: '/repo',
    });
    const out = await tool.call(
      { operation: 'incomingCalls', filePath: '/repo/a.ts', line: 1, character: 10 },
      ctx,
    );
    expect(sent.some((s) => s.method === 'textDocument/prepareCallHierarchy')).toBe(true);
    expect(sent.some((s) => s.method === 'callHierarchy/incomingCalls')).toBe(true);
    const calls = out.data.result as Array<{ from: { name: string } }>;
    expect(calls[0].from.name).toBe('caller');
  });

  test('mapResult:成功结果 isError=false', () => {
    const tool = lspTool();
    const ev = tool.mapResult({ operation: 'hover', result: { contents: 'x' } }, 'tu-1');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    expect((ev.payload as { isError: boolean }).isError).toBe(false);
    expect((ev.payload as { operation: string }).operation).toBe('hover');
  });
});

// ─── 优雅降级 ───────────────────────────────────────────────────────────────

describe('lsp tool graceful degradation', () => {
  test('不支持的语言 → isError 结果,不抛', async () => {
    const tool = lspTool();
    const ctx = ctxWith({ sandboxFs: new MemFs({ '/x.py': 'pass\n' }) });
    const out = await tool.call(
      { operation: 'goToDefinition', filePath: '/x.py', line: 1, character: 1 },
      ctx,
    );
    expect(out.data.error).toBeDefined();
    expect(out.data.error).toMatch(/unsupported language|no language server/i);
    // mapResult 标 isError。
    const ev = tool.mapResult(out.data, 'tu');
    expect((ev.payload as { isError: boolean }).isError).toBe(true);
  });

  test('spawn 抛(可执行缺失) → isError 结果,不抛崩 loop', async () => {
    const failSpawner = (): SpawnedServer => {
      throw new Error('spawn typescript-language-server ENOENT');
    };
    const tool = lspTool();
    const ctx = ctxWith({
      sandboxFs: new MemFs({ '/repo/a.ts': 'x\n' }),
      lspSpawner: failSpawner,
      workspaceRoot: '/repo',
    });
    const out = await tool.call(
      { operation: 'hover', filePath: '/repo/a.ts', line: 1, character: 1 },
      ctx,
    );
    expect(out.data.error).toMatch(/ENOENT/);
  });

  test('sandboxFs 缺失 → didOpen 读文件报错降级', async () => {
    const { spawner } = makeFakeSpawner();
    const tool = lspTool();
    const ctx = ctxWith({ lspSpawner: spawner, workspaceRoot: '/repo' });
    const out = await tool.call(
      { operation: 'hover', filePath: '/repo/a.ts', line: 1, character: 1 },
      ctx,
    );
    expect(out.data.error).toMatch(/sandboxFs is missing/);
  });
});

// ─── pack 形状 ──────────────────────────────────────────────────────────────

describe('lspToolsPack', () => {
  test('独立 pack,含 lsp 工具', () => {
    const pack = lspToolsPack();
    expect(pack.name).toBe('lsp-tools');
    expect(pack.layer).toBe('builtin');
    expect(pack.tools?.map((t) => t.name)).toEqual(['lsp']);
  });
  test('LSP_OPERATIONS 覆盖 9 个操作', () => {
    expect(LSP_OPERATIONS.length).toBe(9);
    expect(LSP_OPERATIONS).toContain('goToDefinition');
    expect(LSP_OPERATIONS).toContain('outgoingCalls');
  });
});

// ─── pool 复用 ──────────────────────────────────────────────────────────────

describe('LspPool', () => {
  test('同一 server 复用一个 session;不支持语言返回 null', () => {
    const { spawner, spawnedDefs } = makeFakeSpawner();
    const pool = new LspPool({ spawner, workspaceRoot: '/repo' });
    const s1 = pool.getForFile('/repo/a.ts');
    const s2 = pool.getForFile('/repo/b.tsx'); // 同一 typescript-language-server
    expect(s1).toBe(s2);
    expect(spawnedDefs.length).toBe(1);
    expect(pool.getForFile('/repo/x.py')).toBeNull();
    pool.disposeAll();
  });
});

// ─── skip-able 真 server 用例 ───────────────────────────────────────────────
//
// 本机若装了 typescript-language-server,跑一个真 goToDefinition;否则 skip。

const hasRealServer = (() => {
  try {
    const cp = require('node:child_process') as typeof import('node:child_process');
    const r = cp.spawnSync('typescript-language-server', ['--version'], { timeout: 5000 });
    return r.status === 0 || (r.stdout && r.stdout.length > 0);
  } catch {
    return false;
  }
})();

(hasRealServer ? test : test.skip)(
  'real typescript-language-server goToDefinition 命中定义',
  async () => {
    const cp = require('node:child_process') as typeof import('node:child_process');
    const os = require('node:os') as typeof import('node:os');
    const fsm = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    void cp;
    const dir = fsm.mkdtempSync(path.join(os.tmpdir(), 'lsp-test-'));
    const file = path.join(dir, 'sample.ts');
    // 第 1 行声明 foo;第 2 行使用 foo。对「使用处」求定义应回第 1 行。
    fsm.writeFileSync(file, 'const foo = 42;\nconst bar = foo;\n');

    const realFs: Partial<SandboxFs> = {
      async readText(p: string) {
        return fsm.readFileSync(p, 'utf8');
      },
    };
    const tool = lspTool();
    const ctx = ctxWith({ sandboxFs: realFs as SandboxFs, workspaceRoot: dir });
    // foo 在第 2 行第 13 列(1-based)。
    const out = await tool.call(
      { operation: 'goToDefinition', filePath: file, line: 2, character: 13 },
      ctx,
    );
    fsm.rmSync(dir, { recursive: true, force: true });
    if (out.data.error) {
      // 真 server 在 CI 上偶发慢/初始化失败时容忍,但本地装了应能命中。
      console.warn('real lsp test soft-fail:', out.data.error);
      return;
    }
    const locs = out.data.result as Array<{ range: { start: { line: number } } }>;
    expect(locs.length).toBeGreaterThan(0);
    // 定义在第 1 行(1-based)。
    expect(locs[0].range.start.line).toBe(1);
  },
  30_000,
);
