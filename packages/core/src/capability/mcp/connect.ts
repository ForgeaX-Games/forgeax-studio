/**
 * MCP client resolver — config → MCPClient (C2 / MCP bridge).
 *
 * 把一份解析好的 `McpServerConfig`（见 `config.ts`）落地成一个可用的 `MCPClient`
 * （见 `client.ts`），供 `getMcpTools` / `mcpPack` 消费：
 *
 *   - **http / sse**：core 内**用原生 `fetch` 自实现**最小 JSON-RPC 客户端
 *     （`initialize` 可选 → `tools/list` → `tools/call`，over HTTP POST）。
 *     **不引外部 MCP SDK**（boundary 禁）。sse 与 http 在 wire 层都走 POST，
 *     区别仅在 server 可能以 `text/event-stream` 回 SSE 帧 —— 本实现两种
 *     Content-Type 都能解析（裸 JSON 或 `data:` 帧）。
 *   - **stdio**：core 不引 `child_process`，经注入的 `deps.stdioFactory` 拿
 *     client（host 提供真正 spawn 的实现）。
 *   - **ws / sdk**：core 不内置，留给 host 经 `deps.wsFactory` / `deps.sdkFactory`
 *     注入；未注入则抛错。
 *
 * Boundary: 仅 import core-local 相对路径 + `node:`（实际只用全局 `fetch`）。
 */
import type {
  McpServerConfig,
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHTTPServerConfig,
  McpWebSocketServerConfig,
  McpSdkServerConfig,
  McpAuthConfig,
} from './config';
import type { TokenProvider } from './auth';
import { resolveAuthHeaders } from './auth';
import type {
  MCPClient,
  MCPTool,
  MCPToolResult,
  MCPCallOptions,
  MCPClientInfo,
  MCPInitializeResult,
} from './client';
import {
  MCP_PROTOCOL_VERSION,
  DEFAULT_MCP_CLIENT_INFO,
} from './client';

// ─── 注入接缝 ──────────────────────────────────────────────────────────────────

/**
 * host 注入的 client factory。core 不引 child_process / ws / SDK —— stdio、ws、
 * sdk 三类全由 host 提供。可同步返回或返回 Promise。
 */
export interface ResolveMcpDeps {
  /** 可注入的 fetch（测试用假 fetch）；缺省用全局 `fetch`。 */
  fetch?: typeof fetch;
  /** http/sse client 的重连退避配置（瞬时网络 / 5xx 有界重试）。缺省 max 2 次。 */
  retry?: McpRetryConfig;
  /** stdio：host spawn 子进程并返回 MCPClient。 */
  stdioFactory?: (
    name: string,
    config: McpStdioServerConfig,
  ) => MCPClient | Promise<MCPClient>;
  /** ws：host 用 WebSocket 实现并返回 MCPClient。 */
  wsFactory?: (
    name: string,
    config: McpWebSocketServerConfig,
  ) => MCPClient | Promise<MCPClient>;
  /** sdk：host 进程内 SDK 注册并返回 MCPClient。 */
  sdkFactory?: (
    name: string,
    config: McpSdkServerConfig,
  ) => MCPClient | Promise<MCPClient>;
  /**
   * MCP auth（M3）的 token 提供方。core 不存 token——bearer header 从 cfg.auth.token
   * 或这里回调拿；401 时也经此回调强制 refresh 一次。仅 http/sse 走 FetchMCPClient
   * 时透传。
   */
  tokenProvider?: TokenProvider;
}

/**
 * FetchMCPClient 的 auth 接缝（M3）——构造时可选注入，承载 bearer 配置与 token 回调。
 * 不传则行为与无鉴权完全一致（向后兼容）。
 */
export interface FetchMCPAuthOptions {
  /** 已解析的 auth 配置（bearer token 等）；缺省视为无鉴权。 */
  auth?: McpAuthConfig;
  /** host 注入的 token 提供方；401 时也经此 `{refresh:true}` 拿新 token。 */
  tokenProvider?: TokenProvider;
}

// ─── JSON-RPC over HTTP（fetch）────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * 重连/退避(WS4):瞬时网络错误 / 5xx 有界重试,最多 2 次(共 3 次尝试)。
 * delay = baseDelayMs * 2^attempt(指数,attempt 从 0 起)。非瞬时错误(4xx /
 * JSON-RPC error / abort)不重试 —— 对齐「只对可恢复故障退避」。
 */
export interface McpRetryConfig {
  /** 最大重试次数(不含首次)。默认 2。设 0 关闭重试。 */
  maxRetries?: number;
  /** 退避基数(ms)。默认 50。第 n 次重试前等 baseDelayMs * 2^n。 */
  baseDelayMs?: number;
  /** 可注入的 sleep（测试可传 no-op 跳过真实等待）。缺省用 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MCP_RETRY: Required<Omit<McpRetryConfig, 'sleep'>> = {
  maxRetries: 2,
  baseDelayMs: 50,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 5xx 视为瞬时(server 侧暂时不可用);4xx 视为永久(请求本身有问题)。 */
function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** fetch 抛出的网络层错误(DNS / 连接断 / abort 之外的 TypeError)视为瞬时。
 *  abort（signal 触发）不算瞬时 —— 调用方主动取消,不应重试。 */
function isTransientFetchError(e: unknown): boolean {
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return false;
  }
  // fetch 网络失败在多数 runtime 抛 TypeError('fetch failed' / 'Failed to fetch')。
  return e instanceof TypeError;
}

/**
 * 从一个 HTTP 响应体里取出 JSON-RPC result。
 *   - `application/json`：整体即一个 JSON-RPC response。
 *   - `text/event-stream`：逐行扫 `data:` 帧，取**最后一个**含 id 的 response 帧
 *     （MCP streamable-http 的单次 request 通常只回一帧 response + 可选 notifications）。
 */
function parseJsonRpcBody(contentType: string, body: string): JsonRpcResponse {
  const isSSE = contentType.includes('text/event-stream');
  if (!isSSE) {
    return JSON.parse(body) as JsonRpcResponse;
  }
  let last: JsonRpcResponse | undefined;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload.length === 0 || payload === '[DONE]') continue;
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(payload) as JsonRpcResponse;
    } catch {
      continue;
    }
    // 仅认带 id 的 response 帧（跳过 server→client notification）。
    if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
      last = parsed;
    }
  }
  if (!last) {
    throw new Error('SSE response contained no JSON-RPC result frame');
  }
  return last;
}

/**
 * 基于 `fetch` 的最小 HTTP/SSE MCP client。每个 JSON-RPC request 一次 POST。
 * 协议深化（WS4）：
 *   - `initialize()`: tools/list 之前的 JSON-RPC `initialize` 握手,存下 server
 *     回报的 capabilities（之后 `serverCapabilities` 可读）。不在 listTools 内部
 *     自动调,host 显式调一次。
 *   - 重连/退避: 瞬时网络错误 / 5xx 有界重试（默认 max 2 次,指数退避）。4xx /
 *     JSON-RPC error / abort 不重试。`fetch` 与 `sleep` 均可注入,便于测试。
 *
 * 仍不做 session 复用 / SSE 长连;`onToolsChanged` 在 HTTP 一次性 POST 模型下
 * 无独立 server→client 通知通道,留作接口对齐（host 用 streamable-http 长连时挂）。
 */
export class FetchMCPClient implements MCPClient {
  readonly serverName: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: Required<Omit<McpRetryConfig, 'sleep'>>;
  private readonly sleep: (ms: number) => Promise<void>;
  /** auth 配置（bearer token 等）；M3 注入，缺省视为无鉴权。 */
  private readonly auth?: McpAuthConfig;
  /** host 注入的 token 提供方；401 刷新也经此回调。 */
  private readonly tokenProvider?: TokenProvider;
  private nextId = 1;
  /** initialize 后 server 自报的 capabilities（未握手则 undefined）。 */
  serverCapabilities?: Record<string, unknown>;
  /** 接口对齐:HTTP 一次性 POST 无独立通知通道,host 长连时可挂。 */
  onToolsChanged?: () => void;

  constructor(
    serverName: string,
    url: string,
    headers: Record<string, string> | undefined,
    fetchImpl: typeof fetch,
    retry?: McpRetryConfig,
    auth?: FetchMCPAuthOptions,
  ) {
    this.serverName = serverName;
    this.url = url;
    this.headers = headers ?? {};
    this.fetchImpl = fetchImpl;
    this.retry = {
      maxRetries: retry?.maxRetries ?? DEFAULT_MCP_RETRY.maxRetries,
      baseDelayMs: retry?.baseDelayMs ?? DEFAULT_MCP_RETRY.baseDelayMs,
    };
    this.sleep = retry?.sleep ?? defaultSleep;
    this.auth = auth?.auth;
    this.tokenProvider = auth?.tokenProvider;
  }

  /**
   * 发一次 POST 并解析 JSON-RPC body。瞬时故障（网络层 TypeError / 5xx）按指数退避
   * 有界重试;到顶仍失败则抛最后一次错误。非瞬时（4xx / JSON-RPC error / abort）
   * 立即抛,不重试。
   *
   * auth（M3）：每次发送前 `resolveAuthHeaders` 组装 bearer header 并 merge 进
   * POST headers。遇 HTTP **401** 时——独立于上面的 5xx/网络退避——经
   * `tokenProvider(server, {refresh:true})` 强制刷新一次 token、重组 header，并对
   * 同一请求**恰好重试一次**;仍 401 则抛。无 tokenProvider 则 401 直接当 4xx 抛。
   */
  private async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    // 首发用配置 / 当前 token 组装 auth header；401 后再带 refresh=true 刷新。
    let authHeaders = await resolveAuthHeaders(
      this.auth,
      this.tokenProvider,
      this.serverName,
    );
    // 401-refresh 与 5xx/网络退避正交：整个退避循环允许在 401 后再整体跑一遍。
    let refreshedOn401 = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let lastErr: unknown;
      let got401 = false;

      for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
        // 重试前退避（首次 attempt=0 不等）。
        if (attempt > 0) {
          await this.sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
        }
        if (signal?.aborted) {
          throw new Error(`MCP ${this.serverName} ${method} aborted`);
        }
        let res: Response;
        try {
          res = await this.fetchImpl(this.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // 兼容 streamable-http server：声明可接 JSON 或 SSE。
              accept: 'application/json, text/event-stream',
              ...this.headers,
              ...authHeaders,
            },
            body,
            signal,
          });
        } catch (e) {
          lastErr = e;
          // 网络层瞬时错 → 重试;abort / 非瞬时 → 立即抛。
          if (isTransientFetchError(e) && attempt < this.retry.maxRetries) continue;
          throw e instanceof Error ? e : new Error(String(e));
        }
        // 401 → token 失效:跳出退避循环,刷新一次后整体重试(仅一次)。
        if (res.status === 401) {
          got401 = true;
          lastErr = new Error(
            `MCP ${this.serverName} ${method} HTTP 401 ${res.statusText}`,
          );
          break;
        }
        if (!res.ok) {
          lastErr = new Error(
            `MCP ${this.serverName} ${method} HTTP ${res.status} ${res.statusText}`,
          );
          // 5xx 瞬时 → 重试;4xx 永久 → 立即抛。
          if (isTransientStatus(res.status) && attempt < this.retry.maxRetries) continue;
          throw lastErr;
        }
        const contentType = res.headers.get('content-type') ?? 'application/json';
        const text = await res.text();
        const rpc = parseJsonRpcBody(contentType, text);
        if (rpc.error) {
          // JSON-RPC 应用层错误不是传输瞬时故障 → 不重试。
          throw new Error(`MCP ${this.serverName} ${method}: ${rpc.error.message}`);
        }
        return rpc.result;
      }

      // 退避循环因 401 跳出：尝试刷新 token 后整体重试一次。
      if (got401 && !refreshedOn401 && this.tokenProvider) {
        refreshedOn401 = true;
        const refreshed = await this.tokenProvider(this.serverName, {
          refresh: true,
          signal,
        });
        authHeaders =
          refreshed !== undefined && refreshed.length > 0
            ? { Authorization: `Bearer ${refreshed}` }
            : await resolveAuthHeaders(this.auth, this.tokenProvider, this.serverName);
        continue; // 带新 token 重跑整个退避循环（仅此一次）。
      }

      // 无可刷新（无 provider / 已刷过一次）或非 401 兜底 → 抛最后一次错误。
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }
  }

  /**
   * JSON-RPC `initialize` 握手。params 含 protocolVersion + capabilities:{} +
   * clientInfo。存下 server 回报的 capabilities 到 `serverCapabilities`。
   */
  async initialize(
    clientInfo: MCPClientInfo = DEFAULT_MCP_CLIENT_INFO,
  ): Promise<MCPInitializeResult> {
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    })) as MCPInitializeResult | undefined;
    const init = result ?? {};
    this.serverCapabilities = init.capabilities;
    return init;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = (await this.request('tools/list', {})) as
      | { tools?: MCPTool[] }
      | undefined;
    return result?.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: MCPCallOptions,
  ): Promise<MCPToolResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (opts?.meta) params._meta = opts.meta;
    const result = (await this.request(
      'tools/call',
      params,
      opts?.signal,
    )) as MCPToolResult;
    return result;
  }
}

// ─── resolve ──────────────────────────────────────────────────────────────────

/**
 * 把一个 `McpServerConfig` 落地成 `MCPClient`。
 *
 *   - http / sse → core 内置 `FetchMCPClient`（原生 fetch）。
 *   - stdio / ws / sdk → 经注入的 factory（host 提供）；未注入则抛错。
 *
 * @param name    server 名（用于 client.serverName / buildMcpToolName）。
 * @param config  已解析的 server config。
 * @param deps    注入接缝（fetch / stdioFactory / wsFactory / sdkFactory）。
 */
export async function resolveMcpClient(
  name: string,
  config: McpServerConfig,
  deps: ResolveMcpDeps = {},
): Promise<MCPClient> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as typeof fetch | undefined);

  switch (config.type) {
    case 'http':
    case 'sse': {
      if (!fetchImpl) {
        throw new Error(
          `MCP server "${name}": no fetch available for ${config.type} transport`,
        );
      }
      const c = config as McpHTTPServerConfig | McpSSEServerConfig;
      // M3：把 cfg.auth + 注入的 tokenProvider 透传给 FetchMCPClient。
      // `auth` 字段由 M1 在 config.ts 并发新增，运行时缺省即无鉴权（向后兼容）。
      const auth = (c as { auth?: McpAuthConfig }).auth;
      const authOpts: FetchMCPAuthOptions | undefined =
        auth !== undefined || deps.tokenProvider !== undefined
          ? { auth, tokenProvider: deps.tokenProvider }
          : undefined;
      return new FetchMCPClient(name, c.url, c.headers, fetchImpl, deps.retry, authOpts);
    }
    case 'stdio':
    case undefined: {
      if (!deps.stdioFactory) {
        throw new Error(
          `MCP server "${name}": stdio transport requires deps.stdioFactory (host must inject)`,
        );
      }
      return deps.stdioFactory(name, config as McpStdioServerConfig);
    }
    case 'ws': {
      if (!deps.wsFactory) {
        throw new Error(
          `MCP server "${name}": ws transport requires deps.wsFactory (host must inject)`,
        );
      }
      return deps.wsFactory(name, config as McpWebSocketServerConfig);
    }
    case 'sdk': {
      if (!deps.sdkFactory) {
        throw new Error(
          `MCP server "${name}": sdk transport requires deps.sdkFactory (host must inject)`,
        );
      }
      return deps.sdkFactory(name, config as McpSdkServerConfig);
    }
    default: {
      // 穷尽兜底（理论不可达）。
      const exhaustive: never = config;
      throw new Error(`MCP server "${name}": unsupported config ${JSON.stringify(exhaustive)}`);
    }
  }
}
