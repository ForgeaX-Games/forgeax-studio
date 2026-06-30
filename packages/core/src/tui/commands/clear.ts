/** /clear(T6 转交)—— 清空消息。T0 已自注册可用。
 *  Boundary(HOST 层):仅 core 相对 import。 */
import { registerCommand } from './registry';
registerCommand({ name: 'clear', desc: '清空消息', run: (ctx) => ctx.clear() });
