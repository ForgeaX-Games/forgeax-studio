/** /mcp —— MCP server 状态(016)。driver.listMcp(→ inspectMcpServers 巡检)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'mcp',
  desc: '查看 MCP server 状态',
  run: async (ctx) => {
    const { servers, configErrors } = await ctx.listMcp();
    if (!servers.length && !configErrors.length) {
      ctx.print('未配置 MCP server。');
      return;
    }
    const lines = servers.map((s) => {
      const icon = s.status === 'connected' ? '✅' : s.status === 'auth-pending' ? '🔑' : '❌';
      const extra =
        s.status === 'connected'
          ? `${s.toolCount} 工具${s.deferred ? '(deferred)' : ''}`
          : (s.error ?? s.status);
      return `${icon} ${s.name} [${s.type}] - ${extra}`;
    });
    for (const e of configErrors) lines.push(`⚠️ 配置错误:${e}`);
    ctx.print(lines.join('\n'));
  },
});
