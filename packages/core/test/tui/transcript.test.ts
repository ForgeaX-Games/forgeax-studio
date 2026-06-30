/**
 * P2 — reduceTranscript 纯函数单测(梁② 的心脏)。
 *
 * 覆盖(地基方案 §8 P2 单测要点):
 *   - 空日志 → []
 *   - 纯文本轮(user + assistant)
 *   - tool_call 无 result → running
 *   - 配对成功 → ok
 *   - 配对 error(isError / ok===false 两种 payload)
 *   - turn_aborted → notice(warn)
 *   - done(非 completed)→ notice;done(completed/handed_off)→ 无条目
 *   - 多轮交错(多 tool_call/result + 文本)
 *   - 过滤事件(stream/stage/turn_start/turn_end)不落条目
 *   - 别名不在 reduce 解析:tool item.name 保留事件原名(`Bash`)
 *
 * 纯函数测试,不依赖 react/ink。
 */
import { test, expect, describe } from 'bun:test';
import { reduceTranscript, safeFlushBoundary } from '../../src/tui/transcript/reduce';
import type { SessionEntry, AgentEvent } from '../../src/tui/transcript/items';
import type { CoreEvent } from '../../src/events/types';

// ── 构造助手 ────────────────────────────────────────────────────────────────
const user = (text: string): SessionEntry => ({ kind: 'user', text });
const ev = (event: AgentEvent): SessionEntry => ({ kind: 'event', event });

function assistantEvent(text: string): AgentEvent {
  const message: CoreEvent = {
    type: 'message',
    ts: 0,
    payload: { content: [{ type: 'text', text }] },
  };
  return { type: 'assistant', message };
}

function toolCall(toolUseId: string, toolName: string, input: unknown): AgentEvent {
  return { type: 'tool_call', toolUseId, toolName, input };
}

function toolResult(toolUseId: string, payload: unknown): AgentEvent {
  const result: CoreEvent = { type: 'tool_result', ts: 0, payload };
  return { type: 'tool_result', toolUseId, result };
}

describe('reduceTranscript', () => {
  test('空日志 → []', () => {
    expect(reduceTranscript([])).toEqual([]);
  });

  test('纯文本轮:user + assistant', () => {
    const items = reduceTranscript([user('hi'), ev(assistantEvent('hello'))]);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ kind: 'user', id: 0, text: 'hi' });
    expect(items[1]!.kind).toBe('assistant');
    expect(items[1]!.id).toBe(1);
  });

  test('tool_call 无 result → running', () => {
    const items = reduceTranscript([ev(toolCall('t1', 'bash', { command: 'ls' }))]);
    expect(items.length).toBe(1);
    const it = items[0]!;
    expect(it.kind).toBe('tool');
    if (it.kind === 'tool') {
      expect(it.status).toBe('running');
      expect(it.name).toBe('bash');
      expect(it.toolUseId).toBe('t1');
      expect(it.input).toEqual({ command: 'ls' });
      expect(it.result).toBeUndefined();
      expect(it.isError).toBeUndefined();
    }
  });

  test('配对成功 → ok(单卡,不新增条目)', () => {
    const items = reduceTranscript([
      ev(toolCall('t1', 'read_file', { path: '/x' })),
      ev(toolResult('t1', { ok: true, content: 'data' })),
    ]);
    expect(items.length).toBe(1); // result 回填进同一张卡,不新增。
    const it = items[0]!;
    if (it.kind === 'tool') {
      expect(it.status).toBe('ok');
      expect(it.isError).toBe(false);
      expect(it.result).toEqual({ ok: true, content: 'data' });
    }
  });

  test('配对 error:payload.isError===true', () => {
    const items = reduceTranscript([
      ev(toolCall('t1', 'bash', {})),
      ev(toolResult('t1', { isError: true, message: 'boom' })),
    ]);
    const it = items[0]!;
    if (it.kind === 'tool') {
      expect(it.status).toBe('error');
      expect(it.isError).toBe(true);
    }
  });

  test('配对 error:payload.ok===false', () => {
    const items = reduceTranscript([
      ev(toolCall('t1', 'bash', {})),
      ev(toolResult('t1', { ok: false })),
    ]);
    const it = items[0]!;
    if (it.kind === 'tool') {
      expect(it.status).toBe('error');
      expect(it.isError).toBe(true);
    }
  });

  test('turn_aborted 仅作中断标记 → 不落条目(notice 统一由 done 产,避免双条「已中断」)', () => {
    const items = reduceTranscript([ev({ type: 'turn_aborted', turn: 1 })]);
    expect(items).toEqual([]);
  });

  // 回归:kernel 中断必发 turn_aborted + done(aborted_*) 一对 —— 只能渲染一条「已中断」。
  test('turn_aborted + done(aborted_streaming) 配对 → 只出一条「已中断」', () => {
    const items = reduceTranscript([
      ev({ type: 'turn_aborted', turn: 1 }),
      ev({ type: 'done', terminal: { reason: 'aborted_streaming' } }),
    ]);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ kind: 'notice', level: 'warn', text: '已中断' });
  });

  // 回归:unrecoverable_tool_error 路径配的是 turn_aborted + done(error) —— 只出「异常终止」,不叠「已中断」。
  test('turn_aborted + done(unrecoverable_tool_error) → 只出一条「异常终止」', () => {
    const items = reduceTranscript([
      ev({ type: 'turn_aborted', turn: 1 }),
      ev({ type: 'done', terminal: { reason: 'unrecoverable_tool_error' } }),
    ]);
    expect(items.length).toBe(1);
    const it = items[0]!;
    expect(it.kind).toBe('notice');
    if (it.kind === 'notice') {
      expect(it.level).toBe('error');
      expect(it.text).toContain('unrecoverable_tool_error');
    }
  });

  test('done(completed)→ 无条目', () => {
    const items = reduceTranscript([ev({ type: 'done', terminal: { reason: 'completed' } })]);
    expect(items).toEqual([]);
  });

  test('done(handed_off)→ 无条目', () => {
    const items = reduceTranscript([ev({ type: 'done', terminal: { reason: 'handed_off' } })]);
    expect(items).toEqual([]);
  });

  test('done(model_error)→ notice(error)', () => {
    const items = reduceTranscript([ev({ type: 'done', terminal: { reason: 'model_error' } })]);
    expect(items.length).toBe(1);
    const it = items[0]!;
    expect(it.kind).toBe('notice');
    if (it.kind === 'notice') {
      expect(it.level).toBe('error');
      expect(it.text).toContain('model_error');
    }
  });

  test('done(aborted_tools)→ notice(warn)', () => {
    const items = reduceTranscript([ev({ type: 'done', terminal: { reason: 'aborted_tools' } })]);
    const it = items[0]!;
    if (it.kind === 'notice') {
      expect(it.level).toBe('warn');
    }
  });

  test('done(max_turns)→ notice(warn)', () => {
    const items = reduceTranscript([ev({ type: 'done', terminal: { reason: 'max_turns' } })]);
    const it = items[0]!;
    if (it.kind === 'notice') {
      expect(it.level).toBe('warn');
      expect(it.text).toContain('max_turns');
    }
  });

  test('过滤事件:stream/stage/turn_start/turn_end 不落条目', () => {
    const items = reduceTranscript([
      ev({ type: 'turn_start', turn: 1 }),
      ev({ type: 'stage', stage: 'provider_call', turn: 1 }),
      ev({ type: 'stream', event: {} }),
      ev({ type: 'turn_end', turn: 1, usageContextRatio: 0.5 }),
    ]);
    expect(items).toEqual([]);
  });

  test('别名不在 reduce 解析:tool item.name 保留事件原名(Bash)', () => {
    const items = reduceTranscript([ev(toolCall('t1', 'Bash', { command: 'ls' }))]);
    const it = items[0]!;
    if (it.kind === 'tool') {
      expect(it.name).toBe('Bash'); // 不解析成 bash;P4 渲染时才经 toolMeta 解。
    }
  });

  test('孤儿 tool_result(无对应 call)→ 丢弃', () => {
    const items = reduceTranscript([ev(toolResult('ghost', { ok: true }))]);
    expect(items).toEqual([]);
  });

  test('多轮交错:文本 + 多 tool_call/result + 中间穿插过滤事件', () => {
    const log: SessionEntry[] = [
      user('do A and B'),
      ev({ type: 'turn_start', turn: 1 }),
      ev(assistantEvent('working')),
      ev(toolCall('t1', 'bash', { command: 'a' })),
      ev(toolCall('t2', 'read_file', { path: '/b' })),
      ev({ type: 'stream', event: {} }),
      ev(toolResult('t1', { ok: true })),
      ev(toolResult('t2', { isError: true })),
      ev(assistantEvent('done')),
      ev({ type: 'turn_end', turn: 1 }),
      ev({ type: 'done', terminal: { reason: 'completed' } }),
    ];
    const items = reduceTranscript(log);
    // 期望条目:user, assistant(working), tool t1, tool t2, assistant(done)。
    expect(items.length).toBe(5);
    expect(items[0]!.kind).toBe('user');
    expect(items[1]!.kind).toBe('assistant');
    const t1 = items[2]!;
    const t2 = items[3]!;
    expect(t1.kind).toBe('tool');
    expect(t2.kind).toBe('tool');
    if (t1.kind === 'tool') expect(t1.status).toBe('ok');
    if (t2.kind === 'tool') {
      expect(t2.status).toBe('error');
      expect(t2.isError).toBe(true);
    }
    expect(items[4]!.kind).toBe('assistant');
  });

  test('id 取自 log 下标(稳定 key,回填不改 id)', () => {
    const items = reduceTranscript([
      ev(toolCall('t1', 'bash', {})), // 下标 0
      ev(toolResult('t1', { ok: true })), // 下标 1,但回填进 0 号卡
    ]);
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(0); // 卡片 id 仍是 call 的下标 0。
  });
});

describe('safeFlushBoundary', () => {
  test('空日志 → 0', () => {
    expect(safeFlushBoundary([])).toBe(0);
  });

  test('纯文本(无工具)→ 全可提交', () => {
    const log = [user('hi'), ev(assistantEvent('a')), ev(assistantEvent('b'))];
    expect(safeFlushBoundary(log)).toBe(3);
  });

  test('running 工具 → 停在该 call 之前(不冻结 running 卡)', () => {
    // 0 user, 1 assistant, 2 tool_call(running) → 边界=2,卡片留在 live。
    const log = [user('hi'), ev(assistantEvent('a')), ev(toolCall('t1', 'bash', {}))];
    expect(safeFlushBoundary(log)).toBe(2);
  });

  test('工具配对后边界跨过整张卡 + 其后文本', () => {
    const log = [
      user('hi'),
      ev(toolCall('t1', 'bash', {})),
      ev(toolResult('t1', { ok: true })),
      ev(assistantEvent('done')),
    ];
    expect(safeFlushBoundary(log)).toBe(4);
  });

  test('多工具:仅当全部配对才前进;有一个未配对则停在最早 open 处', () => {
    // call A, call B, result A —— B 仍 open → 边界停在 A 之前(=1)。
    const log = [
      user('hi'),
      ev(toolCall('A', 'bash', {})),
      ev(toolCall('B', 'bash', {})),
      ev(toolResult('A', { ok: true })),
    ];
    expect(safeFlushBoundary(log)).toBe(1);
    // 补上 B 的 result → 全配对,边界到末尾。
    const log2 = [...log, ev(toolResult('B', { ok: true }))];
    expect(safeFlushBoundary(log2)).toBe(5);
  });

  test('append 单调不退(随日志增长边界只增不减)', () => {
    const base = [user('hi'), ev(toolCall('t1', 'bash', {})), ev(toolResult('t1', {}))];
    const b1 = safeFlushBoundary(base);
    const b2 = safeFlushBoundary([...base, ev(toolCall('t2', 'bash', {}))]); // 新 running
    expect(b2).toBeGreaterThanOrEqual(b1);
  });

  test('孤儿 result(无对应 call)不拉低边界', () => {
    const log = [user('hi'), ev(toolResult('ghost', { ok: true }))];
    expect(safeFlushBoundary(log)).toBe(2);
  });
});
