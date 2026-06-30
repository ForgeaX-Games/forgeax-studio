/** /status —— 会话概览(024)。driver.getStatus 聚合 + listMcp 取已连数。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'status',
  desc: '会话概览',
  run: async (ctx) => {
    const s = ctx.getStatus();
    const mcp = await ctx.listMcp();
    const connected = mcp.servers.filter((x) => x.status === 'connected').length;
    ctx.print(
      [
        `模型:${s.model ?? '-'}`,
        `工作目录:${s.cwd ?? '-'}`,
        `会话:${s.sessionId ?? '临时会话'}${s.persistent ? '(可 --resume)' : ''}`,
        `权限模式:${s.permissionMode}`,
        `MCP:${connected}/${mcp.servers.length} 已连`,
        `轮次:${s.turns}`,
        `用量:${s.usage.totalTokens.toLocaleString()} tokens${s.usage.pricingKnown ? ` | $${s.usage.cost.totalUsd.toFixed(4)}` : ''}`,
      ].join('\n'),
    );
  },
});
