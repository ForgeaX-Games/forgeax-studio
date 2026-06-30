/**
 * m1-t1 — TeamMessage 判别式 union 自写校验器测试(TDD red→green)。
 *
 * 覆盖 AC-01(8 成员 union)+ AC-02(校验脚本正反双向):
 *   - 8 成员各一条合法样本 → 通过(ok:true);
 *   - ≥1 条非法样本(缺 kind / 未知 kind / 成员必填字段缺失)→ 被拒(ok:false + 结构化错误)。
 *
 * Boundary: 仅 import core-local 契约 + bun:test。core src/ 禁 zod(AC-14)。
 */
import { test, expect, describe } from 'bun:test';
import { validateTeamMessage, type TeamMessage } from './team-message';

// ─── 8 成员各一条合法样本 ─────────────────────────────────────────────────────

const legalSamples: Record<TeamMessage['kind'], unknown> = {
  text: { kind: 'text', from: 'iori', to: 'forge', text: 'design pillar drafted', summary: 'pillar done' },
  idle_notification: {
    kind: 'idle_notification',
    from: 'iori',
    to: 'forge',
    state: 'available',
    completedTaskId: 'team-pillar',
    completedStatus: 'done',
  },
  permission_request: {
    kind: 'permission_request',
    from: 'iori',
    to: 'forge',
    requestId: 'req-1',
    toolName: 'Bash',
    input: { cmd: 'rm -rf /tmp/x' },
  },
  permission_response: {
    kind: 'permission_response',
    from: 'forge',
    to: 'iori',
    requestId: 'req-1',
    decision: 'allow',
  },
  plan_approval: {
    kind: 'plan_approval',
    from: 'iori',
    to: 'forge',
    planId: 'plan-1',
    decision: 'approve',
  },
  shutdown: {
    kind: 'shutdown',
    from: 'forge',
    to: 'iori',
    phase: 'request',
  },
  task_assignment: {
    kind: 'task_assignment',
    from: 'forge',
    to: 'iori',
    taskId: 'team-pillar',
  },
  mode_set: {
    kind: 'mode_set',
    from: 'forge',
    to: 'iori',
    mode: 'plan',
  },
};

describe('validateTeamMessage — 8 legal members accepted', () => {
  for (const [kind, sample] of Object.entries(legalSamples)) {
    test(`legal: ${kind}`, () => {
      const res = validateTeamMessage(sample);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.kind).toBe(kind as TeamMessage['kind']);
      }
    });
  }
});

// ─── 非法样本被拒(≥1,这里覆盖多类) ────────────────────────────────────────

describe('validateTeamMessage — illegal samples rejected', () => {
  test('missing kind', () => {
    const res = validateTeamMessage({ from: 'a', to: 'b', text: 'hi' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });

  test('unknown kind', () => {
    const res = validateTeamMessage({ kind: 'bogus_kind', from: 'a', to: 'b' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toContain('kind');
  });

  test('text missing required field (text)', () => {
    const res = validateTeamMessage({ kind: 'text', from: 'a', to: 'b' });
    expect(res.ok).toBe(false);
  });

  test('idle_notification bad state enum', () => {
    const res = validateTeamMessage({ kind: 'idle_notification', from: 'a', to: 'b', state: 'flying' });
    expect(res.ok).toBe(false);
  });

  test('permission_response bad decision enum', () => {
    const res = validateTeamMessage({
      kind: 'permission_response',
      from: 'a',
      to: 'b',
      requestId: 'r',
      decision: 'maybe',
    });
    expect(res.ok).toBe(false);
  });

  test('non-object input', () => {
    expect(validateTeamMessage(null).ok).toBe(false);
    expect(validateTeamMessage('text').ok).toBe(false);
  });
});
