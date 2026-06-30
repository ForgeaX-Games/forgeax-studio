/** /cost —— 本会话累计用量与费用(015)。driver.getUsage(累计 + 估费)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'cost',
  desc: '查看本会话累计用量与费用',
  run: (ctx) => {
    const u = ctx.getUsage();
    const lines = [
      `模型:${u.model ?? '-'}`,
      `Input:${u.inputTokens.toLocaleString()}  Output:${u.outputTokens.toLocaleString()}`,
      `Cache 写:${u.cacheCreationInputTokens.toLocaleString()}  Cache 读:${u.cacheReadInputTokens.toLocaleString()}`,
      `合计:${u.totalTokens.toLocaleString()} tokens`,
      u.pricingKnown
        ? `估算费用:$${u.cost.totalUsd.toFixed(4)}`
        : '估算费用:该模型无内置单价,仅显示 token。',
    ];
    ctx.print(lines.join('\n'));
  },
});
