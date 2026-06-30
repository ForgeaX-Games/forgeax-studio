/**
 * m3-t2③ — claim 冲突 / busy / blockedBy 结构化拒绝形状单测(TDD red→green)。
 *
 * 覆盖 AC-13(结构化失败 > 静默):
 *   - claim 冲突(任务已被他人持有)→ `{ ok:false, code:'claim_conflict', hint, expected }`;
 *   - busy(本 agent 已有一个 in_progress)→ 结构化拒绝(code:'agent_busy'),hint 指出占用任务;
 *   - blockedBy 未完成 → 结构化拒绝(code:'blocked'),hint/expected 含阻塞源任务 id。
 *
 * 这里只断言**拒绝对象的形状**(.code/.hint/.expected 三字段在);并发原子性归 e2e。
 *
 * Boundary: 仅 import core-local 契约 + bun:test。core src/ 禁 zod(AC-14)。
 */
import { test, expect, describe } from 'bun:test';
import { TeamBoardStore } from './task-board-tools';

function freshStore(): TeamBoardStore {
  // 无 fs 注入 → 纯内存 board(落盘是可选副作用,见 task-board-tools 实现)。
  return new TeamBoardStore({ teamId: 'team-x' });
}

describe('claim conflict reject — AC-13 structured shape', () => {
  test('claim_conflict has .code / .hint / .expected', () => {
    const s = freshStore();
    s.create('team-a');
    const first = s.claim('team-a', 'alice');
    expect(first.ok).toBe(true);

    // bob tries to claim the same already-owned task → structured conflict.
    const second = s.claim('team-a', 'bob');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('claim_conflict');
      expect(typeof second.hint).toBe('string');
      expect(typeof second.expected).toBe('string');
      // hint should name the current holder.
      expect(second.hint).toContain('alice');
    }
  });
});

describe('agent busy reject — single in_progress per agent', () => {
  test('agent already owning an in_progress task cannot claim another', () => {
    const s = freshStore();
    s.create('team-a');
    s.create('team-b');
    expect(s.claim('team-a', 'alice').ok).toBe(true);

    const busy = s.claim('team-b', 'alice');
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.code).toBe('agent_busy');
      expect(typeof busy.hint).toBe('string');
      expect(typeof busy.expected).toBe('string');
      // hint should name the task the agent is already busy on.
      expect(busy.hint).toContain('team-a');
    }
  });
});

describe('blockedBy reject — includes blocking task id', () => {
  test('blocked claim is structured and names the blocking task id', () => {
    const s = freshStore();
    s.create('team-y');
    s.create('team-x', { blockedBy: ['team-y'] });

    const blocked = s.claim('team-x', 'alice');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe('blocked');
      expect(typeof blocked.hint).toBe('string');
      expect(typeof blocked.expected).toBe('string');
      // the blocking task id must be surfaced (AC-10 / P3 affordance).
      expect(`${blocked.hint} ${blocked.expected}`).toContain('team-y');
    }
  });
});
