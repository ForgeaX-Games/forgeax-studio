/**
 * reply.ts —— 把一轮 agent 的 AgentEvent 流折出「最终 assistant 文本」(纯函数)。
 *
 * 远端中转:某轮由远端消息触发时,要把 agent 的回复发回对端。回复正文 = 该轮所有
 * assistant 文本块拼接(与 driver/useAgent 的 turn 收集器、Repl.toHistory 同口径——
 * 此处收敛成单一可测真相,避免第三处重复实现该形状)。
 *
 * Boundary(HOST 层):仅 core 类型,无 react/ink。
 */
import type { AgentEvent } from '../contracts';

/** 把单条 AgentEvent 的 assistant 文本(若有)累加到 acc 上;非 assistant 事件原样返回 acc。
 *  供 runTurn 在事件流里增量收集(无需先攒成数组)。 */
export function appendAssistantText(acc: string, event: AgentEvent): string {
  if (event.type !== 'assistant') return acc;
  const content = (event.message?.payload as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return acc;
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  return acc + text;
}

/** 一轮事件流 → 最终 assistant 文本(增量收集器的数组形态,便于单测)。 */
export function collectAssistantText(events: AgentEvent[]): string {
  return events.reduce(appendAssistantText, '');
}
