/** /compact —— 手动压缩上下文(014)。复用 driver.triggerCompact(→ runManualCompact)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'compact',
  desc: '手动压缩上下文(/compact [侧重指令])',
  run: async (ctx, args) => {
    const r = await ctx.triggerCompact(args.trim() || undefined);
    ctx.print(
      r.compacted
        ? `✅ 已压缩上下文${r.usedLLM ? '(LLM 摘要)' : '(L1 短路,未调 LLM)'}。`
        : 'ℹ️ 历史不足以压缩,已跳过。',
    );
  },
});
