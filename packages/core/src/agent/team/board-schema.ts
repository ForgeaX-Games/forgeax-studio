/**
 * board.json schema —— team 共享任务表(设计 SSOT §13.1#1:Team = 共享 TaskList)。
 *
 * 共享态 = 每 team 一张任务表:`items[]`(`id`/`owner`/`status`/`blockedBy`)。落盘根来自
 * `PathConvention.teamRoot()`(inject/types.ts;接缝已留,落盘读写归 M3)。
 *
 * 分层(借鉴 harness 闭环黑板的 shape-in-schema vs 完整性-in-状态机 分工,但**id 空间 /
 * 落盘根独立**,见下「id 空间」):
 *   - 本文件 = shape + 跨项完整性校验(重复 in_progress / 悬空·自指 blockedBy / id 规约);
 *   - 原子 claim / busy 抢占语义 = M3 的 task-board-tools(行为层)。
 *
 * id 空间(AC-03 硬约束):本表的 id 命名与落盘根**与 harness 闭环黑板完全独立**——既不复用
 * 它的 id 命名前缀,也不挂它的状态机校验脚本。本表用独立 `team-<slug>` 方案,落 board.json,
 * 与 harness 黑板互不干扰(避免 AI 把两套黑板搞混)。
 *
 * D-1 / AC-14 铁律:core src/ 禁 zod。纯 TS schema + 自写校验器,严禁 import zod。
 *
 * Boundary: 本文件只 import core-local 契约(此处无外部依赖)。
 */

// ─── id 空间 ─────────────────────────────────────────────────────────────────

/**
 * team 任务 id 规约:`team-` 前缀 + 小写 slug(字母/数字/连字符,字母数字起头)。
 * 刻意用 `team-` 前缀 + slug 尾,与 harness 闭环黑板的数字编号命名前缀互斥,不可能撞。
 */
const TEAM_TASK_ID_RE = /^team-[a-z0-9][a-z0-9-]*$/;

/** 判定一个字符串是否为合法 team 任务 id(独立于 harness 命名)。 */
export function isValidTeamTaskId(id: unknown): id is string {
  return typeof id === 'string' && TEAM_TASK_ID_RE.test(id);
}

// ─── schema(纯 TS)────────────────────────────────────────────────────────────

/** 任务项状态(闭合 union)。busy 约束 = 单 owner 至多一个 in_progress(跨项,见校验)。 */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

/** 任务状态运行时清单(校验复用)。 */
export const TEAM_TASK_STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const;

/** 一个任务表项。`owner` 为 null = 未认领(可被 claim);`blockedBy` 列阻塞源任务 id。
 *  `description` 可选:任务的人类/AI 可读内容(peer 据此知道「这个任务要做什么」)。 */
export interface BoardItem {
  id: string;
  owner: string | null;
  status: TeamTaskStatus;
  blockedBy: string[];
  description?: string;
}

/** 一个 team 的共享任务表(落盘 = board.json)。 */
export interface Board {
  teamId: string;
  items: BoardItem[];
}

// ─── 自写校验器(无 zod;对齐 structured-output.ts 风格)──────────────────────

/** 结构化校验结果(对齐 AC-13 显式失败:失败带逐条错误)。 */
export type BoardValidation = { ok: true; value: Board } | { ok: false; errors: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 校验单个 item 的 shape(不查跨项完整性)。把错误推进 errors,带索引前缀。 */
function validateItemShape(raw: unknown, idx: number, errors: string[]): raw is BoardItem {
  const pfx = `items[${idx}]`;
  if (!isObj(raw)) {
    errors.push(`${pfx}: must be an object`);
    return false;
  }
  let ok = true;
  if (!isValidTeamTaskId(raw.id)) {
    errors.push(`${pfx}.id: must match team-<slug> scheme (got ${JSON.stringify(raw.id)})`);
    ok = false;
  }
  if (!(raw.owner === null || typeof raw.owner === 'string')) {
    errors.push(`${pfx}.owner: must be a string or null`);
    ok = false;
  }
  if (typeof raw.status !== 'string' || !TEAM_TASK_STATUSES.includes(raw.status as TeamTaskStatus)) {
    errors.push(`${pfx}.status: must be one of ${TEAM_TASK_STATUSES.join('|')}`);
    ok = false;
  }
  if (!Array.isArray(raw.blockedBy) || !raw.blockedBy.every((b) => typeof b === 'string')) {
    errors.push(`${pfx}.blockedBy: must be an array of task id strings`);
    ok = false;
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    errors.push(`${pfx}.description: must be a string when present`);
    ok = false;
  }
  return ok;
}

/**
 * 校验任意值是否为合法 Board,返回结构化结果(不抛)。
 * 查 shape + 跨项完整性:
 *   - 重复 in_progress:同 owner 至多一个 in_progress(busy 约束,§13.1#1);
 *   - 悬空 blockedBy:引用了不存在的 id;
 *   - 自指 blockedBy:item.blockedBy 含自身 id。
 */
export function validateBoard(raw: unknown): BoardValidation {
  const errors: string[] = [];
  if (!isObj(raw)) {
    return { ok: false, errors: ['board must be a non-null object'] };
  }
  if (typeof raw.teamId !== 'string' || raw.teamId === '') {
    errors.push('teamId: required non-empty string');
  }
  if (!Array.isArray(raw.items)) {
    errors.push('items: must be an array');
    return { ok: false, errors };
  }

  const items = raw.items;
  const shapeOk = items.map((it, i) => validateItemShape(it, i, errors));

  // 跨项完整性仅在 shape 基本成立时有意义(对成立的 item 检查)。
  const valid = items.filter((_, i) => shapeOk[i]) as BoardItem[];
  const ids = new Set(valid.map((it) => it.id));

  // 1) 单 owner 至多一个 in_progress(busy)。
  const inProgressByOwner = new Map<string, number>();
  for (const it of valid) {
    if (it.status === 'in_progress' && typeof it.owner === 'string') {
      const n = (inProgressByOwner.get(it.owner) ?? 0) + 1;
      inProgressByOwner.set(it.owner, n);
    }
  }
  for (const [owner, n] of inProgressByOwner) {
    if (n > 1) {
      errors.push(`owner '${owner}': has ${n} in_progress tasks (busy rule: at most one in_progress per owner)`);
    }
  }

  // 2) 悬空 / 自指 blockedBy。
  for (const it of valid) {
    for (const dep of it.blockedBy) {
      if (dep === it.id) {
        errors.push(`items '${it.id}'.blockedBy: self-referential dependency '${dep}'`);
      } else if (!ids.has(dep)) {
        errors.push(`items '${it.id}'.blockedBy: dangling dependency '${dep}' (no such task id)`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: raw as unknown as Board };
}
