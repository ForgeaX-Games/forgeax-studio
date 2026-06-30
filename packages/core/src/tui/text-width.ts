/**
 * 终端文本宽度工具(CJK 宽字符感知)—— TUI 共享。
 *
 * 终端里 CJK / 全角字符占 **2 列**,ASCII 占 1 列。Ink 的自动换行按字符数算(不感知宽度),
 * 故凡是要「对齐列 / 截断到固定宽 / 整行底色填充」的地方,都得用 `displayWidth` 而非 `.length`。
 *
 * Boundary(HOST 层):无依赖,纯函数。
 */

/** 字符串显示宽度(CJK/全角=2,其余=1)。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 右填充空格到显示宽度 width(已超宽则原样返回)。 */
export function padToWidth(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** 当前终端列宽(无法测得或过窄时回退 80)。 */
export function termWidth(): number {
  return process.stdout.columns && process.stdout.columns > 10 ? process.stdout.columns : 80;
}

/**
 * 把一段文本(空白/换行先折叠成单空格)按显示宽度 `width` 折行,**最多 `maxLines` 行**;
 * 若仍有剩余,末行以 `…` 截断。宽字符感知(不会把一个全角字劈成半列)。
 *
 * @returns 至多 maxLines 行字符串(每行显示宽度 <= width)。width<=0 / 空文本 → []。
 */
export function clampToLines(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return [];
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length === 0) return [];

  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  let idx = 0;
  while (idx < chars.length && lines.length < maxLines) {
    const ch = chars[idx]!;
    const w = displayWidth(ch);
    if (curW + w > width) {
      lines.push(cur);
      cur = '';
      curW = 0;
      continue; // 不前进 idx,当前字符换到下一行
    }
    cur += ch;
    curW += w;
    idx++;
  }
  if (lines.length < maxLines && cur !== '') lines.push(cur);

  // 还有剩余字符 → 末行加省略号(裁到能容下 `…`)。
  if (idx < chars.length && lines.length === maxLines) {
    let last = lines[maxLines - 1]!;
    while (last.length > 0 && displayWidth(last) + 1 > width) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}
