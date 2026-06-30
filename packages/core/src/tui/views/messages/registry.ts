/**
 * 消息视图注册表(梁① 同源结构;by key:'user' / 'notice' / AgentEvent.type)。
 *
 * 渲染输入 = 梁② 的 TranscriptItem(已配对/已折叠):user/assistant/notice。
 * assistant 卡按其 event.type 分发('assistant' 走文本/思考);user/notice 走专键。
 * 未命中 → 内置 thin 兜底(dim 一行,永不抛)。
 *
 * Boundary(HOST 层):仅 core 相对 import + react/ink。
 */
import { createElement } from 'react';
import { Text } from 'ink';
import type { AgentEvent, ThemeTokens, TranscriptItem } from '../../contracts';

/** 消息视图输入:一条 TranscriptItem(user/assistant/notice)+ theme + 折叠态。 */
export interface MessageViewProps {
  item: Extract<TranscriptItem, { kind: 'user' } | { kind: 'assistant' } | { kind: 'notice' }>;
  theme: ThemeTokens;
  expanded?: boolean;
}
export type MessageView = (p: MessageViewProps) => React.ReactNode;

/** 分发键:'user' / 'notice' / AgentEvent['type'](assistant 等)。 */
export type MessageKey = 'user' | 'notice' | AgentEvent['type'];

const registry = new Map<string, MessageView>();

/** 从一条 item 解出分发键:user/notice 直用;assistant 用其 event.type。 */
export function messageKeyOf(item: MessageViewProps['item']): string {
  if (item.kind === 'user') return 'user';
  if (item.kind === 'notice') return 'notice';
  return item.event.type;
}

const thinDefault: MessageView = (p) => {
  const label = messageKeyOf(p.item);
  return createElement(Text, { color: p.theme.dim }, `- ${label}`);
};

export function registerMessage(key: MessageKey, view: MessageView): void {
  registry.set(key, view);
}

/** 命中或 thin 兜底(永不抛)。 */
export function resolveMessage(key: string): MessageView {
  return registry.get(key) ?? thinDefault;
}

/** 便捷:接收一条 item,内部解键后 resolve(查表唯一入口)。 */
export function resolveMessageByItem(item: MessageViewProps['item']): MessageView {
  return resolveMessage(messageKeyOf(item));
}
