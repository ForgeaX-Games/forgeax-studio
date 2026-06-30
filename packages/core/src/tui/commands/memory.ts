/** /memory —— 查看记忆条目 + 索引路径(022)。driver.listMemory(→ listMemory)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'memory',
  desc: '查看记忆条目',
  run: (ctx) => {
    const m = ctx.listMemory();
    const head = `记忆目录:${m.memoryDir}\n索引:${m.indexPath}${m.indexExists ? '' : '(不存在)'}`;
    if (!m.entries.length) {
      ctx.print(`${head}\n(无记忆条目)`);
      return;
    }
    const rows = m.entries.map((e) => `- ${e.name ?? e.filename}${e.description ? ` - ${e.description}` : ''}`);
    ctx.print(`${head}\n${rows.join('\n')}`);
  },
});
