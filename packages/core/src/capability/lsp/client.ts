/**
 * LspSession —— 把一个 language server 进程封装成「可对一组文件跑 LSP 操作」的会话:
 *   initialize 握手 → 按需 didOpen 文件 → 发 textDocument/* 请求 → 收结果。
 *
 * 9 个操作(对齐 003 待办):
 *   goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol /
 *   goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls。
 *
 * 行列约定:对外入参一律 **1-based**(line/character),对内转 **LSP 0-based**;
 * 返回里的 LSP Position(0-based)转回 1-based 后给上层(toolUserFriendly)。
 *
 * 缺 server / 启动失败 / 不支持的语言 → 上层(tool)优雅报错降级,本会话只在
 * 真正可用时才存在。会话生命周期由 LspPool 管理(按 server 复用)。
 *
 * Boundary: 仅 import core-local + node:。
 */
import { JsonRpcClient } from './jsonrpc';
import {
  type LspServerDef,
  type LspSpawner,
  type SpawnedServer,
  defaultSpawner,
  resolveServerDef,
} from './servers';

/** 路径 → file:// URI。 */
export function pathToUri(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const withSlash = norm.startsWith('/') ? norm : `/${norm}`;
  return `file://${encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** file:// URI → 路径(尽力)。 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  return decodeURI(uri.slice('file://'.length));
}

/** LSP Position(0-based)。 */
interface LspPosition {
  line: number;
  character: number;
}

/** 把 1-based 入参转 0-based LSP position。 */
export function toLspPosition(line1: number, char1: number): LspPosition {
  return { line: Math.max(0, line1 - 1), character: Math.max(0, char1 - 1) };
}

/** 把 0-based LSP position 转回 1-based(对外展示)。 */
export function fromLspPosition(pos: LspPosition): { line: number; character: number } {
  return { line: (pos?.line ?? 0) + 1, character: (pos?.character ?? 0) + 1 };
}

/** 规范化 LSP Location / LocationLink → 友好形状(1-based)。 */
function normalizeLocation(loc: unknown): {
  filePath: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
} | null {
  if (!loc || typeof loc !== 'object') return null;
  const l = loc as Record<string, unknown>;
  // LocationLink 用 targetUri/targetRange;Location 用 uri/range。
  const uri = (l.uri ?? l.targetUri) as string | undefined;
  const range = (l.range ?? l.targetRange) as
    | { start: LspPosition; end: LspPosition }
    | undefined;
  if (!uri || !range) return null;
  return {
    filePath: uriToPath(uri),
    range: { start: fromLspPosition(range.start), end: fromLspPosition(range.end) },
  };
}

/** 把可能是单个 / 数组 / null 的 location 结果统一成数组(1-based)。 */
function normalizeLocations(result: unknown): ReturnType<typeof normalizeLocation>[] {
  if (result == null) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map(normalizeLocation).filter((x): x is NonNullable<typeof x> => x !== null);
}

/** LspSession 配置。 */
export interface LspSessionDeps {
  /** 进程 spawner(默认 node:child_process)。 */
  spawner?: LspSpawner;
  /** 工作区根(rootUri / spawn cwd)。 */
  workspaceRoot: string;
}

/** 一个 language server 会话(单进程,可服务多文件)。 */
export class LspSession {
  private readonly rpc: JsonRpcClient;
  private readonly spawned: SpawnedServer;
  private initialized: Promise<void> | null = null;
  private readonly opened = new Set<string>();
  private disposed = false;

  constructor(
    readonly def: LspServerDef,
    private readonly deps: LspSessionDeps,
  ) {
    const spawner = deps.spawner ?? defaultSpawner;
    this.spawned = spawner(def, deps.workspaceRoot);
    this.rpc = new JsonRpcClient(this.spawned.transport);
  }

  /** initialize 握手(幂等;只发一次)。 */
  private ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return this.initialized;
    const rootUri = pathToUri(this.deps.workspaceRoot);
    this.initialized = this.rpc
      .request(
        'initialize',
        {
          processId: null,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
          capabilities: {
            textDocument: {
              definition: { linkSupport: true },
              implementation: { linkSupport: true },
              references: {},
              hover: { contentFormat: ['markdown', 'plaintext'] },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              callHierarchy: { dynamicRegistration: false },
            },
            workspace: { symbol: {} },
          },
        },
        signal,
      )
      .then(() => {
        this.rpc.notify('initialized', {});
      });
    return this.initialized;
  }

  /** 确保文件已 didOpen(读内容经传入的 readText,首开发 didOpen)。 */
  private async ensureOpen(
    filePath: string,
    readText: (p: string) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureInitialized(signal);
    const uri = pathToUri(filePath);
    if (this.opened.has(uri)) return;
    const text = await readText(filePath);
    this.rpc.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: this.def.languageId, version: 1, text },
    });
    this.opened.add(uri);
  }

  // ─── 9 个操作 ────────────────────────────────────────────────────────────

  async goToDefinition(p: PositionArgs): Promise<unknown> {
    await this.ensureOpen(p.filePath, p.readText, p.signal);
    const res = await this.rpc.request(
      'textDocument/definition',
      this.docPos(p),
      p.signal,
    );
    return normalizeLocations(res);
  }

  async goToImplementation(p: PositionArgs): Promise<unknown> {
    await this.ensureOpen(p.filePath, p.readText, p.signal);
    const res = await this.rpc.request(
      'textDocument/implementation',
      this.docPos(p),
      p.signal,
    );
    return normalizeLocations(res);
  }

  async findReferences(p: PositionArgs): Promise<unknown> {
    await this.ensureOpen(p.filePath, p.readText, p.signal);
    const res = await this.rpc.request(
      'textDocument/references',
      { ...this.docPos(p), context: { includeDeclaration: true } },
      p.signal,
    );
    return normalizeLocations(res);
  }

  async hover(p: PositionArgs): Promise<unknown> {
    await this.ensureOpen(p.filePath, p.readText, p.signal);
    const res = (await this.rpc.request('textDocument/hover', this.docPos(p), p.signal)) as
      | { contents?: unknown; range?: { start: LspPosition; end: LspPosition } }
      | null;
    if (!res) return null;
    return {
      contents: extractHover(res.contents),
      range: res.range
        ? { start: fromLspPosition(res.range.start), end: fromLspPosition(res.range.end) }
        : undefined,
    };
  }

  async documentSymbol(p: { filePath: string; readText: (x: string) => Promise<string>; signal?: AbortSignal }): Promise<unknown> {
    await this.ensureOpen(p.filePath, p.readText, p.signal);
    const res = await this.rpc.request(
      'textDocument/documentSymbol',
      { textDocument: { uri: pathToUri(p.filePath) } },
      p.signal,
    );
    return normalizeSymbols(res);
  }

  async workspaceSymbol(query: string, signal?: AbortSignal): Promise<unknown> {
    await this.ensureInitialized(signal);
    const res = await this.rpc.request('workspace/symbol', { query }, signal);
    return normalizeSymbols(res);
  }

  async prepareCallHierarchy(p: PositionArgs): Promise<unknown> {
    await this.ensureOpen(p.filePath, p.readText, p.signal);
    const res = await this.rpc.request(
      'textDocument/prepareCallHierarchy',
      this.docPos(p),
      p.signal,
    );
    return normalizeCallHierarchyItems(res);
  }

  async incomingCalls(p: PositionArgs): Promise<unknown> {
    const items = (await this.prepareCallHierarchy(p)) as RawItemCarrier[];
    const first = items[0]?._raw;
    if (!first) return [];
    const res = (await this.rpc.request(
      'callHierarchy/incomingCalls',
      { item: first },
      p.signal,
    )) as Array<{ from: unknown }> | null;
    return (res ?? []).map((c) => ({ from: normalizeCallHierarchyItem(c.from) }));
  }

  async outgoingCalls(p: PositionArgs): Promise<unknown> {
    const items = (await this.prepareCallHierarchy(p)) as RawItemCarrier[];
    const first = items[0]?._raw;
    if (!first) return [];
    const res = (await this.rpc.request(
      'callHierarchy/outgoingCalls',
      { item: first },
      p.signal,
    )) as Array<{ to: unknown }> | null;
    return (res ?? []).map((c) => ({ to: normalizeCallHierarchyItem(c.to) }));
  }

  /** textDocument/position 入参(0-based)。 */
  private docPos(p: PositionArgs): { textDocument: { uri: string }; position: LspPosition } {
    return {
      textDocument: { uri: pathToUri(p.filePath) },
      position: toLspPosition(p.line, p.character),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.rpc.notify('shutdown');
      this.rpc.notify('exit');
    } catch {
      // ignore
    }
    this.rpc.dispose();
    this.spawned.kill();
  }
}

/** 带位置的操作入参。 */
export interface PositionArgs {
  filePath: string;
  /** 1-based 行。 */
  line: number;
  /** 1-based 列。 */
  character: number;
  readText: (p: string) => Promise<string>;
  signal?: AbortSignal;
}

interface RawItemCarrier {
  _raw?: unknown;
  [k: string]: unknown;
}

/** 抽取 hover.contents(MarkupContent | MarkedString | 数组)成纯文本。 */
function extractHover(contents: unknown): string {
  if (contents == null) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(extractHover).filter(Boolean).join('\n');
  const c = contents as { value?: unknown; language?: unknown };
  if (typeof c.value === 'string') return c.value;
  return '';
}

/** 规范化 DocumentSymbol[] / SymbolInformation[] → 友好形状(1-based,保留 _raw)。 */
function normalizeSymbols(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  return result.map((s) => {
    const sym = s as Record<string, unknown>;
    // SymbolInformation 有 location;DocumentSymbol 有 range/selectionRange。
    const loc = sym.location as { uri?: string; range?: { start: LspPosition; end: LspPosition } } | undefined;
    const range = (sym.range ?? loc?.range) as { start: LspPosition; end: LspPosition } | undefined;
    return {
      name: sym.name,
      kind: sym.kind,
      filePath: loc?.uri ? uriToPath(loc.uri) : undefined,
      range: range
        ? { start: fromLspPosition(range.start), end: fromLspPosition(range.end) }
        : undefined,
      detail: sym.detail,
      children: Array.isArray(sym.children) ? normalizeSymbols(sym.children) : undefined,
    };
  });
}

/** 规范化 CallHierarchyItem[](保留 _raw 供后续 incoming/outgoing 调用)。 */
function normalizeCallHierarchyItems(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  return result.map((it) => ({ ...normalizeCallHierarchyItem(it), _raw: it }));
}

function normalizeCallHierarchyItem(it: unknown): Record<string, unknown> {
  if (!it || typeof it !== 'object') return {};
  const item = it as Record<string, unknown>;
  const range = item.range as { start: LspPosition; end: LspPosition } | undefined;
  return {
    name: item.name,
    kind: item.kind,
    filePath: item.uri ? uriToPath(item.uri as string) : undefined,
    range: range
      ? { start: fromLspPosition(range.start), end: fromLspPosition(range.end) }
      : undefined,
  };
}

/** 按 server 定义复用会话的小池子(同一 server 命令共享一个进程)。 */
export class LspPool {
  private readonly sessions = new Map<string, LspSession>();

  constructor(private readonly deps: LspSessionDeps) {}

  /** 按文件路径取/建会话;不支持的语言返回 null(上层降级报错)。 */
  getForFile(filePath: string, servers?: Record<string, LspServerDef>): LspSession | null {
    const def = resolveServerDef(filePath, servers);
    if (!def) return null;
    let s = this.sessions.get(def.id);
    if (!s) {
      s = new LspSession(def, this.deps);
      this.sessions.set(def.id, s);
    }
    return s;
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
}
