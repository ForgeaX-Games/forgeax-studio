/**
 * TeamMessage —— team mailbox 「一信道两平面」的判别式 union(设计 SSOT §13.1#3)。
 *
 * 一条 mailbox 同时承载两个平面,靠 `kind` 判别:
 *   - 数据面:`text` —— 进目标成员下一回合的 LLM 输入装配(对照 cc attachment)。
 *   - 控制面:`idle_notification` / `permission_request` / `permission_response` /
 *     `plan_approval` / `shutdown` / `task_assignment` / `mode_set` —— 由 inbox poller
 *     路由进各 handler(M2 的 `inbox-router.ts`),**不进** LLM 数据面。
 *
 * 8 成员一次定型。union **可被 TS narrowing**:`switch (msg.kind)` 配 `default: never`
 * 守卫(漏成员则编译失败)——穷尽 switch 的真实应用点在 M2 inbox-router;本文件只提供
 * 类型 + 运行时校验器,使该消费方成立。
 *
 * D-1 / AC-14 铁律:core src/ 禁 zod。本文件用**纯 TS 判别式 union + 自写最小校验器**
 * (对齐 `capability/builtin-tools/structured-output.ts` 的自写校验器先例),严禁 import zod。
 *
 * Boundary: 本文件只 import core-local 契约(此处无外部依赖)。
 */

// ─── 公共字段 ────────────────────────────────────────────────────────────────

/** 所有成员共有的寻址头(`from`/`to` 见 §13.1#7:to=name / '*' 广播 / coordinator)。 */
interface TeamMessageBase {
  from: string;
  to: string;
}

// ─── 数据面 ──────────────────────────────────────────────────────────────────

/** 数据面:纯文本片段,进目标成员下一回合 LLM 输入。`summary` 为可选短摘要。 */
export interface TextMessage extends TeamMessageBase {
  kind: 'text';
  text: string;
  summary?: string;
}

// ─── 控制面 ──────────────────────────────────────────────────────────────────

/** teammate 回合后的空闲回执(带完工状态);回 leader 控制面(对照 cc idle_notification)。 */
export interface IdleNotificationMessage extends TeamMessageBase {
  kind: 'idle_notification';
  state: 'available' | 'interrupted' | 'failed';
  completedTaskId?: string;
  completedStatus?: 'done' | 'blocked' | 'failed';
}

/** worker→leader 危险工具权限申请(P4 才接行为;本轮仅类型成员,OOS-2)。 */
export interface PermissionRequestMessage extends TeamMessageBase {
  kind: 'permission_request';
  requestId: string;
  toolName: string;
  input?: unknown;
}

/** leader→worker 权限裁决回执(P4 行为;本轮仅类型成员)。 */
export interface PermissionResponseMessage extends TeamMessageBase {
  kind: 'permission_response';
  requestId: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

/** plan 审批握手(approve / reject;reason 可选)。 */
export interface PlanApprovalMessage extends TeamMessageBase {
  kind: 'plan_approval';
  planId: string;
  decision: 'approve' | 'reject';
  reason?: string;
}

/** team 生命周期 shutdown 握手(request → approved | rejected,§13.1#9)。 */
export interface ShutdownMessage extends TeamMessageBase {
  kind: 'shutdown';
  phase: 'request' | 'approved' | 'rejected';
  reason?: string;
}

/** leader→teammate 任务指派(taskId 指向共享任务表项,§13.1#1)。 */
export interface TaskAssignmentMessage extends TeamMessageBase {
  kind: 'task_assignment';
  taskId: string;
  note?: string;
}

/** leader→teammate 模式切换(plan / default / accept-edits…;mode 形状开放)。 */
export interface ModeSetMessage extends TeamMessageBase {
  kind: 'mode_set';
  mode: string;
}

// ─── union ───────────────────────────────────────────────────────────────────

/** team mailbox 判别式 union(8 成员;判别字段 `kind`)。 */
export type TeamMessage =
  | TextMessage
  | IdleNotificationMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | PlanApprovalMessage
  | ShutdownMessage
  | TaskAssignmentMessage
  | ModeSetMessage;

/** 8 个判别值的运行时清单(校验器与可发现性共用,SSOT)。 */
export const TEAM_MESSAGE_KINDS = [
  'text',
  'idle_notification',
  'permission_request',
  'permission_response',
  'plan_approval',
  'shutdown',
  'task_assignment',
  'mode_set',
] as const;

// ─── 自写校验器(无 zod;对齐 structured-output.ts 风格)──────────────────────

/** 结构化校验结果:成功带 narrow 后的值,失败带逐条错误(对齐 AC-13 显式失败)。 */
export type TeamMessageValidation =
  | { ok: true; value: TeamMessage }
  | { ok: false; errors: string[] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqStr(o: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof o[key] !== 'string' || o[key] === '') {
    errors.push(`${key}: required non-empty string`);
  }
}

function reqEnum(o: Record<string, unknown>, key: string, allowed: readonly string[], errors: string[]): void {
  if (typeof o[key] !== 'string' || !allowed.includes(o[key] as string)) {
    errors.push(`${key}: must be one of ${allowed.join('|')}`);
  }
}

/** 各成员的私有必填校验(公共 from/to 在 validateTeamMessage 统一查)。 */
function validateMember(kind: string, o: Record<string, unknown>, errors: string[]): void {
  switch (kind) {
    case 'text':
      reqStr(o, 'text', errors);
      break;
    case 'idle_notification':
      reqEnum(o, 'state', ['available', 'interrupted', 'failed'], errors);
      break;
    case 'permission_request':
      reqStr(o, 'requestId', errors);
      reqStr(o, 'toolName', errors);
      break;
    case 'permission_response':
      reqStr(o, 'requestId', errors);
      reqEnum(o, 'decision', ['allow', 'deny'], errors);
      break;
    case 'plan_approval':
      reqStr(o, 'planId', errors);
      reqEnum(o, 'decision', ['approve', 'reject'], errors);
      break;
    case 'shutdown':
      reqEnum(o, 'phase', ['request', 'approved', 'rejected'], errors);
      break;
    case 'task_assignment':
      reqStr(o, 'taskId', errors);
      break;
    case 'mode_set':
      reqStr(o, 'mode', errors);
      break;
    default:
      errors.push(`kind: unknown discriminant '${kind}' (expected one of ${TEAM_MESSAGE_KINDS.join('|')})`);
  }
}

/**
 * 校验任意值是否为合法 TeamMessage,返回结构化结果(不抛)。
 * 成功时 `value` 已是 narrow 后的 TeamMessage;失败时 `errors` 列逐条原因。
 */
export function validateTeamMessage(raw: unknown): TeamMessageValidation {
  const errors: string[] = [];
  if (!isObj(raw)) {
    return { ok: false, errors: ['message must be a non-null object'] };
  }
  const kind = raw.kind;
  if (typeof kind !== 'string') {
    return { ok: false, errors: ["kind: required string discriminant ('kind' missing or not a string)"] };
  }
  // 公共寻址头
  reqStr(raw, 'from', errors);
  reqStr(raw, 'to', errors);
  // 成员私有
  validateMember(kind, raw, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: raw as unknown as TeamMessage };
}
