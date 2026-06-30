/**
 * input/mode.ts —— 输入焦点模式(梁③:单 owner + mode 机)。
 *
 * 整个 TUI 只有一个 useInput(由 P6 在 app/screen 挂),按当前 InputMode 把归一化
 * 后的 Key 派给对应 handler(见 router.ts)。本文件只持有 mode 的真相 + 小工具,
 * 不含 React、不调 useInput。
 *
 * 契约冻结:InputMode 的取值集合在 contracts.ts(P1)定义,本文件 re-export 之,
 * 并提供「是否浮层模式」「默认模式」等纯判定,供 router 与 P6 共用。
 *
 * Boundary(HOST 层):仅相对 import + core 类型(无 react/ink)。
 */
import type { InputMode } from '../contracts';

export type { InputMode };

/** 进程启动 / 无浮层时的基础模式。 */
export const DEFAULT_MODE: InputMode = 'prompt';

/** 「浮层」模式集合:这些模式下 PromptInput 让位,键全部交给浮层的 nav reducer。
 *  prompt / scroll 不是浮层(prompt 在编辑、scroll 在滚视口)。
 *  command-menu 也**不在**此集合:它是「编辑 + 菜单导航」的混合态——输入框仍可见可编辑
 *  (敲字实时过滤命令),只是 ↑↓/enter/esc 叠加菜单语义(由 router 的 routeCommandMenu 处理),
 *  绝不把字符键吞给纯 nav,否则菜单一弹起就没法继续输入过滤。 */
const OVERLAY_MODES: ReadonlySet<InputMode> = new Set<InputMode>([
  'model-picker',
  'permission',
  'rewind',
  'remote-control',
]);

/** 当前 mode 是否为浮层模式(浮层独占输入、PromptInput 隐藏)。 */
export function isOverlayMode(mode: InputMode): boolean {
  return OVERLAY_MODES.has(mode);
}
