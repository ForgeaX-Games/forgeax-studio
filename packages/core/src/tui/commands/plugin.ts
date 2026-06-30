/** /plugin —— 列出已加载 plugin(023)。driver.listPlugins(→ listPlugins)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
import { renderExtensionRows } from './ext-render';

registerCommand({
  name: 'plugin',
  desc: '列出已加载 plugin',
  run: (ctx) => ctx.print(renderExtensionRows('plugin', ctx.listPlugins())),
});
