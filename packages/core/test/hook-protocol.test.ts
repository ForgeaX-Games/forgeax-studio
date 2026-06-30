/**
 * H3 —— hook stdin/stdout 线协议测试。
 *
 * 覆盖 eventToHookInput(core 事件 → stdin JSON)与 parseHookOutput
 * (stdout JSON → HookDecision)双向往返,含 fail-open 行为。
 */
import { test, expect, describe } from 'bun:test';
import { eventToHookInput, parseHookOutput } from '../src/capability/hooks/protocol';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent } from '../src/events/types';

describe('eventToHookInput', () => {
  test('PreToolUse 事件 → hook_event_name + tool_name + tool_input', () => {
    const event: CoreEvent = {
      type: CoreEventType.ToolCallRequested,
      payload: { toolName: 'Bash', toolUseId: 'tu_1', input: { command: 'ls' } },
      ts: 1,
    };
    const input = eventToHookInput(event, { sessionId: 's1', cwd: '/repo' });
    expect(input.hook_event_name).toBe('PreToolUse');
    expect(input.tool_name).toBe('Bash');
    expect(input.tool_input).toEqual({ command: 'ls' });
    expect(input.session_id).toBe('s1');
    expect(input.cwd).toBe('/repo');
    // PreToolUse 不应带 tool_response
    expect(input.tool_response).toBeUndefined();
  });

  test('PostToolUse 事件 → tool_response 从 payload.result', () => {
    const event: CoreEvent = {
      type: CoreEventType.ToolCallResult,
      payload: { toolUseId: 'tu_1', toolName: 'Bash', result: 'file.txt', isError: false },
      ts: 2,
    };
    const input = eventToHookInput(event);
    expect(input.hook_event_name).toBe('PostToolUse');
    expect(input.tool_name).toBe('Bash');
    expect(input.tool_response).toBe('file.txt');
  });

  test('UserPromptSubmit 事件 → prompt 字段', () => {
    const event: CoreEvent = {
      type: CoreEventType.UserPromptSubmit,
      payload: { prompt: '做个平台跳跃游戏', turn: 0 },
      ts: 3,
    };
    const input = eventToHookInput(event);
    expect(input.hook_event_name).toBe('UserPromptSubmit');
    expect(input.prompt).toBe('做个平台跳跃游戏');
  });

  test('Stop / SessionStart 名字映射正确', () => {
    expect(
      eventToHookInput({ type: CoreEventType.Stop, payload: { turn: 1 }, ts: 4 }).hook_event_name,
    ).toBe('Stop');
    expect(
      eventToHookInput({ type: CoreEventType.SessionStart, payload: {}, ts: 5 }).hook_event_name,
    ).toBe('SessionStart');
  });

  test('未知事件类型 → 回退到原始 event.type', () => {
    const input = eventToHookInput({ type: 'custom.weird', payload: {}, ts: 6 });
    expect(input.hook_event_name).toBe('custom.weird');
  });

  test('无 ctx 时不填 session_id / cwd', () => {
    const input = eventToHookInput({
      type: CoreEventType.ToolCallRequested,
      payload: { toolName: 'Read', toolUseId: 't', input: {} },
      ts: 7,
    });
    expect(input.session_id).toBeUndefined();
    expect(input.cwd).toBeUndefined();
  });

  test('transcript_path 经 ctx 透传', () => {
    const input = eventToHookInput(
      { type: CoreEventType.Stop, payload: { turn: 1 }, ts: 8 },
      { sessionId: 's', transcriptPath: '/tmp/t.jsonl' },
    );
    expect(input.transcript_path).toBe('/tmp/t.jsonl');
  });

  test('stop_hook_active:true 从 payload 透传(重入标记)', () => {
    const on = eventToHookInput({ type: CoreEventType.Stop, payload: { turn: 2, stopHookActive: true }, ts: 9 });
    expect(on.stop_hook_active).toBe(true);
    // 非重入(false/缺省)→ 不带该键(仅重入时为 true)。
    const off = eventToHookInput({ type: CoreEventType.Stop, payload: { turn: 2 }, ts: 10 });
    expect(off.stop_hook_active).toBeUndefined();
  });
});

describe('parseHookOutput', () => {
  test('decision=block + reason → block:true + reason', () => {
    const d = parseHookOutput('{"decision":"block","reason":"危险命令"}');
    expect(d.block).toBe(true);
    expect(d.reason).toBe('危险命令');
  });

  test('decision=approve → 不拦(无 block)', () => {
    const d = parseHookOutput('{"decision":"approve","reason":"ok"}');
    expect(d.block).toBeUndefined();
  });

  test('hookSpecificOutput.additionalContext → additionalContext', () => {
    const d = parseHookOutput(
      '{"hookSpecificOutput":{"additionalContext":"记得用 forgeax-engine"}}',
    ) as { additionalContext?: string };
    expect(d.additionalContext).toBe('记得用 forgeax-engine');
  });

  test('continue:false → continue:false', () => {
    const d = parseHookOutput('{"continue":false}') as { continue?: boolean };
    expect(d.continue).toBe(false);
  });

  test('systemMessage → systemMessage', () => {
    const d = parseHookOutput('{"systemMessage":"已切到安全模式"}') as { systemMessage?: string };
    expect(d.systemMessage).toBe('已切到安全模式');
  });

  test('组合输出 → 全部映射', () => {
    const d = parseHookOutput(
      '{"decision":"block","reason":"no","continue":false,"systemMessage":"sm","hookSpecificOutput":{"additionalContext":"ac"}}',
    ) as { block?: boolean; reason?: string; continue?: boolean; systemMessage?: string; additionalContext?: string };
    expect(d.block).toBe(true);
    expect(d.reason).toBe('no');
    expect(d.continue).toBe(false);
    expect(d.systemMessage).toBe('sm');
    expect(d.additionalContext).toBe('ac');
  });

  test('尾随空白鲁棒', () => {
    const d = parseHookOutput('  \n {"decision":"block"} \n\t ');
    expect(d.block).toBe(true);
  });

  test('纯文本(非 JSON)→ {} 放行', () => {
    expect(parseHookOutput('hello not json')).toEqual({});
  });

  test('空 stdout → {} 放行', () => {
    expect(parseHookOutput('')).toEqual({});
    expect(parseHookOutput('   \n ')).toEqual({});
  });

  test('半截 JSON → {} 放行', () => {
    expect(parseHookOutput('{"decision":"blo')).toEqual({});
  });

  test('JSON 但非对象(如数组/null)→ {} 放行', () => {
    expect(parseHookOutput('[1,2,3]')).toEqual({});
    expect(parseHookOutput('null')).toEqual({});
  });

  // ── PreToolUse permissionDecision 三态──────────────────────────────
  test('permissionDecision=allow → permissionDecision:allow,不 block', () => {
    const d = parseHookOutput('{"hookSpecificOutput":{"permissionDecision":"allow"}}') as {
      permissionDecision?: string;
      block?: boolean;
    };
    expect(d.permissionDecision).toBe('allow');
    expect(d.block).toBeUndefined();
  });

  test('permissionDecision=ask → permissionDecision:ask,不 block', () => {
    const d = parseHookOutput('{"hookSpecificOutput":{"permissionDecision":"ask"}}') as {
      permissionDecision?: string;
      block?: boolean;
    };
    expect(d.permissionDecision).toBe('ask');
    expect(d.block).toBeUndefined();
  });

  test('permissionDecision=deny → permissionDecision:deny + block + reason 取 permissionDecisionReason', () => {
    const d = parseHookOutput(
      '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"危险写盘"}}',
    ) as { permissionDecision?: string; block?: boolean; reason?: string };
    expect(d.permissionDecision).toBe('deny');
    expect(d.block).toBe(true);
    expect(d.reason).toBe('危险写盘');
  });

  test('非法 permissionDecision 值 → 忽略(不污染决议)', () => {
    const d = parseHookOutput('{"hookSpecificOutput":{"permissionDecision":"maybe"}}') as {
      permissionDecision?: string;
    };
    expect(d.permissionDecision).toBeUndefined();
  });
});
