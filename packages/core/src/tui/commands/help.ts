/** /help(T6 转交)—— 列出所有命令。T0 已自注册可用。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand, listCommands } from './registry';
registerCommand({
  name: 'help',
  desc: '列出所有命令',
  run: (ctx) => {
    const lines = listCommands().map((c) => `/${c.name} - ${c.desc}`).join('\n');
    ctx.send(lines);
  },
});
