/** /doctor —— 环境健康自检(024)。driver.runDoctor(provider 连通 / MCP 可达)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'doctor',
  desc: '环境健康自检',
  run: async (ctx) => {
    ctx.print('🩺 正在自检...');
    const r = await ctx.runDoctor();
    const icon = (st: string): string => (st === 'ok' ? '✅' : st === 'warn' ? '⚠️' : '❌');
    const lines = r.checks.map(
      (c) => `${icon(c.status)} [${c.category}] ${c.label}${c.detail ? ` - ${c.detail}` : ''}`,
    );
    ctx.print(`${lines.join('\n')}\n\n${r.healthy ? '✅ 全部健康' : '❌ 存在问题,见上'}`);
  },
});
