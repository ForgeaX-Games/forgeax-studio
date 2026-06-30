/**
 * 会话概览聚合(A 层 · 024 /status)—— 一个**纯函数** `getStatus(sources)`:
 * 把散落各处的会话事实(model / cwd / 会话 id / 权限模式 / 已连 MCP 数 / Usage 摘要)
 * 折成一份可一屏速览的 `StatusSnapshot`,供 TUI `/status` 命令 + Studio `status` RPC 共用。
 *
 * 设计要点:
 *   - **纯聚合,零 IO、零探测**:所有来源都从 `sources` 入参拿(集成方各 base getter
 *     喂进来),本函数不读 `process.env`、不连网、不碰全局,便于单测与被 host 复用。
 *     (与 `/doctor` 区别:doctor 才做连通探测,见 `doctor.ts`。)
 *   - **复用 015 的 `summarizeUsage`**:Usage 摘要直接套用既有纯计算(token + 估费),
 *     不重造单价表。集成方把累计 `Usage` 喂进 `sources.usage` 即可。
 *   - **MCP 数从巡检结果折算**:`sources.mcpServers` 传 016 `inspectMcpServers` 的
 *     `servers[]`(或任何同形数组),这里只数 connected / 总数,不重连。
 *   - **缺省优雅**:任一来源缺失 → 对应字段给安全缺省(undefined / 0),不抛。
 *
 * Boundary: 仅 import core-local 类型 + 015 纯计算。
 */
import type { Usage } from '../provider/types';
import type { PermissionMode } from '../permission/engine';
import { summarizeUsage, type UsageSummary, type SummarizeUsageOptions } from '../context/usage-stats';

/** getStatus 的「已连 MCP」入参形状(取 016 `McpServerStatus` 的最小子集,解耦)。 */
export interface StatusMcpServer {
  /** server 名。 */
  name: string;
  /** 连接态('connected' 才计入「已连数」)。 */
  status: 'connected' | 'failed' | 'auth-pending';
  /** 该 server 暴露的工具数(connected 才有意义)。 */
  toolCount?: number;
}

/**
 * `getStatus` 的全部数据来源(集成方各 base getter 喂入)。
 *
 * 全部可选 —— 缺啥就少展示啥,聚合函数对缺省优雅(不抛)。
 */
export interface StatusSources {
  /** 当前 model id。 */
  model?: string;
  /** 当前工作目录(集成方一般传 toolContext.cwd 或 process.cwd())。 */
  cwd?: string;
  /** 会话 id(--resume/--session;无持久会话则 undefined → 展示「临时会话」)。 */
  sessionId?: string;
  /** 当前权限模式(默认 'default')。 */
  permissionMode?: PermissionMode;
  /** MCP 巡检结果(016 inspectMcpServers 的 servers[],或同形数组)。 */
  mcpServers?: readonly StatusMcpServer[];
  /** 累计 usage(集成方持有;喂进来后这里套 summarizeUsage)。 */
  usage?: Usage;
  /** 已发生的对话轮次数(可选;集成方从历史/事件流数)。 */
  turns?: number;
  /** 单价覆写(透传给 summarizeUsage)。 */
  usageOptions?: SummarizeUsageOptions;
}

/** MCP 连接数概览(已连 / 总配置 / 失败 / 待认证)。 */
export interface StatusMcpSummary {
  /** 配置里的 server 总数。 */
  total: number;
  /** 连上的 server 数。 */
  connected: number;
  /** 连接失败的 server 数。 */
  failed: number;
  /** 待认证(401 + 配了 auth)的 server 数。 */
  authPending: number;
}

/** 一屏速览的会话快照(`/status` 渲染层直接读这个)。 */
export interface StatusSnapshot {
  /** 当前 model id(缺省 undefined)。 */
  model?: string;
  /** 当前工作目录(缺省 undefined)。 */
  cwd?: string;
  /** 会话 id;undefined 表示临时(非持久)会话。 */
  sessionId?: string;
  /** 是否持久会话(有 sessionId 即 true → 可 --resume)。 */
  persistent: boolean;
  /** 当前权限模式(缺省 'default')。 */
  permissionMode: PermissionMode;
  /** MCP 连接数概览。 */
  mcp: StatusMcpSummary;
  /** Usage 摘要(套 015 summarizeUsage;无 usage 时为零摘要)。 */
  usage: UsageSummary;
  /** 已发生轮次(缺省 0)。 */
  turns: number;
}

/** 把 MCP 巡检结果折成连接数概览(只数,不重连)。 */
function summarizeMcp(servers: readonly StatusMcpServer[] | undefined): StatusMcpSummary {
  const list = servers ?? [];
  let connected = 0;
  let failed = 0;
  let authPending = 0;
  for (const s of list) {
    if (s.status === 'connected') connected += 1;
    else if (s.status === 'auth-pending') authPending += 1;
    else failed += 1;
  }
  return { total: list.length, connected, failed, authPending };
}

/**
 * 聚合会话概览(`/status` 用)。纯函数:只读 `sources`,不探测、不抛。
 *
 * @param sources 各 base 来源(集成方喂入;全部可选,缺省优雅)。
 * @returns 一屏速览快照(见 {@link StatusSnapshot})。
 */
export function getStatus(sources: StatusSources = {}): StatusSnapshot {
  return {
    model: sources.model,
    cwd: sources.cwd,
    sessionId: sources.sessionId,
    persistent: sources.sessionId !== undefined && sources.sessionId !== '',
    permissionMode: sources.permissionMode ?? 'default',
    mcp: summarizeMcp(sources.mcpServers),
    usage: summarizeUsage(sources.usage, sources.model, sources.usageOptions),
    turns: sources.turns ?? 0,
  };
}
