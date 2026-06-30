/**
 * task-board-tools —— team 共享任务表(设计 §13.1#1:Team = 共享 TaskList)的
 * 运行时载体 + builtin 工具(task_create / task_list / task_get / task_update + claim)。
 *
 * 三件事一处收口(SSOT):
 *   1. `TeamBoardStore` —— **共享态的唯一权威载体**。持内存 `Board`(shape 见 board-schema.ts),
 *      所有写都过它;读端(task_list / todo 重定向)也走它。落盘 = 经注入 SandboxFs 写
 *      `teamRoot()/board.json`(snapshot 覆盖,§6 幂等)。无 fs 注入 → 纯内存(§9 优雅降级)。
 *   2. **原子 claim**(§13.1#1 / AC-09)—— 进程内 check-and-set:在同步临界区内读-判-写,
 *      N 个并发 claimer 恰一个赢,余者结构化拒绝。配「单 agent 一个 in_progress」busy 闸
 *      + blockedBy 依赖闸。单进程内 JS 单线程,同步方法体即天然临界区(不跨 await)。
 *   3. 四个工具 task_create/list/get/update + claim 经 task_update(action:'claim')—— AI 用户
 *      的协作面;list 是看协作全貌的入口。
 *
 * 拒绝一律结构化(AC-13,显式失败 > 静默):`{ ok:false, code, hint, expected }`。
 *
 * id 空间 / 落盘根独立于 harness 闭环黑板(AC-03,见 board-schema.ts 顶注)。
 *
 * D-1 / AC-14 铁律:core src/ 禁 zod。复用 board-schema.ts 的自写校验器。
 *
 * Boundary: 仅 import core-local 契约(board-schema + capability types + inject SandboxFs/PathConvention 类型)。
 */
import {
  validateBoard,
  isValidTeamTaskId,
  type Board,
  type BoardItem,
  type TeamTaskStatus,
} from './board-schema';
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type ToolContext } from '../../capability/types';
import type { SandboxFs, PathConvention } from '../../inject/types';

// ─── 结构化拒绝(AC-13)──────────────────────────────────────────────────────

/** claim / update 失败码(闭合 union)。 */
export type BoardRejectCode = 'claim_conflict' | 'agent_busy' | 'blocked' | 'not_found' | 'invalid';

/** 结构化拒绝:`code` 机器可判,`hint` 人/AI 可读「为什么」,`expected` 指「该怎么办」。 */
export interface BoardReject {
  ok: false;
  code: BoardRejectCode;
  hint: string;
  expected: string;
}

/** 操作成功:带操作后的任务项快照。 */
export interface BoardOk {
  ok: true;
  item: BoardItem;
}

export type BoardResult = BoardOk | BoardReject;

function reject(code: BoardRejectCode, hint: string, expected: string): BoardReject {
  return { ok: false, code, hint, expected };
}

// ─── 落盘接缝(可选;无注入 → 纯内存)─────────────────────────────────────────

/** 落盘依赖:host 把 SandboxFs + PathConvention 经 ctx 注入;两者齐备才落盘。 */
export interface BoardPersist {
  sandboxFs?: SandboxFs;
  paths?: PathConvention;
}

// ─── TeamBoardStore —— 共享态唯一权威载体 ────────────────────────────────────

export interface TeamBoardStoreOptions {
  teamId: string;
  /** 落盘接缝;缺省 → 纯内存(§9 优雅降级,测试 / 无 host fs 时)。 */
  persist?: BoardPersist;
}

/**
 * 共享任务表的运行时载体。所有共享态读写**唯一**经此(SSOT)。
 * 写方法返回结构化结果;成功后 snapshot 覆盖落盘(幂等)。
 */
export class TeamBoardStore {
  private board: Board;
  private readonly persist: BoardPersist;

  constructor(opts: TeamBoardStoreOptions) {
    this.board = { teamId: opts.teamId, items: [] };
    this.persist = opts.persist ?? {};
  }

  /** 只读快照(深拷贝 items,防外部改内部态)。task_list / 校验 / 落盘共用。 */
  snapshot(): Board {
    return { teamId: this.board.teamId, items: this.board.items.map((i) => ({ ...i, blockedBy: [...i.blockedBy] })) };
  }

  /** 取单项(只读拷贝);无则 undefined。 */
  get(id: string): BoardItem | undefined {
    const it = this.board.items.find((i) => i.id === id);
    return it ? { ...it, blockedBy: [...it.blockedBy] } : undefined;
  }

  private find(id: string): BoardItem | undefined {
    return this.board.items.find((i) => i.id === id);
  }

  /**
   * 新建一个任务项(owner=null / pending)。id 须合 team-<slug> 规约且不重复。
   * blockedBy 可选(引用的 id 须已存在,否则结构化拒绝 invalid —— fail fast,不留悬空)。
   */
  create(id: string, opts: { blockedBy?: string[]; description?: string } = {}): BoardResult {
    if (!isValidTeamTaskId(id)) {
      return reject('invalid', `task id '${id}' does not match the team-<slug> scheme`, 'use a lowercase id like team-render');
    }
    if (this.find(id)) {
      return reject('invalid', `task '${id}' already exists`, 'pick a unique task id or update the existing one');
    }
    const blockedBy = opts.blockedBy ?? [];
    for (const dep of blockedBy) {
      if (dep === id) return reject('invalid', `task '${id}' cannot block itself`, 'remove the self-reference from blockedBy');
      if (!this.find(dep)) return reject('invalid', `blockedBy references unknown task '${dep}'`, 'create the blocking task first, or drop it from blockedBy');
    }
    const item: BoardItem = {
      id,
      owner: null,
      status: 'pending',
      blockedBy: [...blockedBy],
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    };
    this.board.items.push(item);
    this.flush();
    return { ok: true, item: { ...item, blockedBy: [...item.blockedBy] } };
  }

  /**
   * 原子 claim(check-and-set)。同步方法体 = 进程内临界区(JS 单线程,不跨 await):
   * 读当前 owner/status/blockedBy + busy 表 → 判 → 写,三步不可被并发打断,故 N 并发恰一胜。
   *
   * 闸序(失败即结构化返回,AC-13):
   *   1. 任务存在;
   *   2. claim_conflict:已被**他人**领(owner 非空且非 by);已被自己领 → 幂等成功;
   *   3. agent_busy:by 已持有另一个 in_progress 任务(单 in_progress 约束,AC-09);
   *   4. blocked:有未完成(非 done)的 blockedBy 依赖(拒绝含阻塞源 id,AC-10)。
   * 全过 → owner=by、status=in_progress、落盘。
   */
  claim(id: string, by: string): BoardResult {
    const item = this.find(id);
    if (!item) {
      return reject('not_found', `task '${id}' does not exist`, `claim one of the open tasks: ${this.openIds().join(', ') || '(none)'}`);
    }
    // 2) 占用冲突:已被他人领。
    if (item.owner !== null && item.owner !== by) {
      return reject(
        'claim_conflict',
        `task '${id}' is already held by '${item.owner}'`,
        `claim an unowned task instead: ${this.openIds().join(', ') || '(none available)'}`,
      );
    }
    // 已被自己领且在跑 → 幂等成功(再 claim 同任务无副作用)。
    if (item.owner === by && item.status === 'in_progress') {
      return { ok: true, item: { ...item, blockedBy: [...item.blockedBy] } };
    }
    // 3) busy:本 agent 已有另一个 in_progress。
    const busyOn = this.inProgressOwnedBy(by);
    if (busyOn && busyOn !== id) {
      return reject(
        'agent_busy',
        `agent '${by}' already owns in-progress task '${busyOn}'`,
        `finish or release '${busyOn}' (set it done/blocked) before claiming another`,
      );
    }
    // 4) blockedBy:有未完成依赖。
    const pendingDep = item.blockedBy.find((dep) => {
      const d = this.find(dep);
      return !d || d.status !== 'done';
    });
    if (pendingDep) {
      return reject(
        'blocked',
        `task '${id}' is blocked by '${pendingDep}' which is not done yet`,
        `wait until blocking task '${pendingDep}' reaches status=done, then claim '${id}'`,
      );
    }
    // 全过:check-and-set 写入。
    item.owner = by;
    item.status = 'in_progress';
    this.flush();
    return { ok: true, item: { ...item, blockedBy: [...item.blockedBy] } };
  }

  /**
   * 更新一个任务项的状态 / owner / blockedBy(非 claim 的一般更新)。
   * status 转 done/blocked/pending 时,若与 owner 组合会破坏 board 完整性(如制造重复
   * in_progress / 悬空依赖),由末尾 validateBoard 兜底回滚 → 结构化 invalid。
   */
  update(id: string, patch: { status?: TeamTaskStatus; owner?: string | null; blockedBy?: string[]; description?: string }): BoardResult {
    const item = this.find(id);
    if (!item) {
      return reject('not_found', `task '${id}' does not exist`, 'create it first or pick an existing task id');
    }
    const before: BoardItem = { ...item, blockedBy: [...item.blockedBy] };
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.owner !== undefined) item.owner = patch.owner;
    if (patch.blockedBy !== undefined) item.blockedBy = [...patch.blockedBy];
    if (patch.description !== undefined) item.description = patch.description;
    // fail fast:整表完整性校验,违反则回滚(不让坏态落盘 / 流下游)。
    const v = validateBoard(this.board);
    if (!v.ok) {
      Object.assign(item, before);
      return reject('invalid', `update would break the board: ${v.errors.join('; ')}`, 'adjust the patch so no two in_progress per owner and no dangling blockedBy');
    }
    this.flush();
    return { ok: true, item: { ...item, blockedBy: [...item.blockedBy] } };
  }

  /**
   * team 模式 todo_write 的重定向落点(单态,D-4):把模型提交的整张清单 reconcile 进共享表。
   * 语义对齐 todo_write 的 replace 心智 + claim 单态:
   *   - 每条 todo → 一个 team 任务项(id 由 content 派生 slug);
   *   - status pending/in_progress/completed → pending/in_progress/done;
   *   - in_progress 项 owner = 调用 agent(自然兑现「谁在跑」);其余 owner=null;
   *   - **单 in_progress**:只取首个 in_progress 兑现,余者降级 pending(busy 守恒,不制造重复)。
   * 整体 replace:清空旧表换新表(replace-whole-list 心智在共享面的兑现)。
   */
  reconcileFromTodos(todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[], owner: string): Board {
    const items: BoardItem[] = [];
    const used = new Set<string>();
    let inProgressTaken = false;
    for (const t of todos) {
      const id = uniqueTeamId(t.content, used);
      used.add(id);
      let status: TeamTaskStatus = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending';
      let itemOwner: string | null = null;
      if (status === 'in_progress') {
        if (inProgressTaken) status = 'pending'; // 单 in_progress 守恒:第二个起降级。
        else {
          inProgressTaken = true;
          itemOwner = owner;
        }
      }
      items.push({ id, owner: itemOwner, status, blockedBy: [], description: t.content });
    }
    this.board = { teamId: this.board.teamId, items };
    this.flush();
    return this.snapshot();
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────────────

  /** 该 owner 当前持有的 in_progress 任务 id(busy 判定);无则 undefined。 */
  private inProgressOwnedBy(owner: string): string | undefined {
    return this.board.items.find((i) => i.status === 'in_progress' && i.owner === owner)?.id;
  }

  /** 当前可领任务 id(owner=null 且 pending);给拒绝 expected 用。 */
  private openIds(): string[] {
    return this.board.items.filter((i) => i.owner === null && i.status === 'pending').map((i) => i.id);
  }

  /** snapshot 覆盖落盘(§6 幂等:同表多次 flush 文件不增重);fs 接缝缺 → 纯内存,no-op。 */
  private flush(): void {
    const { sandboxFs, paths } = this.persist;
    if (!sandboxFs || !paths) return;
    const root = paths.teamRoot();
    const file = `${root.replace(/[\\/]+$/, '')}/board.json`;
    sandboxFs.mkdirSync(root, { recursive: true });
    sandboxFs.writeTextSync(file, JSON.stringify(this.snapshot(), null, 2));
  }
}

/** content → team-<slug>;碰撞则补数字后缀(不引 nanoid,纯派生)。 */
function uniqueTeamId(content: string, used: Set<string>): string {
  const base = `team-${slugify(content)}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** 小写化 + 非字母数字折成连字符,保证起头为字母数字(满足 team-<slug> 规约)。 */
function slugify(s: string): string {
  const body = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return body.length > 0 ? body : 'task';
}

// ─── ctx 接缝:从 ToolContext 取 TeamBoardStore + 落盘依赖 ─────────────────────

/** host 在 dispatch 前把这些挂到 ctx 上(约定形状;对照 file-tools 的 ToolDeps)。 */
export interface TeamToolDeps {
  /** 共享任务表载体(host 每 team 一个,注入进 ctx)。 */
  teamBoard?: TeamBoardStore;
  sandboxFs?: SandboxFs;
  paths?: PathConvention;
}

/** 从 ctx 取共享任务表;缺失 = 非 team 形态或 host 未注入 → null(工具据此结构化报错)。 */
function boardFromCtx(ctx: ToolContext): TeamBoardStore | null {
  const board = (ctx as ToolContext & TeamToolDeps).teamBoard;
  return board ?? null;
}

/** 统一的「无共享表」结构化报错结果(team 工具在非 team 形态被调时)。 */
function noBoardData(action: string): { ok: false; code: 'invalid'; hint: string; expected: string } {
  return {
    ok: false,
    code: 'invalid',
    hint: `task_${action}: no shared team board on the ToolContext (not in a team, or host did not inject TeamBoardStore)`,
    expected: 'run inside a team session where the host injects ctx.teamBoard',
  };
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

export interface TaskCreateInput {
  id: string;
  blockedBy?: string[];
  description?: string;
}
export interface TaskListInput {
  /** 可选过滤(只看某状态);缺省 = 全表。 */
  status?: TeamTaskStatus;
}
export interface TaskGetInput {
  id: string;
}
export interface TaskUpdateInput {
  id: string;
  /** action:'claim' → 原子领取(owner=调用 agent);否则按 patch 一般更新。 */
  action?: 'claim' | 'update';
  status?: TeamTaskStatus;
  owner?: string | null;
  blockedBy?: string[];
  description?: string;
}

/** 工具层「无共享表」报错形状(结构同 BoardReject 但码恒 invalid)。 */
type NoBoard = ReturnType<typeof noBoardData>;
/** task_list 输出:成功带 items / 失败结构化。 */
type TaskListOutput = { ok: true; items: BoardItem[] } | NoBoard;
/** 单项类工具输出(create/get/update):BoardResult ∪ NoBoard。 */
type TaskItemOutput = BoardResult | NoBoard;

function resultEvent(toolUseId: string, ok: boolean, result: unknown): CoreEvent {
  return {
    type: CoreEventType.ToolCallResult,
    payload: { toolUseId, isError: !ok, result: typeof result === 'string' ? result : JSON.stringify(result) },
    ts: Date.now(),
  };
}

/** task_create —— 新建一个共享任务项(owner=null/pending)。 */
export function taskCreateTool(): AgentTool<TaskCreateInput, TaskItemOutput> {
  return buildTool<TaskCreateInput, TaskItemOutput>({
    name: 'task_create',
    aliases: ['TaskCreate'],
    searchHint: 'create a task on the shared team task table',
    inputJSONSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id (team-<slug> scheme, e.g. team-render).' },
        description: { type: 'string', description: 'What the task is (human/AI-readable; peers read this to know what to do).' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must be done first.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    maxResultSizeChars: 4_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call(input, ctx) {
      const board = boardFromCtx(ctx);
      if (!board) return { data: noBoardData('create') };
      return {
        data: board.create(input.id, {
          ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        }),
      };
    },
    mapResult: (o, id) => resultEvent(id, o.ok, o.ok ? `Task ${o.item.id} created.` : o),
  });
}

/** task_list —— 共享任务表全貌(AI 用户看协作进度的入口)。只读、并发安全。 */
export function taskListTool(): AgentTool<TaskListInput, TaskListOutput> {
  return buildTool<TaskListInput, TaskListOutput>({
    name: 'task_list',
    aliases: ['TaskList'],
    searchHint: 'list the shared team task table (collaboration overview)',
    inputJSONSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] } },
      additionalProperties: false,
    },
    maxResultSizeChars: 16_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx) {
      const board = boardFromCtx(ctx);
      if (!board) return { data: noBoardData('list') };
      const all = board.snapshot().items;
      const items = input.status ? all.filter((i) => i.status === input.status) : all;
      return { data: { ok: true, items } };
    },
    mapResult: (o, id) => resultEvent(id, o.ok, o.ok ? o.items : o),
  });
}

/** task_get —— 取单个任务项详情。 */
export function taskGetTool(): AgentTool<TaskGetInput, TaskItemOutput> {
  return buildTool<TaskGetInput, TaskItemOutput>({
    name: 'task_get',
    aliases: ['TaskGet'],
    searchHint: 'get one task from the shared team task table',
    inputJSONSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    maxResultSizeChars: 4_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input, ctx) {
      const board = boardFromCtx(ctx);
      if (!board) return { data: noBoardData('get') };
      const item = board.get(input.id);
      if (!item) {
        return { data: reject('not_found', `task '${input.id}' does not exist`, 'list tasks to see available ids') };
      }
      return { data: { ok: true, item } };
    },
    mapResult: (o, id) => resultEvent(id, o.ok, o.ok ? o.item : o),
  });
}

/** task_update —— 一般更新或原子 claim(action:'claim')。claim 的 owner = 调用 agent。 */
export function taskUpdateTool(): AgentTool<TaskUpdateInput, TaskItemOutput> {
  return buildTool<TaskUpdateInput, TaskItemOutput>({
    name: 'task_update',
    aliases: ['TaskUpdate'],
    searchHint: 'claim or update a task on the shared team task table',
    inputJSONSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['claim', 'update'], description: "'claim' = atomically take ownership; else patch fields." },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
        owner: { type: ['string', 'null'] },
        blockedBy: { type: 'array', items: { type: 'string' } },
        description: { type: 'string', description: 'Update the task description (what it is).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    maxResultSizeChars: 4_000,
    isReadOnly: () => false,
    // claim 必须串行经由 store 临界区;工具层不声明并发安全(由 store 保原子)。
    isConcurrencySafe: () => false,
    async call(input, ctx) {
      const board = boardFromCtx(ctx);
      if (!board) return { data: noBoardData('update') };
      if (input.action === 'claim') {
        const by = ctx.agentId ?? '';
        if (!by) {
          return { data: reject('invalid', 'claim requires a caller agent id (ctx.agentId missing)', 'host must set ctx.agentId before dispatch') };
        }
        return { data: board.claim(input.id, by) };
      }
      return {
        data: board.update(input.id, {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
          ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        }),
      };
    },
    mapResult: (o, id) => resultEvent(id, o.ok, o.ok ? `Task ${o.item.id} → ${o.item.status}${o.item.owner ? ` (owner ${o.item.owner})` : ''}.` : o),
  });
}

/** team 共享任务表工具聚合包(builtin 层):task_create / task_list / task_get / task_update。 */
export function taskBoardToolsPack() {
  return {
    name: 'task-board-tools',
    layer: 'builtin' as const,
    tools: [taskCreateTool(), taskListTool(), taskGetTool(), taskUpdateTool()],
  };
}
