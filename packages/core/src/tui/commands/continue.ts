/** /continue —— 续接 default 会话(018,= /resume default 的快捷)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'continue',
  desc: '续接 default 会话',
  run: async (ctx) => {
    const ok = await ctx.resume('default');
    ctx.print(ok ? '✅ 已续接 default 会话。' : 'ℹ️ 没有 default 会话历史可续接。');
  },
});
