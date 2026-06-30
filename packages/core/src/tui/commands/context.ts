/** /context —— 当前上下文占用(015)。driver.getContextStats(纯计算)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'context',
  desc: '查看当前上下文占用',
  run: (ctx) => {
    const s = ctx.getContextStats();
    ctx.print(
      [
        `上下文:${s.tokens.toLocaleString()} / ${s.effectiveWindow.toLocaleString()} tokens(有效窗口 ${s.percentOfEffective.toFixed(1)}%)`,
        `完整窗口:${s.contextWindow.toLocaleString()}(占 ${s.percentUsed.toFixed(1)}%)`,
        `距自动预压水位:${s.tokensToPreCompact.toLocaleString()} tokens${s.tokensToPreCompact < 0 ? '(已越过)' : ''}`,
      ].join('\n'),
    );
  },
});
