/**
 * `lsp` builtin tool(②, 但经独立 lspToolsPack 注册)—— 基于 Language Server
 * Protocol 的代码智能工具,让 agent 不靠 grep 猜、用语言服务器精确导航。
 *
 * 单工具 + operation 枚举,覆盖 9 个操作:
 *   goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol /
 *   goToImplementation / prepareCallHierarchy / incomingCalls / outgoingCalls。
 *
 * 入参统一 1-based:filePath + line + character;workspaceSymbol 另带 query。
 * core 内部转 LSP 0-based(见 client.ts toLspPosition)。
 *
 * IO 约定(对齐 file-tools / shell-tools):
 *   - 读文件内容经 ctx.sandboxFs(didOpen 时需要文件文本);
 *   - 起 language server 进程经注入的 LspSpawner(ctx.lspSpawner,缺省走
 *     node:child_process);
 *   - 工作区根经 ctx.workspaceRoot(缺省 process.cwd())。
 * 缺 server / 启动失败 / 不支持语言 → 优雅报错(isError 结果),不抛崩 loop。
 *
 * Boundary: 仅 import core-local + node:。
 */
import type { SandboxFs } from '../../inject/types';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type CapabilityPack, type ToolContext } from '../types';
import { LspPool, type PositionArgs } from './client';
import type { LspServerDef, LspSpawner } from './servers';

/** lsp 工具支持的操作枚举。 */
export const LSP_OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

/** 需要 filePath+line+character 的位置型操作(workspaceSymbol 除外)。 */
const POSITION_OPS = new Set<LspOperation>([
  'goToDefinition',
  'findReferences',
  'hover',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
]);

export interface LspInput {
  operation: LspOperation;
  /** 文件路径(位置型操作 + documentSymbol 必填)。 */
  filePath?: string;
  /** 1-based 行(位置型操作必填)。 */
  line?: number;
  /** 1-based 列(位置型操作必填)。 */
  character?: number;
  /** workspaceSymbol 的查询串。 */
  query?: string;
}

export interface LspOutput {
  operation: LspOperation;
  /** 操作结果(已转 1-based;形状随 operation)。 */
  result?: unknown;
  /** 优雅降级:不支持/失败时给人类可读理由。 */
  error?: string;
}

/** ToolContext 上 host 注入的 LSP 相关句柄(开放形状,缺省有兜底)。 */
export interface LspDeps {
  sandboxFs?: SandboxFs;
  /** 进程 spawner(缺省 node:child_process)。 */
  lspSpawner?: LspSpawner;
  /** 工作区根(缺省 process.cwd())。 */
  workspaceRoot?: string;
  /** 复用同一 ctx 内 LspPool(host 可挂;否则每次调用临时建+用完销毁)。 */
  lspPool?: LspPool;
  /** 自定义「扩展名 → server 定义」(缺省内置 TS/JS)。 */
  lspServers?: Record<string, LspServerDef>;
}

/** lspToolsPack —— 独立 pack(不进 builtinToolsPack),在 assemble.ts push。 */
export function lspToolsPack(): CapabilityPack {
  return {
    name: 'lsp-tools',
    layer: 'builtin',
    tools: [lspTool()],
  };
}

export function lspTool(): AgentTool<LspInput, LspOutput> {
  return buildTool<LspInput, LspOutput>({
    name: 'lsp',
    aliases: ['LSP'],
    searchHint: 'code intelligence via language server: go to definition, find references, hover, symbols, call hierarchy',
    inputJSONSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [...LSP_OPERATIONS],
          description: 'LSP operation to run',
        },
        filePath: {
          type: 'string',
          description: 'Absolute file path (required for position ops and documentSymbol)',
        },
        line: { type: 'number', description: '1-based line number (required for position ops)' },
        character: { type: 'number', description: '1-based column number (required for position ops)' },
        query: { type: 'string', description: 'Symbol query (required for workspaceSymbol)' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    maxResultSizeChars: 30_000,
    // 纯查询:只读 + 并发安全。
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async validateInput(input): Promise<{ result: true } | { result: false; message: string }> {
      if (!LSP_OPERATIONS.includes(input.operation)) {
        return { result: false, message: `lsp: unknown operation "${String(input.operation)}"` };
      }
      if (input.operation === 'workspaceSymbol') {
        if (typeof input.query !== 'string' || input.query === '') {
          return { result: false, message: 'lsp: workspaceSymbol requires a non-empty "query"' };
        }
        return { result: true };
      }
      if (typeof input.filePath !== 'string' || input.filePath === '') {
        return { result: false, message: `lsp: ${input.operation} requires "filePath"` };
      }
      if (POSITION_OPS.has(input.operation)) {
        if (typeof input.line !== 'number' || typeof input.character !== 'number') {
          return {
            result: false,
            message: `lsp: ${input.operation} requires 1-based "line" and "character"`,
          };
        }
      }
      return { result: true };
    },
    async call(input, ctx): Promise<{ data: LspOutput }> {
      const deps = ctx as ToolContext & LspDeps;
      const workspaceRoot = deps.workspaceRoot ?? safeCwd();

      // 取/建 pool(host 注入则复用;否则临时建,call 结束 dispose)。
      const ownsPool = !deps.lspPool;
      const pool =
        deps.lspPool ??
        new LspPool({ spawner: deps.lspSpawner, workspaceRoot });

      // didOpen 需要文件内容:经注入 sandboxFs 读;缺则报错降级。
      const readText = async (p: string): Promise<string> => {
        if (!deps.sandboxFs) {
          throw new Error('lsp: ToolContext.sandboxFs is missing — cannot read file for didOpen');
        }
        return deps.sandboxFs.readText(p);
      };

      try {
        const result = await runOperation(input, { pool, readText, servers: deps.lspServers, signal: ctx.signal });
        return { data: { operation: input.operation, result } };
      } catch (err) {
        // 优雅降级:启动失败/server 缺失/超时/不支持语言 → isError 结果,不崩 loop。
        return { data: { operation: input.operation, error: errMessage(err) } };
      } finally {
        if (ownsPool) pool.disposeAll();
      }
    },
    mapResult(output, toolUseId): CoreEvent {
      return {
        type: CoreEventType.ToolCallResult,
        payload: {
          toolUseId,
          isError: output.error !== undefined,
          operation: output.operation,
          ...(output.error !== undefined ? { error: output.error } : { result: output.result }),
        },
        ts: Date.now(),
      };
    },
    renderToolUseMessage: (input) =>
      input.operation === 'workspaceSymbol'
        ? `lsp workspaceSymbol "${input.query ?? ''}"`
        : `lsp ${input.operation} ${input.filePath ?? ''}:${input.line ?? '?'}:${input.character ?? '?'}`,
  });
}

interface RunDeps {
  pool: LspPool;
  readText: (p: string) => Promise<string>;
  servers?: Record<string, LspServerDef>;
  signal?: AbortSignal;
}

/** 按 operation 分派到 LspSession 的对应方法。 */
async function runOperation(input: LspInput, deps: RunDeps): Promise<unknown> {
  const { pool, readText, servers, signal } = deps;

  if (input.operation === 'workspaceSymbol') {
    // workspaceSymbol 不绑单文件:任取一个已配的 server。用 .ts 占位选默认 TS server。
    const session = pool.getForFile('placeholder.ts', servers);
    if (!session) throw new Error('lsp: no language server configured for workspaceSymbol');
    return session.workspaceSymbol(input.query as string, signal);
  }

  const filePath = input.filePath as string;
  const session = pool.getForFile(filePath, servers);
  if (!session) {
    throw new Error(`lsp: no language server configured for file "${filePath}" (unsupported language)`);
  }

  if (input.operation === 'documentSymbol') {
    return session.documentSymbol({ filePath, readText, signal });
  }

  // 位置型操作。
  const pos: PositionArgs = {
    filePath,
    line: input.line as number,
    character: input.character as number,
    readText,
    signal,
  };
  switch (input.operation) {
    case 'goToDefinition':
      return session.goToDefinition(pos);
    case 'goToImplementation':
      return session.goToImplementation(pos);
    case 'findReferences':
      return session.findReferences(pos);
    case 'hover':
      return session.hover(pos);
    case 'prepareCallHierarchy':
      return session.prepareCallHierarchy(pos);
    case 'incomingCalls':
      return session.incomingCalls(pos);
    case 'outgoingCalls':
      return session.outgoingCalls(pos);
    default:
      throw new Error(`lsp: unhandled operation "${String(input.operation)}"`);
  }
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
