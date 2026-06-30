/**
 * User 消息视图 —— `›` 箭头 + 文本(无 "you" 标签)。
 * 自注册 key='user'。读 TranscriptItem{kind:'user'} 的 text。
 * Boundary(HOST 层):react + ink + 相对 import。
 *
 * ⚠️ 折行铁律:每个逻辑行渲染成**一个扁平、无子节点的 `<Text>`**,前缀(`› `/缩进)
 * 直接**拼进同一个字符串**——绝不嵌套 `<Text>`、绝不用 `<Box>` 并列「前缀+内容」。
 *   原因:Ink(yoga)对**含子节点的 `<Text>`** 在真 TTY 下做盒子宽度测量时会偏差,
 *   长行软折行时提前断行 → **行尾大段留白**(CJK 尤甚);并列 Box 还会让两段各自
 *   独立折行 → 单字符被甩到独立一行。扁平无子节点的纯字符串 Text 没有内部盒子,
 *   wrap-ansi 按显示宽度整体折行,内容连续、排满才断。
 * 代价:前缀与正文同色(user 自己的输入行,统一色完全可接受),换来折行 100% 正确。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { registerMessage, type MessageView } from './registry';

export const UserView: MessageView = (p) => {
  const text = p.item.kind === 'user' ? p.item.text : '';
  const lines = text.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        // 前缀直接拼进字符串:首行 `› `,续行两空格缩进。整行=一个扁平 Text,无子节点。
        const prefixed = (i === 0 ? '› ' : '  ') + line;
        return (
          <Text key={i} color={p.theme.text}>
            {prefixed}
          </Text>
        );
      })}
    </Box>
  );
};

registerMessage('user', UserView);
