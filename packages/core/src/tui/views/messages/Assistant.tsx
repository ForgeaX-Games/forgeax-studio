/**
 * Assistant 消息视图 —— assistant 事件的 text 块走 Markdown。
 * 自注册 key='assistant'。读 TranscriptItem{kind:'assistant'} 的 event。
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import type { AgentEvent } from '../../contracts';
import { registerMessage, type MessageView } from './registry';
import { Markdown } from '../../components/Markdown';

/** 从 assistant 事件抽 text 块(对齐 cli/render.ts assistantText)。 */
export function assistantText(ev: Extract<AgentEvent, { type: 'assistant' }>): string {
  const content = (ev.message.payload as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

export const AssistantView: MessageView = (p) => {
  if (p.item.kind !== 'assistant' || p.item.event.type !== 'assistant') return null;
  const text = assistantText(p.item.event);
  if (!text) return null;
  return <Markdown>{text}</Markdown>;
};

registerMessage('assistant', AssistantView);
