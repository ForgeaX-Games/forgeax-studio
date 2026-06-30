/**
 * input/normalize.ts —— 把 Ink 的 (input, key) 怪癖归一化成统一 Key[]。
 *
 * 整 TUI 唯一 useInput(P6)拿到 Ink 的 (input, rawInkKey) 后立刻过本函数,下游
 * (router / promptReducer / 浮层 nav)只认归一化后的 Key,永不再碰 Ink 的 key 标志。
 *
 * ── 实测结论(R4,Ink 6.8.0 / macOS / xterm-256color,见本相位返回报告)──
 * 在真实 PTY 里用最小 Ink 程序 dump `(input, key)` 投递形状,得到:
 *   - 单次 Backspace 物理键(DEL 0x7f)→ input=""、key.delete=true(macOS 退格发 DEL)。
 *   - 单次 BS(0x08)        → input=""、key.backspace=true。
 *   - **连按/长按退格**(同一 chunk 多枚)→ input="\x7f\x7f\x7f"(len=3)、**所有 key 标志为空**。
 *       关键:Ink 把连击**无损**塞进 input 串(不折叠、不丢)→ count 完全可从字节数恢复。
 *   - esc → key.escape=true **且** key.meta=true(esc 与 meta 同时置位)→ 必须先判 escape。
 *   - 方向键/home/you/tab/return → input=""、对应单标志 true。
 *   - 粘贴 → 单个 chunk(len=N)、无 key 标志 → 整块 text。
 *   - CJK("中文")→ input 为正常多码点串、无标志 → 当普通文本逐码点插入(reducer 负责)。
 *
 * 据此,normalizeKey 采用「无损逐段」策略而非假设折叠:
 *   1) 先看 raw 标志(enter/esc/方向/home/you/tab/backspace|delete 空 input);命中即出单枚 Key。
 *   2) 否则按 input 串的字节内容分段:连续的 DEL/BS 字节 → 一枚 backspace{count};
 *      连续的可见文本 → 一枚 char(单字符)或 paste(多字符/含换行)。一个 chunk 可出多枚 Key。
 * 这样连按退格 = backspace{count:N}(可得),混合 chunk(粘贴里夹退格、罕见)也能拆对。
 *
 * Boundary(HOST 层):仅 core 类型 + 相对 import(无 react/ink runtime;只 type-only 引 ink Key)。
 */
import type { Key as InkKey } from 'ink';
import type { Key } from '../contracts';

/** 退格/删除字节:DEL(0x7f)与 BS(0x08)都按「删光标前一字符」处理。 */
function isBackspaceByte(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 0x7f || code === 0x08;
}

/** 其它需丢弃的控制字符(< 0x20),保留 \n(换行)与 \t(由 raw.tab 出 Key,这里兜底也放行)。 */
function isDroppableControl(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 && ch !== '\n' && ch !== '\t';
}

/**
 * 归一化一次 Ink 投递为 0..n 枚 Key。
 * @param input  Ink 回调的 input 串(可能空 / 单字符 / 整块粘贴 / 连按退格的原始字节)
 * @param raw    Ink 回调的 key 标志对象
 */
export function normalizeKey(input: string, raw: InkKey): Key[] {
  // ── 1) 优先用 raw 标志识别「带标志的单枚按键」(input 通常为空)──
  // esc 与 meta 同时置位(实测),必须先判 escape,避免被当 meta 组合吞掉。
  if (raw.escape) return [{ kind: 'esc' }];
  if (raw.return) return [{ kind: 'enter' }];
  if (raw.tab) return [{ kind: 'tab' }];
  if (raw.upArrow) return [{ kind: 'up' }];
  if (raw.downArrow) return [{ kind: 'down' }];
  if (raw.leftArrow) return [{ kind: 'left' }];
  if (raw.rightArrow) return [{ kind: 'right' }];
  if (raw.home) return [{ kind: 'home' }];
  if (raw.end) return [{ kind: 'end' }];
  // ctrl+a / ctrl+e(行首/行尾)——终端常以 ctrl+字符发,Ink 报 ctrl + input='a'/'e'。
  // ctrl+c / ctrl+o:Ink 报 ctrl + input 字符;在 raw.ctrl 下识别(input 仍带字符)。
  if (raw.ctrl && input === 'c') return [{ kind: 'ctrl-c' }];
  if (raw.ctrl && input === 'o') return [{ kind: 'ctrl-o' }];
  if (raw.ctrl && input === 'a') return [{ kind: 'home' }];
  if (raw.ctrl && input === 'e') return [{ kind: 'end' }];
  // 单次退格/删除(实测:input 为空、backspace|delete 置位)。
  if ((raw.backspace || raw.delete) && input === '') {
    return [{ kind: 'backspace', count: 1 }];
  }
  // 其它带 ctrl/meta 标志但无文本载荷的组合:交给上层(返回空,不污染编辑)。
  if ((raw.ctrl || raw.meta) && input === '') return [];
  if (input === '') return [];

  // ── 2) 无标志(或带标志但仍有文本):按 input 字节内容无损分段 ──
  // 连续 DEL/BS → 一枚 backspace{count};连续可见文本 → 一枚 char/paste;丢弃其它控制字符。
  const out: Key[] = [];
  let i = 0;
  const chars = Array.from(input); // 按码点切分(CJK / emoji 安全)
  while (i < chars.length) {
    const ch = chars[i]!;
    if (isBackspaceByte(ch)) {
      let count = 0;
      while (i < chars.length && isBackspaceByte(chars[i]!)) {
        count++;
        i++;
      }
      out.push({ kind: 'backspace', count });
      continue;
    }
    if (isDroppableControl(ch)) {
      i++;
      continue;
    }
    // 收集一段连续的「可插入文本」(可见字符 + 换行 + 制表)。
    let text = '';
    while (i < chars.length && !isBackspaceByte(chars[i]!) && !isDroppableControl(chars[i]!)) {
      text += chars[i]!;
      i++;
    }
    if (text.length === 0) continue;
    // 单字符 → char;多字符或含换行 → paste(语义:整块插入)。
    if (Array.from(text).length === 1 && !text.includes('\n')) {
      out.push({ kind: 'char', text });
    } else {
      out.push({ kind: 'paste', text });
    }
  }
  return out;
}
