/**
 * Thinking 消息视图 —— assistant 的 thinking 块 → dim 折叠;expanded 时全展开。
 *
 * thinking 块与 text 块同在 assistant 事件 content 里;它**不是**独立 AgentEvent.type,
 * 故不进 messages registry 占 'assistant' 键(那会顶掉 AssistantView)。Repl 在检测到
 * thinking 块时直接调本视图(可折叠,ctrl+o 控制 expanded)。
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { AgentEvent } from '../../contracts';
import { type MessageView } from './registry';

/** 抽 thinking 文本(assistant content 中 type==='thinking')。 */
export function thinkingText(ev: Extract<AgentEvent, { type: 'assistant' }>): string {
  const content = (ev.message.payload as { content?: Array<{ type: string; thinking?: string; text?: string }> })
    ?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking as string)
    .join('');
}

export const ThinkingView: MessageView = (p) => {
  if (p.item.kind !== 'assistant' || p.item.event.type !== 'assistant') return null;
  const text = thinkingText(p.item.event);
  if (!text) return null;
  if (!p.expanded) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    const preview = oneLine.length > 60 ? `${oneLine.slice(0, 55)}...` : oneLine;
    return (
      <Text color={p.theme.dim}>
        {'✻ thinking '}
        {preview}
        {' (ctrl+o 展开)'}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={p.theme.dim}>{'✻ thinking'}</Text>
      <Text color={p.theme.dim}>{text}</Text>
    </Box>
  );
};
