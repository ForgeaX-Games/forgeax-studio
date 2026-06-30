/** /exit(T6 转交)—— 退出(触发 driver dispose 后退出)。T0 已自注册可用。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
registerCommand({ name: 'exit', desc: '退出', run: (ctx) => ctx.exit() });
