/** Code(T1)—— cli-highlight 语法高亮 + 语言探测 + 过宽截断。
 *  cli-highlight 返回 ANSI 字符串,Ink 直接透传(<Text>{ansi}</Text>)。
 *  背景色经 theme.codeBg(useTheme),不硬编码颜色。
 *  Boundary(HOST 层):react + ink + cli-highlight + 相对 import。 */
import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import { useTheme } from '../providers/theme';

/** 终端列宽(SSR / 非 TTY 兜底 80)。 */
function termColumns(): number {
  const c = process.stdout?.columns;
  return typeof c === 'number' && c > 0 ? c : 80;
}

/** 高亮一段代码;非法语法不抛(ignoreIllegals),未知语言自动探测。 */
function tryHighlight(code: string, lang?: string): string {
  try {
    return highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    return code; // 任何高亮异常都降级为原文,绝不崩。
  }
}

export function Code(props: { code: string; lang?: string }): React.ReactElement {
  const theme = useTheme();
  // 留 2 列给左右内边距,避免与边框/背景贴边。
  const width = Math.max(8, termColumns() - 2);
  const highlighted = tryHighlight(props.code.replace(/\n+$/, ''), props.lang);
  const lines = highlighted.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} backgroundColor={theme.codeBg} wrap="truncate-end">
          {/* 末尾补空格让背景铺满该行宽度(更像代码块)。 */}
          {clampToWidth(line, width)}
        </Text>
      ))}
    </Box>
  );
}

/** 已含 ANSI 的行:Ink 的 wrap="truncate-end" 会按可见宽度截断,这里只补底色尾随空白。 */
function clampToWidth(line: string, width: number): string {
  // 估算可见长度(剥 ANSI 转义)以决定补多少空格;不精确无妨,Ink 仍做硬截断。
  // eslint-disable-next-line no-control-regex
  const visible = line.replace(/\[[0-9;]*m/g, '').length;
  if (visible >= width) return line;
  return line + ' '.repeat(width - visible);
}
