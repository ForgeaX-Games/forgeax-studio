/**
 * 「文件类型 → language server 命令」映射 + 进程 spawner 接缝。
 *
 * 本仓主力是 TS/JS,默认只配 `typescript-language-server`(stdio)覆盖
 * .ts/.tsx/.js/.jsx/.mjs/.cjs/.cts/.mts。缺对应 server(或可执行不在 PATH)时
 * 由上层(client.ts)优雅报错降级——本文件只做「按扩展名查 server 定义」。
 *
 * spawn 是注入接缝:`LspSpawner` 抽象掉真正的 child_process,默认实现走
 * node:child_process(host 可整体替换,测试可注入内存 stub,core 不强绑真 IO)。
 *
 * Boundary: 仅 import core-local + node:。
 */
import { spawn } from 'node:child_process';
import type { RpcTransport } from './jsonrpc';

/** 一个 language server 的启动定义。 */
export interface LspServerDef {
  /** 标识(诊断用)。 */
  id: string;
  /** 可执行命令(如 'typescript-language-server')。 */
  command: string;
  /** 启动参数(typescript-language-server 用 '--stdio')。 */
  args: string[];
  /** 该 server 上报给 LSP 的 languageId(textDocument/didOpen 用)。 */
  languageId: string;
}

/** 默认内置:文件扩展名(含点,小写)→ server 定义。 */
export const DEFAULT_SERVERS: Record<string, LspServerDef> = (() => {
  const tsLs: Omit<LspServerDef, 'languageId'> = {
    id: 'typescript-language-server',
    command: 'typescript-language-server',
    args: ['--stdio'],
  };
  const map: Record<string, LspServerDef> = {};
  const tsExts = ['.ts', '.tsx', '.cts', '.mts'];
  const jsExts = ['.js', '.jsx', '.cjs', '.mjs'];
  for (const ext of tsExts) {
    map[ext] = { ...tsLs, languageId: ext.endsWith('x') ? 'typescriptreact' : 'typescript' };
  }
  for (const ext of jsExts) {
    map[ext] = { ...tsLs, languageId: ext.endsWith('x') ? 'javascriptreact' : 'javascript' };
  }
  return map;
})();

/** 取文件扩展名(含点,小写);无扩展名返回空串。 */
export function extOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** 按文件路径选 server 定义;无匹配返回 null(上层报「不支持的语言」)。 */
export function resolveServerDef(
  filePath: string,
  servers: Record<string, LspServerDef> = DEFAULT_SERVERS,
): LspServerDef | null {
  return servers[extOf(filePath)] ?? null;
}

// ─── spawn 接缝 ──────────────────────────────────────────────────────────────

/** 已启动的 server 进程句柄(暴露 RpcTransport + kill)。 */
export interface SpawnedServer {
  transport: RpcTransport;
  kill(): void;
}

/** 进程 spawner:host 可注入(测试用内存 stub);默认走 node:child_process。 */
export type LspSpawner = (def: LspServerDef, cwd: string) => SpawnedServer;

/**
 * 默认 spawner —— node:child_process。动态 import 避免在不需要 LSP 的环境/测试里
 * 拉起 child_process 模块。command 不存在时抛(client.ts 捕获 → 优雅降级)。
 */
export function defaultSpawner(def: LspServerDef, cwd: string): SpawnedServer {
  // node: builtin,boundary 允许;只在「真起 server」时才进到这里。
  const child = spawn(def.command, def.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const transport: RpcTransport = {
    write(data) {
      child.stdin?.write(data);
    },
    onData(handler) {
      child.stdout?.on('data', (d: Buffer) => handler(new Uint8Array(d)));
    },
    close() {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
    onClose(handler) {
      child.on('exit', (code, signal) => handler({ code, signal }));
      child.on('error', () => handler({ code: null, signal: null }));
    },
  };
  return {
    transport,
    kill() {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  };
}
