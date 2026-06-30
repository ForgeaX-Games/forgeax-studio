/** /permissions —— 查看权限规则与模式,带参切模式(017)。
 *  driver.getPermissionRules / setPermissionMode。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
import { coercePermissionMode, PERMISSION_MODES } from '../../permission/inspect';

registerCommand({
  name: 'permissions',
  desc: '查看权限规则;/permissions <mode> 切模式',
  run: (ctx, args) => {
    const m = args.trim();
    if (m) {
      const want = coercePermissionMode(m);
      if (!want) {
        ctx.print(`无效模式 ${m}。可选:${PERMISSION_MODES.join(' / ')}`);
        return;
      }
      ctx.setPermissionMode(want);
      ctx.print(`已切换权限模式 -> ${want}`);
      return;
    }
    const v = ctx.getPermissionRules();
    const bucket = (label: string, arr: { display: string }[]): string =>
      arr.length ? `${label}:\n  ${arr.map((r) => r.display).join('\n  ')}` : `${label}:(空)`;
    ctx.print(
      [
        `权限模式:${v.mode}`,
        `概览:allow ${v.counts.allow} / ask ${v.counts.ask} / deny ${v.counts.deny}`,
        bucket('allow', v.allow),
        bucket('ask', v.ask),
        bucket('deny', v.deny),
      ].join('\n'),
    );
  },
});
