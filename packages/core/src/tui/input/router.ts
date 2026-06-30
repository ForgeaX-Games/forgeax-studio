/**
 * input/router.ts —— 整 TUI 唯一输入路由(梁③:单 owner)的**纯**决策核。
 *
 * 设计:本文件**不调 useInput**。真正的唯一 useInput 由 P6 在 app/screen 挂,拿到
 * Ink 投递后:`normalizeKey(input, raw)` → 对每枚 Key 调 `routeKey(ctx, key)` → 得到一个
 * **声明式 InputAction**,P6 再据 action 执行副作用(改 prompt state / 切 mode / 提交 /
 * 关浮层 / 调 driver…)。这样编辑/导航/esc 语义全是纯函数,可单测,焦点打架结构性消失。
 *
 * 模式分发:
 *   - prompt → 编辑(promptReducer)/ 提交(enter,行尾 '\' 续行)/ '/'→开 command-menu /
 *              上下历史 / esc-esc(空则开 rewind,非空则清空)。
 *   - command-menu → 「编辑 + 菜单导航」混合态(routeCommandMenu):字符键仍走 edit 实时过滤,
 *     ↑↓/enter/tab/esc 叠加菜单语义。**不**当纯浮层(否则弹起后没法继续打字过滤)。
 *   - model-picker / rewind / permission → 委托给各浮层的 nav reducer
 *     (modelPickerReducer / 等),产出 move/select/close/none。
 *   - scroll → 视口滚动(todo-001 插槽);本期出 scroll action 占位,P6 可暂忽略。
 *
 * esc 语义集中一处:有浮层 → 关浮层(回 prompt);prompt 模式 esc-esc → 空则拉 rewind,
 * 非空则清空输入。单次 esc 在 prompt 且非空 → 记一次「待清」,200ms 内第二次 esc 才清(由 P6
 * 持双击计时;router 只产出 prompt-esc action,是否清由 P6 据 escArmed 决定)。
 *
 * Boundary(HOST 层):仅 core 类型 + 相对 import(无 react/ink runtime)。
 */
import type { InputMode } from '../contracts';
import type { Key, PromptState } from '../contracts';
import { promptReducer, deleteWordBefore } from './promptReducer';
import { isOverlayMode } from './mode';

/** router 决策需要的只读上下文(由 P6 从各 state 提供)。 */
export interface RouterCtx {
  mode: InputMode;
  prompt: PromptState;
  /** 浮层当前高亮下标(command-menu / model-picker / rewind / permission 共用)。 */
  overlayIndex: number;
  /** 浮层条目总数(同上)。 */
  overlayLength: number;
  /** prompt 模式下:上一次 esc 是否「已待清」(P6 据双击计时器置),决定本次 esc 是清空还是只 arm。 */
  escArmed: boolean;
  /** 是否有在飞 turn。busy 时单次 esc 直接打断(对齐 cc),不走双击 arm —— 否则首次 esc 像「卡住」。 */
  busy: boolean;
}

/** router 的声明式产出:P6 据此执行副作用。 */
export type InputAction =
  // 编辑输入框(替换 prompt state)。
  | { kind: 'edit'; next: PromptState }
  // 提交当前输入(value 不含末尾续行符)。
  | { kind: 'submit'; value: string }
  // 打开 command-menu(用户敲了 '/' 触发,filter 为 '/' 之后内容)。
  | { kind: 'open-command-menu'; next: PromptState }
  // 历史上/下一条。
  | { kind: 'history-prev' }
  | { kind: 'history-next' }
  // esc 在 prompt:armed=false → 仅 arm(等第二次);armed=true → 清空或开 rewind。
  | { kind: 'prompt-esc-arm' }
  | { kind: 'prompt-clear' }
  | { kind: 'open-rewind' }
  // 浮层导航结果(P6 据 mode 决定 select 的语义)。
  | { kind: 'overlay-move'; index: number }
  | { kind: 'overlay-select'; index: number }
  // 浮层勾选(question 多选题:空格切换当前高亮项;P6 据 mode 处理,其它模式忽略)。
  | { kind: 'overlay-toggle'; index: number }
  // tab 补全:把输入框填成高亮命令(command-menu 专用;P6 据 index 取命令名回填 prompt)。
  | { kind: 'overlay-complete'; index: number }
  | { kind: 'overlay-close' }
  // 滚动视口(todo-001 插槽)。
  | { kind: 'scroll'; delta: number }
  // ctrl-c(P6:空则退出,非空则清空/打断)。
  | { kind: 'interrupt' }
  // 无操作(吞掉、不改状态)。
  | { kind: 'none' };

/** 浮层 nav 的统一形状(与 overlays/CommandMenu.NavResult 同构;此处独立定义以免 router → overlays 反向依赖)。 */
function navReduce(index: number, length: number, key: Key): InputAction {
  if (key.kind === 'esc') return { kind: 'overlay-close' };
  if (length === 0) return { kind: 'none' };
  if (key.kind === 'up') return { kind: 'overlay-move', index: (index - 1 + length) % length };
  if (key.kind === 'down') return { kind: 'overlay-move', index: (index + 1) % length };
  if (key.kind === 'enter') return { kind: 'overlay-select', index };
  return { kind: 'none' };
}

/** prompt 模式分发。 */
function routePrompt(ctx: RouterCtx, key: Key): InputAction {
  const { prompt } = ctx;
  const cursor = Math.max(0, Math.min(prompt.cursor, Array.from(prompt.value).length));

  switch (key.kind) {
    case 'enter': {
      // 行尾恰为 '\' → 续行(去掉 '\' 换成 \n),否则提交。
      const arr = Array.from(prompt.value);
      if (cursor > 0 && arr[cursor - 1] === '\\') {
        const next = arr.slice(0, cursor - 1).join('') + '\n' + arr.slice(cursor).join('');
        return { kind: 'edit', next: { value: next, cursor } };
      }
      return { kind: 'submit', value: prompt.value };
    }
    case 'up':
      return { kind: 'history-prev' };
    case 'down':
      return { kind: 'history-next' };
    case 'esc':
      // turn 在飞:单次 esc 即打断在飞 turn(对齐 cc;不走双击 arm,否则首次 esc 像「卡住」)。
      if (ctx.busy) return { kind: 'interrupt' };
      // 空闲:armed → 决策(空输入开 rewind,非空清空);未 armed → 仅 arm 等第二次。
      if (!ctx.escArmed) return { kind: 'prompt-esc-arm' };
      return prompt.value.length === 0 ? { kind: 'open-rewind' } : { kind: 'prompt-clear' };
    case 'ctrl-c':
      return { kind: 'interrupt' };
    case 'ctrl-o':
      return { kind: 'none' }; // 留给 P6(展开/折叠思考等),router 不预设语义。
    case 'tab':
      return { kind: 'none' };
    case 'char': {
      // 在空输入处敲 '/' → 开命令菜单(同时把 '/' 插进去,filter 由 value 派生)。
      if (key.text === '/' && prompt.value.length === 0) {
        return { kind: 'open-command-menu', next: promptReducer(prompt, key) };
      }
      return { kind: 'edit', next: promptReducer(prompt, key) };
    }
    case 'paste':
    case 'backspace':
    case 'left':
    case 'right':
    case 'home':
    case 'end':
      return { kind: 'edit', next: promptReducer(prompt, key) };
    default:
      return { kind: 'none' };
  }
}

/**
 * command-menu 模式分发(混合态:输入框可编辑 + 菜单导航叠加)。
 *
 * `/` 弹起命令菜单后,继续敲字会**实时收窄**匹配(字符键 → edit,
 * value 变化由 P6 重算过滤列表),而不是把字符吞掉只能在全集里上下选。
 *   - 字符/粘贴/退格/左右/home/you → edit(重算过滤)。
 *   - ↑↓ → 在过滤后的列表里环形移高亮。
 *   - enter → 有匹配且未带参数(value 里没空格)→ 选中高亮命令执行;
 *             无匹配 / 已带参数(如 `/model sonnet`)→ 按原文提交,保住参数。
 *   - tab → 把输入框补全成高亮命令(overlay-complete)。
 *   - esc → 关菜单(P6:清掉前导 '/')。
 */
function routeCommandMenu(ctx: RouterCtx, key: Key): InputAction {
  const { overlayIndex: i, overlayLength: n, prompt } = ctx;
  switch (key.kind) {
    case 'esc':
      return { kind: 'overlay-close' };
    case 'up':
      return n === 0 ? { kind: 'none' } : { kind: 'overlay-move', index: (i - 1 + n) % n };
    case 'down':
      return n === 0 ? { kind: 'none' } : { kind: 'overlay-move', index: (i + 1) % n };
    case 'tab':
      return n === 0 ? { kind: 'none' } : { kind: 'overlay-complete', index: i };
    case 'enter':
      // 有唯一可选且未带参数 → 选中执行;无匹配 / 已带参数 → 按原文提交(保住 `/cmd args`)。
      if (n > 0 && !prompt.value.slice(1).includes(' ')) {
        return { kind: 'overlay-select', index: i };
      }
      return { kind: 'submit', value: prompt.value };
    case 'char':
    case 'paste':
    case 'backspace':
    case 'left':
    case 'right':
    case 'home':
    case 'end':
      return { kind: 'edit', next: promptReducer(prompt, key) };
    default:
      return { kind: 'none' };
  }
}

/**
 * resume-picker 模式分发(混合态:输入框复用为搜索框 + 列表导航叠加;对齐 command-menu)。
 *
 * 与 command-menu 唯一区别:不处理 '/' 前导 / tab 补全 —— 输入框内容**整串**即搜索词。
 *   - 字符/粘贴/退格/左右/home/you → edit(重算过滤)。
 *   - ↑↓ → 在过滤后的列表里环形移高亮。
 *   - enter → 选中当前高亮会话(空列表 → none,吞掉)。
 *   - esc → 关闭(P6:清掉搜索框)。
 */
function routeResumePicker(ctx: RouterCtx, key: Key): InputAction {
  const { overlayIndex: i, overlayLength: n, prompt } = ctx;
  switch (key.kind) {
    case 'esc':
      return { kind: 'overlay-close' };
    case 'up':
      return n === 0 ? { kind: 'none' } : { kind: 'overlay-move', index: (i - 1 + n) % n };
    case 'down':
      return n === 0 ? { kind: 'none' } : { kind: 'overlay-move', index: (i + 1) % n };
    case 'enter':
      return n === 0 ? { kind: 'none' } : { kind: 'overlay-select', index: i };
    case 'char':
    case 'paste':
    case 'backspace':
    case 'left':
    case 'right':
    case 'home':
    case 'end':
      return { kind: 'edit', next: promptReducer(prompt, key) };
    default:
      return { kind: 'none' };
  }
}

/**
 * question 模式分发(浮层导航 + 多选勾选 + 自填编辑混合态)。
 *
 * 选项列表末尾恒有一行「其它/自填」(由 P6 在 overlayLength 里 +1、在渲染里补)。约定
 * **自填行 = 最后一行(i === n-1)**。AskUserQuestion 工具弹起时:
 *   - ↑↓ 移高亮(含自填行)、enter 确认当前题、esc 跳过整组。
 *   - 高亮在**真选项**上:空格 = 勾选(多选;P6 对单选 no-op),其它字符吞掉(选项不可编辑)。
 *   - 高亮在**自填行**上:字符/退格/左右/home/you → edit(P6 写进该题自填缓冲,**非**聊天草稿);
 *     此时空格也算输入文本。
 * 不复用 navReduce —— 它既无 toggle、也无 edit 语义。ctx.prompt 由 P6 在自填行时喂入「自填缓冲」。
 */
function routeQuestion(ctx: RouterCtx, key: Key): InputAction {
  const { overlayIndex: i, overlayLength: n, prompt } = ctx;
  if (key.kind === 'esc') return { kind: 'overlay-close' };
  if (n === 0) return { kind: 'none' };
  const otherActive = i === n - 1; // 末行 = 自填行
  switch (key.kind) {
    case 'up':
      return { kind: 'overlay-move', index: (i - 1 + n) % n };
    case 'down':
      return { kind: 'overlay-move', index: (i + 1) % n };
    case 'enter':
      return { kind: 'overlay-select', index: i };
    case 'char':
      if (otherActive) return { kind: 'edit', next: promptReducer(prompt, key) }; // 含空格
      if (key.text === ' ') return { kind: 'overlay-toggle', index: i };
      return { kind: 'none' };
    case 'paste':
    case 'backspace':
    case 'left':
    case 'right':
    case 'home':
    case 'end':
      return otherActive ? { kind: 'edit', next: promptReducer(prompt, key) } : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/**
 * 路由一枚归一化 Key → 声明式 action(纯函数)。P6 据 action 执行副作用。
 */
export function routeKey(ctx: RouterCtx, key: Key): InputAction {
  // ctrl-c 在任何模式都先走中断语义(P6 决定退出/打断)。
  if (key.kind === 'ctrl-c') return { kind: 'interrupt' };

  // command-menu / resume-picker 是「编辑 + 导航」混合态,先于纯浮层分发(它们不在 OVERLAY_MODES)。
  if (ctx.mode === 'command-menu') return routeCommandMenu(ctx, key);
  if (ctx.mode === 'resume-picker') return routeResumePicker(ctx, key);
  // question 有 toggle 语义,自带分发(不在 OVERLAY_MODES、不走 navReduce)。
  if (ctx.mode === 'question') return routeQuestion(ctx, key);

  if (isOverlayMode(ctx.mode)) {
    return navReduce(ctx.overlayIndex, ctx.overlayLength, key);
  }
  if (ctx.mode === 'scroll') {
    if (key.kind === 'up') return { kind: 'scroll', delta: -1 };
    if (key.kind === 'down') return { kind: 'scroll', delta: 1 };
    if (key.kind === 'esc') return { kind: 'overlay-close' }; // 退出 scroll 回 prompt
    return { kind: 'none' };
  }
  // 默认:prompt
  return routePrompt(ctx, key);
}

/** 删词便捷(ctrl+w / alt+backspace 由 P6 识别后调,产出 edit action)。 */
export function routeDeleteWord(prompt: PromptState): InputAction {
  return { kind: 'edit', next: deleteWordBefore(prompt) };
}
