/**
 * Notice 消息视图 —— 梁② reduceTranscript 把 done(非 completed)/turn_aborted/错误
 * 折成 TranscriptItem{kind:'notice'; level}。本视图按 level 上色:
 *   error → 红 ✗ / warn → 黄 ■ / info → dim ·
 * 自注册 key='notice'。读 TranscriptItem{kind:'notice'} 的 level + text。
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { registerMessage, type MessageView } from './registry';

export const NoticeView: MessageView = (p) => {
  if (p.item.kind !== 'notice') return null;
  const { level, text } = p.item;
  const color = level === 'error' ? p.theme.error : level === 'warn' ? p.theme.warning : p.theme.dim;
  const mark = level === 'error' ? 'x ' : level === 'warn' ? '! ' : '- ';
  return (
    <Box>
      <Text color={color}>
        {mark}
        {text}
      </Text>
    </Box>
  );
};

registerMessage('notice', NoticeView);
