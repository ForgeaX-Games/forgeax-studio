/**
 * input/promptReducer.ts —— 输入框编辑纯函数(梁③)。
 *
 * 不可变 reduce:(PromptState, Key) → PromptState。多行 / 光标 / 删词 / 粘贴全在此,
 * 无 React、无 useInput、无副作用 → 可被单测逐条钉死(连按退格 / 粘贴 / CJK 光标 / 删词)。
 *
 * 处理的 Key（编辑域）:
 *   - char / paste → 在光标处插入文本(paste 含换行原样保留)。
 *   - backspace{count} → 删光标前 count 个字符(连按退格 = 一枚 count Key,一次删够)。
 *   - left / right / home / end → 移动光标(按码点;CJK 一格一码点)。
 * 不处理的 Key(交给 router / P6):enter(提交或续行)、esc、up/down(历史)、tab、ctrl-*、paste-image。
 * 删词(ctrl+w / alt+backspace)由 router 归一成 Key 后调本文件的 deleteWord 辅助,或 P6 直接调;
 * 见 deleteWordBefore 导出。
 *
 * 约定:cursor 是「码点偏移」(0..len),len = Array.from(value).length。所有切片按码点做,
 * 保证 CJK / emoji 不被半路截断、光标列号正确。
 *
 * Boundary(HOST 层):仅 core 类型 + 相对 import(无 react/ink)。
 */
import type { Key, PromptState } from '../contracts';

/** value 的码点数组(供按码点切片;CJK / emoji 安全)。 */
function cps(value: string): string[] {
  return Array.from(value);
}

/** 把 [from,to) 码点区间替换为 insert,返回新值与新光标(落在插入末尾)。 */
function splice(value: string, from: number, to: number, insert: string): PromptState {
  const arr = cps(value);
  const next = arr.slice(0, from).join('') + insert + arr.slice(to).join('');
  return { value: next, cursor: from + cps(insert).length };
}

/** 从 pos 向左找「词」起点:先跳尾随空白,再吃掉非空白(用于删词)。 */
function wordStart(value: string, pos: number): number {
  const arr = cps(value);
  let i = pos;
  while (i > 0 && /\s/.test(arr[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(arr[i - 1]!)) i--;
  return i;
}

/** 删词(光标前一词);供 router/P6 在 ctrl+w / alt+backspace 时调。纯函数。 */
export function deleteWordBefore(s: PromptState): PromptState {
  const pos = clampCursor(s);
  if (pos === 0) return { value: s.value, cursor: 0 };
  const start = wordStart(s.value, pos);
  return splice(s.value, start, pos, '');
}

/** 把可能越界的 cursor 夹到 [0, len]。 */
function clampCursor(s: PromptState): number {
  const len = cps(s.value).length;
  return Math.max(0, Math.min(s.cursor, len));
}

/**
 * 编辑 reducer。对未知/非编辑 Key 原样返回(no-op),由 router 处理。
 */
export function promptReducer(s: PromptState, k: Key): PromptState {
  const pos = clampCursor(s);
  const len = cps(s.value).length;

  switch (k.kind) {
    case 'char':
    case 'paste': {
      const text = k.text ?? '';
      if (text.length === 0) return { value: s.value, cursor: pos };
      return splice(s.value, pos, pos, text);
    }
    case 'backspace': {
      const count = Math.max(1, k.count ?? 1);
      const from = Math.max(0, pos - count);
      if (from === pos) return { value: s.value, cursor: pos };
      return splice(s.value, from, pos, '');
    }
    case 'left':
      return { value: s.value, cursor: Math.max(0, pos - 1) };
    case 'right':
      return { value: s.value, cursor: Math.min(len, pos + 1) };
    case 'home':
      return { value: s.value, cursor: 0 };
    case 'end':
      return { value: s.value, cursor: len };
    default:
      // enter / esc / up / down / tab / ctrl-* → 非编辑域,no-op(router 处理)。
      return { value: s.value, cursor: pos };
  }
}

/** 把光标线性码点偏移映射成 (行号, 列号),供多行渲染叠光标块。 */
export function lineColOf(value: string, cursor: number): { line: number; col: number } {
  const arr = cps(value);
  let line = 0;
  let col = 0;
  const stop = Math.max(0, Math.min(cursor, arr.length));
  for (let i = 0; i < stop; i++) {
    if (arr[i] === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}
