/** /resume —— 列出 / 恢复历史会话(018)。
 *  无参在 TUI 由 Repl.submit 截获 → 拉起会话选择页(故此处无参分支仅作非 TUI 兜底);
 *  带参 → ctx.resumeInto(id):恢复并把历史 transcript 回灌(替换)当前会话 + reseed 下一轮。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'resume',
  desc: '恢复历史会话(/resume [id];无参打开选择页)',
  run: async (ctx, args) => {
    const id = args.trim();
    if (!id) {
      // TUI 路径下 Repl.submit 已截获无参 /resume 拉起选择页;走到这里多为非 TUI / 直调,列表兜底。
      const ss = ctx.listSessions();
      if (!ss.length) {
        ctx.print('没有可恢复的会话。');
        return;
      }
      const rows = ss.map(
        (s) => `  ${s.id}  ${s.title ?? ''}  (${(s.sizeBytes / 1024).toFixed(1)}KB | ${new Date(s.mtimeMs).toLocaleString()})`,
      );
      ctx.print(`可恢复会话:\n${rows.join('\n')}\n用 /resume <id> 恢复。`);
      return;
    }
    const ok = await ctx.resumeInto(id);
    if (!ok) ctx.print(`❌ 未找到会话 ${id} 或其历史为空。`);
    // 成功提示由 doResume 内统一打印(含恢复条数),此处不重复。
  },
});
