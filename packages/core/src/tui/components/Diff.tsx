/** Diff(T1)—— 行级红绿(diff 库 diffLines)+ wordLevel 预留(diffWords)。
 *  added → '+ ' / theme.diffAdd;removed → '- ' / theme.diffRemove;context → dim。
 *  wordLevel=true 时对「整体改动」走 diffWords 逐词上色(line-level 仍是 must-have)。
 *  Boundary(HOST 层):react + ink + diff + 相对 import。 */
import React from 'react';
import { Box, Text } from 'ink';
import { diffLines, diffWords } from 'diff';
import { useTheme } from '../providers/theme';

/** 去掉块尾多余换行,拆成行(保留空行)。 */
function toLines(value: string): string[] {
  const v = value.endsWith('\n') ? value.slice(0, -1) : value;
  return v.split('\n');
}

export function Diff(props: { oldText: string; newText: string; wordLevel?: boolean }): React.ReactElement {
  const theme = useTheme();

  // wordLevel:逐词上色(单行/小段更清晰),整体一段渲染。
  if (props.wordLevel) {
    const parts = diffWords(props.oldText, props.newText);
    return (
      <Box>
        <Text>
          {parts.map((p, i) => (
            <Text key={i} color={p.added ? theme.diffAdd : p.removed ? theme.diffRemove : theme.dim}>
              {p.value}
            </Text>
          ))}
        </Text>
      </Box>
    );
  }

  // line-level(默认且 must-have)。
  const changes = diffLines(props.oldText, props.newText);
  const rows: React.ReactNode[] = [];
  let key = 0;
  for (const ch of changes) {
    const sign = ch.added ? '+ ' : ch.removed ? '- ' : '  ';
    const color = ch.added ? theme.diffAdd : ch.removed ? theme.diffRemove : theme.dim;
    for (const line of toLines(ch.value)) {
      rows.push(
        <Text key={key++} color={color}>
          {sign}
          {line}
        </Text>,
      );
    }
  }
  return <Box flexDirection="column">{rows}</Box>;
}
