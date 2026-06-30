/** /skills —— 列出已加载 skill(023)。driver.listSkills(→ listSkills)。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
import { renderExtensionRows } from './ext-render';

registerCommand({
  name: 'skills',
  desc: '列出已加载 skill',
  run: (ctx) => ctx.print(renderExtensionRows('skill', ctx.listSkills())),
});
