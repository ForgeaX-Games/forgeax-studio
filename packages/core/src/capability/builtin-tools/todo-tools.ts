/**
 * Builtin todo tool (②) — `todo_write` (alias `TodoWrite`).
 *
 * 模型每次提交**整张**任务清单(replace
 * 语义),host 渲染进度。core 不持久化——清单存进一个注入的 `TodoStore` 持有者
 * (闭包捕获),host 决定其生命周期(per-session/per-agent)。工具返回写入后的清单,
 * 便于渲染与 e2e 断言。
 *
 * ★ team 模式重定向(AC-11 / D-4 单态 SSOT):当注入了共享任务表 `teamBoard` 时,
 *   todo_write **重定向**写共享表(`reconcileFromTodos`),**不再**往 `TodoStore` 双写
 *   —— 单态,绝不双份(team 的 TaskList 即 todo 的唯一真相)。非 team 模式(无 teamBoard)
 *   行为**零变化**:仍 `store.items = items` replace-whole-list 写 TodoStore。
 *   这是同一工具的最小分流接缝(不 fork 成两个工具)。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool } from '../types';
import type { TeamBoardStore } from '../../agent/team/task-board-tools';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** 进行中态展示文案(activeForm)。 */
  activeForm?: string;
}

/** host 持有的清单状态(可读其 items 做渲染/侧栏)。 */
export interface TodoStore {
  items: TodoItem[];
}

export interface TodoWriteInput {
  todos: TodoItem[];
}

export interface TodoWriteOutput {
  todos: TodoItem[];
  counts: { pending: number; in_progress: number; completed: number };
}

function summarize(items: TodoItem[]): TodoWriteOutput['counts'] {
  const c = { pending: 0, in_progress: 0, completed: 0 };
  for (const t of items) {
    if (t.status === 'pending') c.pending++;
    else if (t.status === 'in_progress') c.in_progress++;
    else if (t.status === 'completed') c.completed++;
  }
  return c;
}

export interface TodoToolsOptions {
  /** 注入的清单持有者;缺省 → pack 内部自建一个(进程内)。 */
  store?: TodoStore;
  /** team 模式接缝:注入后 todo_write 重定向写共享任务表(单态),不双写 TodoStore。
   *  缺省 → 非 team 模式,行为零变化(写 TodoStore replace-whole-list)。 */
  teamBoard?: TeamBoardStore;
}

export function todoWriteTool(opts: TodoToolsOptions = {}): AgentTool<TodoWriteInput, TodoWriteOutput> {
  const store: TodoStore = opts.store ?? { items: [] };
  const teamBoard = opts.teamBoard;
  return buildTool<TodoWriteInput, TodoWriteOutput>({
    name: 'todo_write',
    aliases: ['TodoWrite'],
    searchHint: 'create or update the task todo list',
    inputJSONSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full todo list (replaces the prior list).',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Imperative task description.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', description: 'Present-continuous form shown while in_progress.' },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    maxResultSizeChars: Infinity,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call(input, ctx): Promise<{ data: TodoWriteOutput }> {
      if (!Array.isArray(input.todos)) {
        throw new Error('todo_write: todos must be an array');
      }
      const items: TodoItem[] = input.todos.map((t) => ({
        content: String(t.content ?? ''),
        status: (t.status ?? 'pending') as TodoStatus,
        ...(t.activeForm ? { activeForm: String(t.activeForm) } : {}),
      }));
      // team 模式:重定向写共享任务表(单态)。**不**再写 TodoStore —— 绝不双份(D-4)。
      if (teamBoard) {
        teamBoard.reconcileFromTodos(
          items.map((t) => ({ content: t.content, status: t.status })),
          ctx.agentId ?? '',
        );
        return { data: { todos: items, counts: summarize(items) } };
      }
      // 非 team 模式:replace-whole-list 写 TodoStore(行为零变化)。
      store.items = items;
      return { data: { todos: items, counts: summarize(items) } };
    },
    mapResult: (o, id): CoreEvent => ({
      type: CoreEventType.ToolCallResult,
      payload: {
        toolUseId: id,
        isError: false,
        result: `Todos updated: ${o.counts.pending} pending, ${o.counts.in_progress} in progress, ${o.counts.completed} completed`,
        todos: o.todos,
      },
      ts: Date.now(),
    }),
  });
}

/** todo 工具聚合包(builtin 层)。 */
export function todoToolsPack(opts: TodoToolsOptions = {}) {
  return {
    name: 'todo-tools',
    layer: 'builtin' as const,
    tools: [todoWriteTool(opts)],
  };
}
