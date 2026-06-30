/**
 * Minimal MCP client interface + in-process reference skeleton (C2 / MCP bridge).
 *
 * core 只定义 host 与 MCP 之间的最小接缝 `MCPClient`（listTools / callTool）。真
 * 实现（stdio / streamable-http / SDK）由 host 注入 —— core **不引外部 MCP SDK**
 * （boundary 禁）。bridge.ts 仅依赖本接口把 MCP 工具映射成 AgentTool。
 *
 * 接口形状：
 *   - listTools()：返回 tools/list 的结果。
 *   - callTool() ：tools/call，返回 content + 可选 _meta /
 *     structuredContent。
 *
 * Boundary: 仅 import core-local。本文件另给一个**基于 Transport 的参考骨架**
 * `InProcessMCPClient`，演示如何在 in-process linked transport 上跑最小
 * JSON-RPC（tools/list、tools/call）—— 供测试 / host 适配参考，非生产实现。
 */
import type { Transport, TransportMessage } from './transport';
import {
  handleServerRequest,
  type ServerRequest,
  type ServerRequestDeps,
} from './server-requests';

// ─── MCP wire 形状（最小子集，对齐 MCP spec）────────────────────────────────

/** MCP 工具的 annotation 提示（对齐 MCP `tool.annotations`）。 */
export interface MCPToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  idempotentHint?: boolean;
  [k: string]: unknown;
}

/** tools/list 返回的单个工具描述（对齐 MCP `Tool`）。 */
export interface MCPTool {
  name: string;
  description?: string;
  /** JSON Schema，bridge 原样塞进 AgentTool.inputJSONSchema。 */
  inputSchema?: Record<string, unknown>;
  annotations?: MCPToolAnnotations;
  /** 开放 meta（如 `anthropic/searchHint` / `anthropic/alwaysLoad`）。 */
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}

/** tools/call 返回（对齐 MCP `CallToolResult`：content + 可选结构化字段）。 */
export interface MCPToolResult {
  /** content block 数组（text / image / resource …），core 原样透传。 */
  content: unknown;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/** callTool 的可选项（取消信号 + 透传 meta）。 */
export interface MCPCallOptions {
  signal?: AbortSignal;
  /** 透传给 server 的 _meta（如 `bc/toolUseId`）。 */
  meta?: Record<string, unknown>;
}

/**
 * MCP `initialize` 握手结果（对齐 MCP spec `InitializeResult` 的最小子集）。
 *   - `protocolVersion`: server 选定的协议版本。
 *   - `capabilities`: server 自报能力（tools / resources / prompts / logging …），
 *     core 不解析其语义,只存下供 host/bridge 决策（如是否订阅 list_changed）。
 *   - `serverInfo`: server 名/版本（诊断用）。
 */
export interface MCPInitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** core 发起 `initialize` 时上报的 clientInfo（对齐 MCP `Implementation`）。 */
export interface MCPClientInfo {
  name: string;
  version: string;
}

/** core 默认上报的 MCP 协议版本 / clientInfo（host 可经 initialize 覆写）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const DEFAULT_MCP_CLIENT_INFO: MCPClientInfo = {
  name: 'forgeax-core',
  version: '0.1.0',
};

// ─── MCPClient 接缝 ──────────────────────────────────────────────────────────

/**
 * host 注入的真实 MCP client。bridge 只用 listTools / callTool；其余成员是协议
 * 深化层（initialize 握手 / capabilities / list_changed 通知）的**可选**接缝——
 * 真 SDK 客户端不实现也能照常被 bridge 消费（fail-open per-method）。
 *
 *   - `listTools()`: 拉取该 server 的工具清单（tools/list）。
 *   - `callTool(name, args, opts)`: 调用工具（tools/call）。
 *   - `initialize(info?)`: **可选** —— 发 JSON-RPC `initialize` 握手,存下 server
 *     回报的 capabilities（之后 `serverCapabilities` 可读）。对齐 MCP spec:
 *     真实流程在 tools/list 之前先 initialize。core 不在 listTools 内部自动调它
 *     （避免破坏「不握手直接 list」的既有调用方）；host 显式调一次即可。
 *   - `serverCapabilities`: **可选** —— initialize 后 server 自报的能力快照。
 *   - `onToolsChanged`: **可选** —— host 可挂的回调;client 收到
 *     `notifications/tools/list_changed`（无 id 的通知帧）时触发,host 据此重拉
 *     tools/list。
 */
export interface MCPClient {
  /** server 名（用于 buildMcpToolName / mcpInfo）。 */
  readonly serverName: string;
  listTools(): Promise<MCPTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: MCPCallOptions,
  ): Promise<MCPToolResult>;
  /** 可选握手:发 initialize、存 capabilities;真 SDK client 可不实现。 */
  initialize?(clientInfo?: MCPClientInfo): Promise<MCPInitializeResult>;
  /** 可选:initialize 后 server 自报的 capabilities（未握手 / 不支持则 undefined）。 */
  readonly serverCapabilities?: Record<string, unknown>;
  /** 可选:server 发 tools/list_changed 通知时触发（host 据此重拉工具）。 */
  onToolsChanged?: () => void;
}

// ─── in-process 参考骨架（基于 Transport 的最小 JSON-RPC）──────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isJsonRpcResponse(m: TransportMessage): m is JsonRpcResponse {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    'id' in m &&
    ('result' in m || 'error' in m)
  );
}

/** server→client 通知帧（无 id 的 JSON-RPC）。core 只关心 method 名。 */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

function isJsonRpcNotification(m: TransportMessage): m is JsonRpcNotification {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (m as { method?: unknown }).method === 'string' &&
    !('id' in m)
  );
}

/**
 * server→client 反向请求帧:同时带 `id` 和 `method`(JSON-RPC 请求)。区别于:
 *   - response(带 id 但带 result/error、无 method);
 *   - notification(带 method 但无 id)。
 */
function isJsonRpcServerRequest(m: TransportMessage): m is ServerRequest {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    'id' in m &&
    typeof (m as { method?: unknown }).method === 'string'
  );
}

/** tools list 变更通知的 method 名（对齐 MCP spec）。 */
export const NOTIFICATION_TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';

/**
 * 基于 `Transport` 的最小 in-process MCP client 参考实现。
 *
 * 协议深化（WS4）：
 *   - `initialize()`: tools/list 之前的 JSON-RPC `initialize` 握手,存下 server
 *     回报的 capabilities（之后 `serverCapabilities` 可读）。不在 listTools 内部
 *     自动调用 —— 保持「不握手直接 list」既有调用方零回归。
 *   - notifications: 收到 `notifications/tools/list_changed`（无 id 的通知帧）→
 *     触发可选 `onToolsChanged`;其余非 response 帧仍安全忽略（不挂起请求）。
 *
 * 仍不实现 elicitation / 重连 —— 那些在 host 真 SDK client 里做。host 接真 SDK
 * 时直接实现 `MCPClient` 即可,不必走本骨架。
 */
export class InProcessMCPClient implements MCPClient {
  readonly serverName: string;
  private readonly transport: Transport;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  /** initialize 后 server 自报的 capabilities（未握手则 undefined）。 */
  serverCapabilities?: Record<string, unknown>;
  /** host 可挂:收到 tools/list_changed 通知时触发。 */
  onToolsChanged?: () => void;
  /**
   * host 可注入:处理 server→client 反向请求(elicitation/sampling/roots)的
   * handler 集合。未注入则对所有反向请求回 method-not-found 错误(不挂起 server)。
   */
  private readonly serverRequestDeps?: ServerRequestDeps;

  constructor(
    serverName: string,
    transport: Transport,
    serverRequestDeps?: ServerRequestDeps,
  ) {
    this.serverName = serverName;
    this.transport = transport;
    this.serverRequestDeps = serverRequestDeps;
    this.transport.onmessage = (m) => this.handleMessage(m);
    this.transport.onclose = () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error('MCP transport closed'));
      }
      this.pending.clear();
    };
  }

  private handleMessage(m: TransportMessage): void {
    // notification（无 id）：tools/list_changed → onToolsChanged;其余安全忽略。
    if (isJsonRpcNotification(m)) {
      if (m.method === NOTIFICATION_TOOLS_LIST_CHANGED) this.onToolsChanged?.();
      return;
    }
    // server→client 反向请求（带 id + method）：路由到注入的 handler 并回 response。
    // 未注入 deps 时 handleServerRequest 会回 method-not-found,不挂起 server。
    if (isJsonRpcServerRequest(m)) {
      void this.handleServerRequestFrame(m);
      return;
    }
    if (!isJsonRpcResponse(m)) return; // 忽略其余非 response 帧（无 id/无 result/error）
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) {
      p.reject(new Error(m.error.message));
    } else {
      p.resolve(m.result);
    }
  }

  /**
   * 处理一条 server→client 反向请求帧:交给 handleServerRequest 路由(纯编排),
   * 把结果(result 或 error)包成完整 JSON-RPC 响应帧发回 server。未注入 deps 时
   * 走空对象 → handleServerRequest 回 method-not-found,server 不会挂起。
   */
  private async handleServerRequestFrame(req: ServerRequest): Promise<void> {
    const resp = await handleServerRequest(req, this.serverRequestDeps ?? {});
    const frame: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: resp.id as number,
      ...(resp.error ? { error: resp.error } : { result: resp.result }),
    };
    if (this.closed) return;
    void this.transport.send(frame).catch(() => {
      // transport 已关 / 发送失败:静默(server 侧自行超时),不影响 client 主流程。
    });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('MCP transport closed'));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(req).catch((e: unknown) => {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /**
   * JSON-RPC `initialize` 握手（对齐 MCP spec）。params 含 protocolVersion +
   * capabilities:{}（core 自身不声明 client 能力）+ clientInfo。存下 server 回报
   * 的 capabilities 到 `serverCapabilities` 并返回完整 InitializeResult。
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
    const result = (await this.request('tools/list')) as
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
    const result = (await this.request('tools/call', params)) as MCPToolResult;
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.transport.close();
  }
}
