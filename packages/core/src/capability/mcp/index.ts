/**
 * MCP bridge barrel (C2 / MCP bridge).
 *
 * 对外导出: in-process transport、MCPClient 接缝、MCP→AgentTool 桥,以及把一个
 * MCP server 整体包成 `CapabilityPack` 的 `mcpPack`。host 把真 MCPClient（stdio /
 * SDK）注入 `mcpPack`,loader 即可像加载本地包一样把该 server 的工具灌进 registry。
 *
 * Boundary: 仅 import core-local。
 */
import type { CapabilityPack } from '../types';
import type { MCPClient } from './client';
import { getMcpTools, type MapMcpToolOptions } from './bridge';

export * from './transport';
export * from './client';
export * from './bridge';
export * from './config';
export * from './connect';
// M1 注入治理策略层(defer/sync 裁决) / M3 鉴权接缝 / M4 server→client 反向请求。
export * from './caps';
export * from './auth';
export * from './server-requests';
// 016 /mcp 命令的 A 层:连接态巡检(listMcp 数据生产方)。
export * from './inspect';

/**
 * 把一个已连接的 MCP server 包成 builtin 层的 `CapabilityPack`。
 *
 * 注意: `CapabilityPack.tools` 是同步数组,而 MCP tools/list 是异步的 —— 故
 * `mcpPack` 是 **async**,先拉取并映射完工具再返回 pack。host/loader 在发现期
 * await 它(MCP server 的连接/拉取本就在 loader 的异步发现流程里)。
 *
 * @param client host 注入的真实 MCP client。
 * @param server server 名（用于 buildMcpToolName / pack.name）。
 * @param opts   注入治理选项（M1）：`deferMode:'async'` → 该 server 的工具声明
 *   `shouldDefer`（首轮不上线，靠 ToolSearch 现取）；缺省 / `'sync'` → 首轮上线
 *   （原有行为，既有 2-arg 调用方零回归）。host 经 `caps.ts:decideMcpDeferMode`
 *   裁出每个 server 的模式后逐 server 传入。
 */
export async function mcpPack(
  client: MCPClient,
  server: string,
  opts?: MapMcpToolOptions,
): Promise<CapabilityPack> {
  const tools = await getMcpTools(client, server, opts);
  return {
    name: `mcp:${server}`,
    layer: 'builtin',
    tools,
  };
}
