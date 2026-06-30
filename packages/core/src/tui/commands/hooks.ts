/** /hooks —— 列出已注册 hooks(023)。driver.listHooks(→ listHooks)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
import { renderExtensionRows } from './ext-render';

registerCommand({
  name: 'hooks',
  desc: '列出已注册 hooks',
  run: (ctx) => ctx.print(renderExtensionRows('hook', ctx.listHooks())),
});
