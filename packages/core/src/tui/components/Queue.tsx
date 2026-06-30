/** Queue —— 展示排队中的待发消息(turn 进行中入队的)。纯叶子,无键盘捕获。
 *  空队列渲染 null;非空时按序号 + dim 样式逐条列出(单行裁剪避免刷屏)。
 *  (P5 迁移自 input/Queue.tsx,归 components/ 纯叶子。)
 *  Boundary(HOST 层):react + ink + 相对 import。 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';

/** 单行裁剪:把多行/超长队列项压成一行预览。 */
function preview(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

export function Queue(props: { items?: string[] }): React.ReactElement | null {
  const theme = useTheme();
  const items = props.items;
  if (!items?.length) return null;
  return (
    <Box flexDirection="column">
      {items.map((q, i) => (
        <Text key={i} color={theme.dim}>
          {`... ${i + 1}. ${preview(q)}`}
        </Text>
      ))}
    </Box>
  );
}
