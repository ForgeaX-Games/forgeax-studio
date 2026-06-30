/**
 * m1-t2 — 共享任务表 board.json 自写校验器测试(TDD red→green)。
 *
 * 覆盖 AC-03(board schema 正反双向 + id 空间独立):
 *   - 合法 board(owner/status/blockedBy/id)→ 通过(ok:true);
 *   - 非法:重复 in_progress(同 owner 两个 in_progress)、悬空 blockedBy(引用不存在 id)、
 *     自指 blockedBy、id 命名不合本表规约 → 被拒(ok:false + 结构化错误)。
 *   - 断言 id 空间与落盘根不复用 harness `^todo-\d{3,}$` 命名 / validate_state_machine。
 *
 * Boundary: 仅 import core-local 契约 + bun:test。core src/ 禁 zod(AC-14)。
 */
import { test, expect, describe } from 'bun:test';
import { validateBoard, isValidTeamTaskId, type Board } from './board-schema';

const legalBoard: Board = {
  teamId: 'team-forge-1',
  items: [
    { id: 'team-pillar', owner: 'iori', status: 'in_progress', blockedBy: [] },
    { id: 'team-design', owner: 'suzu', status: 'pending', blockedBy: ['team-pillar'] },
    { id: 'team-render', owner: null, status: 'pending', blockedBy: [] },
  ],
};

describe('validateBoard — legal board accepted', () => {
  test('legal board passes', () => {
    const res = validateBoard(legalBoard);
    expect(res.ok).toBe(true);
  });
});

describe('validateBoard — illegal boards rejected', () => {
  test('duplicate in_progress for same owner', () => {
    const bad: Board = {
      teamId: 'team-x',
      items: [
        { id: 'team-a', owner: 'iori', status: 'in_progress', blockedBy: [] },
        { id: 'team-b', owner: 'iori', status: 'in_progress', blockedBy: [] },
      ],
    };
    const res = validateBoard(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toContain('in_progress');
  });

  test('dangling blockedBy (id not in board)', () => {
    const bad: Board = {
      teamId: 'team-x',
      items: [{ id: 'team-a', owner: null, status: 'pending', blockedBy: ['team-ghost'] }],
    };
    const res = validateBoard(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(' ')).toContain('team-ghost');
  });

  test('self-referential blockedBy', () => {
    const bad: Board = {
      teamId: 'team-x',
      items: [{ id: 'team-a', owner: null, status: 'pending', blockedBy: ['team-a'] }],
    };
    const res = validateBoard(bad);
    expect(res.ok).toBe(false);
  });

  test('id not conforming to team scheme (harness todo-NNN rejected)', () => {
    const bad: Board = {
      teamId: 'team-x',
      items: [{ id: 'todo-001', owner: null, status: 'pending', blockedBy: [] }],
    };
    const res = validateBoard(bad);
    expect(res.ok).toBe(false);
  });

  test('non-object / non-array shape', () => {
    expect(validateBoard(null).ok).toBe(false);
    expect(validateBoard({ teamId: 'x', items: 'nope' }).ok).toBe(false);
  });
});

describe('isValidTeamTaskId — id space distinct from harness', () => {
  test('accepts team- scheme', () => {
    expect(isValidTeamTaskId('team-pillar')).toBe(true);
  });
  test('rejects harness todo-NNN scheme', () => {
    expect(isValidTeamTaskId('todo-001')).toBe(false);
    expect(isValidTeamTaskId('todo-123')).toBe(false);
  });
});
