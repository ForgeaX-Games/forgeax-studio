/**
 * MCP tool → AgentTool bridge (C2 / MCP bridge).
 *
 * 把一个 MCP server 的 tools/list 结果映射成 core 的 `AgentTool[]`，
 * 工具名走 `buildMcpToolName`：
 *   - 名: `mcp__${server}__${tool}`，`isMcp:true` + `mcpInfo`。
 *   - schema: `inputJSONSchema` 原样（MCP 给 JSON Schema，不转 zod）。
 *   - 谓词: readOnly / concurrencySafe ← `annotations.readOnlyHint`；
 *           destructive ← `annotations.destructiveHint`（缺省 fail-closed=false）。
 *   - checkPermissions: 返回 **passthrough** —— core 不在工具内把闸，真正的决策
 *     交给 PERM 规则引擎。
 *   - call: 调 `client.callTool` 并 mapResult（content + 可选 mcpMeta）。
 *
 * Boundary: 仅 import core-local（C2 契约 + 本目录 client/transport 接口）。
 */
import type { AgentTool, JSONSchema, PermissionResult, ToolContext, ToolResult } from '../types';
import type { CoreEvent } from '../../events/types';
import type { MCPClient, MCPTool, MCPToolResult } from './client';
import type { McpDeferMode } from './caps';
import { DEFAULT_MCP_RESULT_BUDGET } from '../../context/tool-result-budget';

// ─── name ────────────────────────────────────────────────────────────────────

/**
 * 规整 name 以匹配 API pattern `^[a-zA-Z0-9_-]{1,64}$`：非法字符 → `_`。
 * MCP 名称规整（不含某托管端专属的折叠分支——core 不感知该来源）。
 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 构造全限定 MCP 工具名 `mcp__${server}__${tool}`（server / tool 均先 normalize）。
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

// ─── result 映射 ──────────────────────────────────────────────────────────────

/**
 * MCP callTool 结果 → core ToolResult。
 *   - `data`: content block（原样透传）。
 *   - `mcpMeta`: 仅当 server 给了 `_meta` 或 `structuredContent` 时附带（条件展开）。
 */
export function mapMcpResult(result: MCPToolResult): ToolResult<unknown> {
  const out: ToolResult<unknown> = { data: result.content };
  if (result._meta || result.structuredContent !== undefined) {
    out.mcpMeta = {
      ...(result._meta ? { _meta: result._meta } : {}),
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
    };
  }
  return out;
}

// ─── 单工具映射 ────────────────────────────────────────────────────────────────

/** 截断过长 description（给一个保守上限）。 */
const MAX_MCP_DESCRIPTION_LENGTH = 25000;

function truncateDescription(desc: string): string {
  return desc.length > MAX_MCP_DESCRIPTION_LENGTH
    ? `${desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}… [truncated]`
    : desc;
}

/** 折叠 searchHint 里的空白（_meta 对外开放，换行会污染 deferred-tool 列表）。 */
function readSearchHint(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.['anthropic/searchHint'];
  if (typeof raw !== 'string') return undefined;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

/** {@link mapMcpToolToAgentTool} / {@link getMcpTools} 的注入治理选项。 */
export interface MapMcpToolOptions {
  /**
   * 该 server 的注入模式（由 `caps.ts:decideMcpDeferMode` 裁出）。
   *   - `'async'`：该工具延迟加载（设 `shouldDefer:()=>true`），但 `alwaysLoad`
   *     工具豁免（恒首轮上线）。
   *   - `'sync'` / 缺省：不设 `shouldDefer`，工具首轮就在 wire 上（原有行为）。
   */
  deferMode?: McpDeferMode;
}

/**
 * 把单个 MCP 工具映射成 AgentTool。
 *
 * 注意:这里**不走 buildTool 的 fail-closed 默认**,而是显式给齐谓词——因为 MCP
 * 工具的并发安全/只读语义来自 annotation,需逐字段精确处理,而非用本地工具的
 * 「未声明即 false」默认（虽两者对 readOnly 的缺省都落到 false）。
 *
 * @param opts 注入治理（`deferMode`）。缺省 = 原有同步行为，向后兼容。
 */
export function mapMcpToolToAgentTool(
  client: MCPClient,
  serverName: string,
  mcpTool: MCPTool,
  opts?: MapMcpToolOptions,
): AgentTool<Record<string, unknown>, unknown> {
  const fullName = buildMcpToolName(serverName, mcpTool.name);
  const readOnly = mcpTool.annotations?.readOnlyHint ?? false;
  const destructive = mcpTool.annotations?.destructiveHint ?? false;
  const description = truncateDescription(mcpTool.description ?? '');
  const alwaysLoad = mcpTool._meta?.['anthropic/alwaysLoad'] === true;

  const tool: AgentTool<Record<string, unknown>, unknown> = {
    name: fullName,
    // MCP 工具自带 description → 透传给模型(此前只用于 renderToolUseMessage,wire 上丢了)。
    ...(description ? { description } : {}),
    isMcp: true,
    mcpInfo: { serverName, toolName: mcpTool.name },
    searchHint: readSearchHint(mcpTool._meta),
    alwaysLoad,

    // schema: MCP 原样 JSON Schema（不转 zod）。
    inputJSONSchema: (mcpTool.inputSchema ?? { type: 'object' }) as JSONSchema,

    isEnabled: () => true,
    // 并发安全 / 只读都取 readOnlyHint（两个谓词同源）。
    isConcurrencySafe: () => readOnly,
    isReadOnly: () => readOnly,
    isDestructive: () => destructive,

    // 把闸: passthrough —— 决策交给 PERM 规则引擎。
    async checkPermissions(): Promise<PermissionResult> {
      return {
        behavior: 'passthrough',
        message: 'MCP tool requires permission.',
        decisionReason: { type: 'mcp', serverName, toolName: mcpTool.name },
      };
    },

    async call(
      input: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult<unknown>> {
      const meta = ctx.toolUseId
        ? { 'bc/toolUseId': ctx.toolUseId }
        : undefined;
      const result = await client.callTool(mcpTool.name, input, {
        signal: ctx.signal,
        meta,
      });
      return mapMcpResult(result);
    },

    mapResult(output: unknown, toolUseId: string): CoreEvent {
      return {
        type: 'tool_result',
        ts: Date.now(),
        source: fullName,
        payload: {
          toolUseId,
          isMcp: true,
          serverName,
          toolName: mcpTool.name,
          content: output,
        },
      };
    },

    // MCP 结果体可能很大 → 默认有界(DEFAULT_MCP_RESULT_BUDGET),由 LOOP 的全局
    // budget gate 兜底 head-tail 裁剪,防无界灌窗(移植 agentic_os 03.B)。host 可装配期覆写。
    maxResultSizeChars: DEFAULT_MCP_RESULT_BUDGET,

    renderToolUseMessage: () => description,
  };

  // 注入治理：async 模式且非 alwaysLoad → 声明延迟，交给 defer ENGINE + ToolSearch。
  if (opts?.deferMode === 'async' && !alwaysLoad) {
    tool.shouldDefer = () => true;
  }

  return tool;
}

/**
 * 批量: 拉取 server 全部工具并映射成 AgentTool[]。
 * 逐工具映射失败不应让整 server 崩 —— 失败工具被跳过（fail-open
 * per-tool,fail-closed 在 host 决定是否上报）。
 *
 * @param opts 注入治理（`deferMode`）透传给每个工具的映射。缺省 = 同步（原有行为），
 *             故 `mcpPack` 等既有 2-arg 调用方无需改动。
 */
export async function getMcpTools(
  client: MCPClient,
  serverName: string,
  opts?: MapMcpToolOptions,
): Promise<AgentTool<Record<string, unknown>, unknown>[]> {
  const mcpTools = await client.listTools();
  const out: AgentTool<Record<string, unknown>, unknown>[] = [];
  for (const t of mcpTools) {
    try {
      out.push(mapMcpToolToAgentTool(client, serverName, t, opts));
    } catch {
      // 单工具映射异常跳过（如 name 非法）—— 不连累同 server 其它工具。
      continue;
    }
  }
  return out;
}
