/**
 * H1 — event catalog + payloads 测试。
 *
 * 验证 (a) 新增的 hook 生命周期 CoreEventType 成员存在且字符串值精确,
 * (b) 每个新事件的 CoreEventPayloads payload 形状可被类型化构造并断言字段。
 * 同时守住既有成员的 byte-stable(不被回归改坏)。
 */
import { test, expect, describe } from 'bun:test';
import { CoreEventType, type CoreEventPayloads } from '../src/events/events';

describe('CoreEventType — hook lifecycle 新成员', () => {
  test('每个新成员存在且字符串值精确', () => {
    expect(CoreEventType.SessionStart).toBe('session.start');
    expect(CoreEventType.SessionEnd).toBe('session.end');
    expect(CoreEventType.UserPromptSubmit).toBe('user_prompt.submit');
    expect(CoreEventType.PreCompact).toBe('compaction.pre');
    expect(CoreEventType.PostCompact).toBe('compaction.post');
    expect(CoreEventType.Notification).toBe('notification');
    expect(CoreEventType.Stop).toBe('stop');
    expect(CoreEventType.SubagentStop).toBe('subagent.stop');
  });

  test('既有成员保持 byte-stable', () => {
    expect(CoreEventType.TurnStart).toBe('turn.start');
    expect(CoreEventType.TurnEnd).toBe('turn.end');
    expect(CoreEventType.TurnAborted).toBe('turn.aborted');
    expect(CoreEventType.CapabilitiesResolved).toBe('capabilities.resolved');
    expect(CoreEventType.SystemPromptAssembled).toBe('system_prompt.assembled');
    expect(CoreEventType.ToolCallRequested).toBe('tool.requested');
    expect(CoreEventType.ToolCalled).toBe('tool.called');
    expect(CoreEventType.ToolCallResult).toBe('tool.result');
    expect(CoreEventType.CompactionApplied).toBe('compaction.applied');
    expect(CoreEventType.CompactionRevoked).toBe('compaction.revoked');
    expect(CoreEventType.CapabilityReloaded).toBe('capability.reloaded');
    expect(CoreEventType.SoulPackLoaded).toBe('soul.pack_loaded');
    expect(CoreEventType.RebirthInitiated).toBe('soul.rebirth_initiated');
    expect(CoreEventType.IdentityProjected).toBe('soul.identity_projected');
  });
});

describe('CoreEventPayloads — payload-shape smoke check', () => {
  test('SessionStart payload', () => {
    const p: CoreEventPayloads[typeof CoreEventType.SessionStart] = {
      sessionId: 's-1',
      cwd: '/tmp',
      source: 'cli',
    };
    expect(p.sessionId).toBe('s-1');
    expect(p.cwd).toBe('/tmp');
    expect(p.source).toBe('cli');
  });

  test('SessionEnd payload', () => {
    const p: CoreEventPayloads[typeof CoreEventType.SessionEnd] = {
      sessionId: 's-1',
      reason: 'user_exit',
    };
    expect(p.sessionId).toBe('s-1');
    expect(p.reason).toBe('user_exit');
  });

  test('UserPromptSubmit payload', () => {
    const p: CoreEventPayloads[typeof CoreEventType.UserPromptSubmit] = {
      prompt: 'hello',
      turn: 3,
    };
    expect(p.prompt).toBe('hello');
    expect(p.turn).toBe(3);
  });

  test('PreCompact payload', () => {
    const p: CoreEventPayloads[typeof CoreEventType.PreCompact] = {
      trigger: 'auto',
      tokenCount: 12345,
    };
    expect(p.trigger).toBe('auto');
    expect(p.tokenCount).toBe(12345);
  });

  test('PostCompact payload', () => {
    const p: CoreEventPayloads[typeof CoreEventType.PostCompact] = {
      coveredFrom: 0,
      coveredTo: 10,
    };
    expect(p.coveredFrom).toBe(0);
    expect(p.coveredTo).toBe(10);
  });

  test('Notification payload', () => {
    const p: CoreEventPayloads[typeof CoreEventType.Notification] = {
      message: 'permission needed',
      level: 'warn',
    };
    expect(p.message).toBe('permission needed');
    expect(p.level).toBe('warn');
  });

  test('Stop payload (镜像 stop.hook 形状)', () => {
    const p: CoreEventPayloads[typeof CoreEventType.Stop] = {
      turn: 5,
      preventStop: true,
      reason: 'still working',
    };
    expect(p.turn).toBe(5);
    expect(p.preventStop).toBe(true);
    expect(p.reason).toBe('still working');
  });

  test('SubagentStop payload', () => {
    const p: CoreEventPayloads[typeof CoreEventType.SubagentStop] = {
      agentId: 'iori',
      agentType: 'pillar',
      terminalReason: 'completed',
      turns: 4,
      toolCalls: 9,
    };
    expect(p.agentId).toBe('iori');
    expect(p.agentType).toBe('pillar');
    expect(p.terminalReason).toBe('completed');
    expect(p.turns).toBe(4);
    expect(p.toolCalls).toBe(9);
  });

  test('ToolCallResult 加宽:携带 PostToolUse 所需 toolName + result', () => {
    const p: CoreEventPayloads[typeof CoreEventType.ToolCallResult] = {
      toolUseId: 'tu-1',
      toolName: 'Read',
      result: { ok: true },
      isError: false,
    };
    expect(p.toolUseId).toBe('tu-1');
    expect(p.toolName).toBe('Read');
    expect(p.result).toEqual({ ok: true });
    expect(p.isError).toBe(false);

    // 原最小形状仍合法(byte-stable / backward-compatible)。
    const minimal: CoreEventPayloads[typeof CoreEventType.ToolCallResult] = {
      toolUseId: 'tu-2',
    };
    expect(minimal.toolUseId).toBe('tu-2');
  });
});
