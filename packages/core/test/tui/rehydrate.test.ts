/**
 * walEventsToUiMessages —— WAL CoreEvent[] → 可渲染 UiMessage[] 的逆映射单测。
 *
 * 验证 /resume 回灌 transcript 的核心:落盘的 4 类有视图意义事件被映回与 live 同构的
 * AgentEvent(user/assistant/tool_call/tool_result),且能直接喂 reduceTranscript 渲染;
 * 其余生命周期事件(turn/stop/session/stage)被跳过。
 */
import { test, expect, describe } from 'bun:test';
import { walEventsToUiMessages } from '../../src/tui/transcript/rehydrate';
import { reduceTranscript } from '../../src/tui/transcript/reduce';
import type { SessionEntry, UiMessage } from '../../src/tui/contracts';
import type { CoreEvent } from '../../src/events/types';

/** 造一条 CoreEvent(ts/source 任意,fold/映射只看 type+payload)。 */
const ev = (type: string, payload: unknown): CoreEvent => ({ type, payload, ts: 0 } as CoreEvent);

/** UiMessage[] → SessionEntry[](与 Repl.toSessionLog 同口径)。 */
function toLog(msgs: UiMessage[]): SessionEntry[] {
  return msgs.map((m) =>
    m.kind === 'user' ? { kind: 'user', text: m.text } : { kind: 'event', event: m.event },
  );
}

describe('walEventsToUiMessages', () => {
  test('user_prompt.submit → user 条目', () => {
    const out = walEventsToUiMessages([ev('user_prompt.submit', { prompt: 'hello', turn: 0 })]);
    expect(out).toEqual([{ kind: 'user', text: 'hello' }]);
  });

  test('assistant.message → assistant 事件(message 持原 CoreEvent,payload.content 可读)', () => {
    const a = ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] });
    const out = walEventsToUiMessages([a]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('agent');
    const m = out[0] as Extract<UiMessage, { kind: 'agent' }>;
    expect(m.event.type).toBe('assistant');
    // message 即原事件 → reduce/渲染读 message.payload.content
    expect((m.event as { message: CoreEvent }).message.payload).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }],
    });
  });

  test('tool.requested → tool_call(toolName/toolUseId/input)', () => {
    const out = walEventsToUiMessages([
      ev('tool.requested', { toolName: 'bash', toolUseId: 'tu1', input: { command: 'ls' } }),
    ]);
    expect(out[0]).toEqual({
      kind: 'agent',
      event: { type: 'tool_call', toolName: 'bash', toolUseId: 'tu1', input: { command: 'ls' } },
    });
  });

  test('tool.result → tool_result(result 持原 CoreEvent,payload.isError 判错)', () => {
    const r = ev('tool.result', { toolUseId: 'tu1', toolName: 'bash', result: 'ok', isError: false });
    const out = walEventsToUiMessages([r]);
    const m = out[0] as Extract<UiMessage, { kind: 'agent' }>;
    expect(m.event.type).toBe('tool_result');
    expect((m.event as { toolUseId: string }).toolUseId).toBe('tu1');
    expect((m.event as { result: CoreEvent }).result.payload).toMatchObject({ isError: false });
  });

  test('生命周期/噪声事件被跳过', () => {
    const out = walEventsToUiMessages([
      ev('session.start', { sessionId: 's' }),
      ev('turn.start', { turn: 0 }),
      ev('user_prompt.submit', { prompt: 'q', turn: 0 }),
      ev('stage', { stage: 'x', turn: 0 }),
      ev('turn.end', { turn: 0 }),
      ev('stop', { turn: 0 }),
      ev('session.end', {}),
    ]);
    expect(out).toEqual([{ kind: 'user', text: 'q' }]);
  });

  test('端到端:WAL → UiMessage → reduceTranscript 配出工具卡 + 文本轮', () => {
    const events: CoreEvent[] = [
      ev('user_prompt.submit', { prompt: 'run ls', turn: 0 }),
      ev('tool.requested', { toolName: 'bash', toolUseId: 'tu1', input: { command: 'ls' } }),
      ev('tool.result', { toolUseId: 'tu1', toolName: 'bash', result: 'a.ts', isError: false }),
      ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
    ];
    const items = reduceTranscript(toLog(walEventsToUiMessages(events)));
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['user', 'tool', 'assistant']);
    const tool = items.find((i) => i.kind === 'tool') as Extract<(typeof items)[number], { kind: 'tool' }>;
    expect(tool.status).toBe('ok'); // tool_result 配对成功 → ok
    expect(tool.name).toBe('bash');
  });

  test('空事件流 → 空', () => {
    expect(walEventsToUiMessages([])).toEqual([]);
  });
});
