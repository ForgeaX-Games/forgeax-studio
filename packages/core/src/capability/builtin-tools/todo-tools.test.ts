/**
 * m3-t2② — todo_write 两态单测(TDD red→green)。
 *
 * 覆盖 AC-11 / AC-12(单态 SSOT,非 team 行为零变化):
 *   - **非 team 模式**:todo_write 仍 replace-whole-list 写注入的 `TodoStore`
 *     (`store.items = items`),行为零变化;
 *   - **team 模式**(注入 teamBoard 接缝):todo_write 重定向写**共享任务表**(单态),
 *     且**不**再往 TodoStore 双写(no double state) —— 验 TodoStore 保持空。
 *
 * Boundary: 仅 import core-local 契约 + bun:test。core src/ 禁 zod(AC-14)。
 */
import { test, expect, describe } from 'bun:test';
import { todoWriteTool, type TodoStore } from './todo-tools';
import { TeamBoardStore } from '../../agent/team/task-board-tools';
import type { ToolContext } from '../types';

function ctx(agentId = 'alice'): ToolContext {
  return { signal: new AbortController().signal, agentId, toolUseId: 'tu-1' };
}

describe('todo_write — non-team mode unchanged (replace-whole-list TodoStore)', () => {
  test('writes replace-whole-list into TodoStore; no team board', async () => {
    const store: TodoStore = { items: [] };
    const tool = todoWriteTool({ store });
    await tool.call(
      { todos: [{ content: 'do A', status: 'pending' }, { content: 'do B', status: 'in_progress', activeForm: 'doing B' }] },
      ctx(),
    );
    expect(store.items.length).toBe(2);
    expect(store.items[0]).toEqual({ content: 'do A', status: 'pending' });
    expect(store.items[1]).toEqual({ content: 'do B', status: 'in_progress', activeForm: 'doing B' });

    // replace semantics: a second write replaces, not appends.
    await tool.call({ todos: [{ content: 'only C', status: 'completed' }] }, ctx());
    expect(store.items.length).toBe(1);
    expect(store.items[0].content).toBe('only C');
  });
});

describe('todo_write — team mode redirects to shared table (single-state)', () => {
  test('writes shared board only; does NOT double-write TodoStore', async () => {
    const store: TodoStore = { items: [] };
    const teamBoard = new TeamBoardStore({ teamId: 'team-x' });
    const tool = todoWriteTool({ store, teamBoard });

    await tool.call(
      { todos: [{ content: 'pillar', status: 'in_progress' }, { content: 'design', status: 'pending' }] },
      ctx('alice'),
    );

    // single-state: the shared board has the rows...
    const items = teamBoard.snapshot().items;
    expect(items.length).toBe(2);
    // the in_progress todo is owned by the calling agent on the shared board.
    const inProg = items.find((i) => i.status === 'in_progress');
    expect(inProg).toBeDefined();
    expect(inProg?.owner).toBe('alice');

    // ...and NO second copy landed in TodoStore (no double state — D-4 SSOT).
    expect(store.items.length).toBe(0);
  });
});
