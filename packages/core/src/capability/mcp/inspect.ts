/**
 * MCP 连接态巡检 — `/mcp` 命令的 A 层底层能力（016）。
 *
 * 把 `assemble.ts` 里「解析配置 → 逐 server 连接 → initialize → tools/list」那条
 * 生产链路**复刻成一个只读巡检**：不建 CapabilityPack、不灌 registry，只逐 server
 * 记录**连接结果**(连上 / 失败 / 认证待办) + **工具数**(含 deferred) + **是否延迟注入**。
 *
 * 这是 `/mcp` 命令(以及 Studio `mcp.list` RPC)的数据生产方 —— 让用户看见每个配置的
 * MCP server 到底连没连、暴露了多少工具、是否走 ToolSearch 延迟加载。
 *
 * 设计要点(与 assemble.ts 的连接路径逐字段对齐,避免双份语义漂移)：
 *   - 连接经 `resolveMcpClient`(http/sse 走内置 FetchMCPClient;stdio/ws/sdk 经注入
 *     factory)。core 不引外部 SDK / child_process —— 与 assemble 同源。
 *   - `initialize` 握手 fail-soft：client 支持就调一次,失败不阻断后续 list。
 *   - 延迟注入(deferred)用 `caps.ts:decideMcpDeferMode` 裁决,与生产装配同一裁决器,
 *     保证「巡检显示的 deferred」== 「实际注入时的 deferred」。
 *   - 认证待办(auth-pending)：连接抛 401 / Unauthorized 且该 server 配了 `auth`,归为
 *     `auth-pending`(提示用户去触发 OAuth),其余连接失败归 `failed`。
 *   - **纯函数 + 注入接缝**：所有外部依赖(fetch / stdioFactory / tokenProvider / env)
 *     都从 `deps` 入参拿,不读 `process.env`、不碰全局,便于单测与被 host 复用。
 *   - 连完即关：每个 client 若有 `close()` 巡检结束前调一次(巡检是只读探测,不留连接)。
 *
 * Boundary: 仅 import core-local(本目录 connect/caps/config 接口)。
 */
import type { McpServerConfig } from './config';
import { parseMcpConfig } from './config';
import { resolveMcpClient, type ResolveMcpDeps } from './connect';
import {
  decideMcpDeferMode,
  readMcpSyncThreshold,
  readMcpDeferDefault,
} from './caps';
import type { MCPClient } from './client';

// ─── 对外形状 ──────────────────────────────────────────────────────────────────

/** 单个 MCP server 的连接态。 */
export type McpServerConnState =
  /** 连上且成功拉到工具清单。 */
  | 'connected'
  /** 连接失败(命令缺失 / 网络错 / 协议错 …)。 */
  | 'failed'
  /** 连接被鉴权拒(401/Unauthorized)且该 server 配了 auth → 需触发认证。 */
  | 'auth-pending';

/**
 * 巡检出的单个 server 状态(对齐任务 016 约定的 `{ name, status, toolCount, deferred }`)。
 */
export interface McpServerStatus {
  /** server 名(配置 key,= buildMcpToolName 的 server 段)。 */
  name: string;
  /** 传输类型(stdio/sse/http/ws/sdk;stdio 含 type 省略的归一化结果)。 */
  type: McpServerConfig['type'];
  /** 连接态(连上/失败/认证待办)。 */
  status: McpServerConnState;
  /** 该 server 暴露的工具数(connected 才有意义;失败为 0)。 */
  toolCount: number;
  /** 该 server 是否走延迟注入(ToolSearch 现取;= decideMcpDeferMode 裁出的 async)。 */
  deferred: boolean;
  /** 失败时的错误信息(connected 时 undefined)。 */
  error?: string;
}

/** {@link inspectMcpServers} 的完整结果:逐 server 状态 + 配置解析期错误。 */
export interface McpInspectResult {
  /** 逐 server 巡检结果(顺序 = 配置里出现的顺序)。 */
  servers: McpServerStatus[];
  /** 配置解析期的逐条错误(单条坏不连累其它;对齐 parseMcpConfig 的 fail-soft)。 */
  configErrors: string[];
}

/** {@link inspectMcpServers} 的注入接缝(与 assemble 的 mcp 选项同源)。 */
export interface InspectMcpOptions {
  /** raw `{ mcpServers: {...} }` 配置(string 或已 parse 的对象)。 */
  config: unknown;
  /** 连接接缝(stdio/ws/sdk factory / fetch / tokenProvider);与 assemble 同一份。 */
  deps?: ResolveMcpDeps;
  /** env 源:用于 `${VAR}` 展开与 `auth.tokenEnv` 解析,以及 deferMode 的 env 默认。 */
  env?: Record<string, string | undefined>;
}

// ─── 内部小工具 ────────────────────────────────────────────────────────────────

/**
 * 判断一次连接错误是否「鉴权失败」。core 的 FetchMCPClient 把 401 拼成
 * `… HTTP 401 …` 的 message;真 SDK client 可能给 `Unauthorized` / `401` 等。
 * 这里只做保守的字符串嗅探(不解析 status code —— 错误已被 stringify)。
 */
function looksLikeAuthError(message: string): boolean {
  return /\b401\b|unauthor/i.test(message);
}

/** client 有 close() 就关一次(巡检只读,不留连接);吞掉关闭异常。 */
async function closeQuietly(client: MCPClient): Promise<void> {
  const maybeClose = (client as { close?: () => unknown }).close;
  if (typeof maybeClose === 'function') {
    try {
      await maybeClose.call(client);
    } catch {
      // 关闭失败不影响巡检结果(连接本就是临时探测)。
    }
  }
}

// ─── 巡检主入口 ────────────────────────────────────────────────────────────────

/**
 * 巡检所有配置的 MCP server,返回逐 server 连接态 + 工具数 + 延迟标记。
 *
 * 流程逐 server：`resolveMcpClient` → (可选)`initialize` → `tools/list` → 关连接。
 * 任一步抛错 → 该 server 归 `failed`(或 `auth-pending`,见 {@link looksLikeAuthError}),
 * 其余 server 继续(fail-soft,单 server 坏不连累全局)。
 *
 * deferred 标记在所有 server 连完、拿到各自工具数后,用 `decideMcpDeferMode` 统一裁决
 * (auto 模式的阈值比较需要全局工具总数,故必须后置一次性算)。
 *
 * @param opts 配置 + 注入接缝(见 {@link InspectMcpOptions})。
 * @returns 逐 server 状态 + 配置解析错误(见 {@link McpInspectResult})。
 */
export async function inspectMcpServers(
  opts: InspectMcpOptions,
): Promise<McpInspectResult> {
  const { servers: parsed, errors: configErrors } = parseMcpConfig(opts.config, {
    env: opts.env,
  });

  // 第一遍:逐 server 连接 + 拉工具数。deferred 留到第二遍统一裁决。
  const serverConfigs: Record<string, { defer_loading?: boolean } | undefined> = {};
  const toolCounts: Record<string, number> = {};
  const partial: Array<Omit<McpServerStatus, 'deferred'>> = [];

  for (const s of parsed) {
    serverConfigs[s.name] = { defer_loading: s.config.defer_loading };
    const hasAuth = s.config.auth !== undefined;
    try {
      const client = await resolveMcpClient(s.name, s.config, opts.deps);
      // initialize 握手 fail-soft(与 assemble 一致):支持就调一次,失败不阻断 list。
      const maybeInit = (client as { initialize?: () => Promise<unknown> }).initialize;
      if (typeof maybeInit === 'function') {
        await maybeInit.call(client).catch(() => {});
      }
      const tools = await client.listTools();
      await closeQuietly(client);
      toolCounts[s.name] = tools.length;
      partial.push({
        name: s.name,
        type: s.config.type,
        status: 'connected',
        toolCount: tools.length,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toolCounts[s.name] = 0;
      // 鉴权失败 + 配了 auth → auth-pending(用户可去触发 OAuth);否则纯 failed。
      const status: McpServerConnState =
        hasAuth && looksLikeAuthError(message) ? 'auth-pending' : 'failed';
      partial.push({
        name: s.name,
        type: s.config.type,
        status,
        toolCount: 0,
        error: message,
      });
    }
  }

  // 第二遍:用与生产装配同一裁决器算每个 server 的 deferred(auto 模式依赖全局工具总数)。
  const { perServer } = decideMcpDeferMode(
    serverConfigs,
    toolCounts,
    readMcpSyncThreshold(opts.env),
    readMcpDeferDefault(opts.env),
  );

  const out: McpServerStatus[] = partial.map((p) => ({
    ...p,
    deferred: perServer[p.name] === 'async',
  }));

  return { servers: out, configErrors };
}
