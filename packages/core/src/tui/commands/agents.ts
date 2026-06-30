/** /agents —— 列出可用子 agent(020)。driver.listAgents(→ inspectAgents)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'agents',
  desc: '列出可用子 agent',
  run: (ctx) => {
    const a = ctx.listAgents();
    if (!a.length) {
      ctx.print('无可用子 agent。');
      return;
    }
    ctx.print(
      a
        .map(
          (x) =>
            `- ${x.name} [${x.source}]${x.role ? ` - ${x.role}` : ''}\n  ${x.description}\n  工具:${x.tools.join(', ') || '(继承父侧)'}`,
        )
        .join('\n'),
    );
  },
});
