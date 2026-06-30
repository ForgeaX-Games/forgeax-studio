/** /plan —— 进入只读规划模式(021)。把权限模式切到 'plan';写类工具被拦,
 *  产出计划后用 ExitPlanMode 工具批准恢复执行。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';

registerCommand({
  name: 'plan',
  desc: '进入只读规划模式',
  run: (ctx) => {
    ctx.setPermissionMode('plan');
    ctx.print('🧭 已进入 plan(只读规划)模式:写类工具将被拦截。产出计划后用 ExitPlanMode 批准执行。');
  },
});
