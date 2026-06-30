/**
 * remote/reply —— 一轮 AgentEvent 流折出最终 assistant 文本(远端中转出站半场)。
 */
import { test, expect, describe } from 'bun:test';
import type { AgentEvent } from '../../src/tui/contracts';
import { appendAssistantText, collectAssistantText } from '../../src/tui/remote/reply';

const assistant = (text: string): AgentEvent =>
  ({ type: 'assistant', message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text }] } } }) as AgentEvent;

describe('collectAssistantText', () => {
  test('拼接所有 assistant 文本块,忽略非 assistant 事件', () => {
    const stream: AgentEvent[] = [
      { type: 'turn_start', turn: 1 },
      assistant('Hello'),
      { type: 'stream', event: {} },
      assistant(', world'),
      { type: 'turn_end', turn: 1 },
    ];
    expect(collectAssistantText(stream)).toBe('Hello, world');
  });

  test('无 assistant 事件 → 空串', () => {
    expect(collectAssistantText([{ type: 'turn_start', turn: 1 }, { type: 'done', terminal: { reason: 'completed' } }])).toBe('');
  });

  test('appendAssistantText 增量等价于数组折叠', () => {
    const evs = [assistant('a'), assistant('b'), assistant('c')];
    let acc = '';
    for (const e of evs) acc = appendAssistantText(acc, e);
    expect(acc).toBe(collectAssistantText(evs));
    expect(acc).toBe('abc');
  });
});
