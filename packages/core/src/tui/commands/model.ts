/** /model <id>(T6 转交)—— 切下一轮 LLM 模型(整 context 重建,§0-D)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
registerCommand({
  name: 'model',
  desc: '切换 LLM 模型(下一轮生效)',
  run: (ctx, args) => {
    const id = args.trim();
    if (id) ctx.setModel(id);
  },
});
