/**
 * Core event catalog (C1) — the canonical event type names + payload typing.
 *
 * 设计稿: 最终实现方案 §3 (events.ts 事件目录) + §4。事件流是真相，派生状态是 fold
 * 结果（不变量 §6.1）。`CoreEventType` 是稳定字符串枚举；payload 类型挂在
 * `CoreEventPayloads` 上，供 typed publish/subscribe 收窄。
 *
 * 含三个**重生事件**（数字生命 seam，core-layer-spec §3.4.8）——core 只 publish，
 * 语义由 ③ soul-pack cli pack 解释（K14）。
 */
import type { LoopStage, TerminalReason } from '../agent/types';
import type {
  SoulPackLoadedPayload,
  RebirthInitiatedPayload,
  IdentityProjectedPayload,
} from '../capability/memory-seam';

export const CoreEventType = {
  // turn lifecycle
  TurnStart: 'turn.start',
  TurnEnd: 'turn.end',
  TurnAborted: 'turn.aborted',
  // loop stages
  CapabilitiesResolved: 'capabilities.resolved',
  SystemPromptAssembled: 'system_prompt.assembled',
  // tool call
  ToolCallRequested: 'tool.requested',
  ToolCalled: 'tool.called',
  ToolCallResult: 'tool.result',
  // compaction (ledger fold consumes these)
  CompactionApplied: 'compaction.applied',
  CompactionRevoked: 'compaction.revoked',
  // capability hot-reload
  CapabilityReloaded: 'capability.reloaded',
  // ★ hook 生命周期事件（session/prompt/compaction/notification/stop）。
  //   PostToolUse 不另设成员——它复用 ToolCallResult('tool.result')。
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'user_prompt.submit',
  PreCompact: 'compaction.pre',
  PostCompact: 'compaction.post',
  Notification: 'notification',
  /** 专用 stop 事件；后续阶段将 REPLACE loop 里临时的 'stop.hook' 字符串。 */
  Stop: 'stop',
  SubagentStop: 'subagent.stop',
  /** ★ 子 agent 启动:子 loop fork 出来时发,携类型/角色/深度。 */
  SubagentStart: 'subagent.start',
  /** ★ 子 agent 进入新一轮:每轮起点发,携轮号/深度。 */
  SubagentTurn: 'subagent.turn',
  /** ★ 子 agent 工具调用:子 loop 调工具时发,携工具名/toolUseId/轮号/深度。 */
  SubagentToolCall: 'subagent.tool_call',
  /** ★ 子 agent 进度:子 loop 自报进度文本(可选轮号)。 */
  SubagentProgress: 'subagent.progress',
  /** ★ peer 消息(多 agent 协作 seam):一个 agent → 另一个 agent 的点对点消息。
   *  core 只 publish,由 host(多 agent session bus / 调度器)负责路由投递。 */
  AgentMessage: 'agent.message',
  // ★ 重生事件（数字生命转世 seam）
  SoulPackLoaded: 'soul.pack_loaded',
  RebirthInitiated: 'soul.rebirth_initiated',
  IdentityProjected: 'soul.identity_projected',
} as const;

export type CoreEventType = (typeof CoreEventType)[keyof typeof CoreEventType];

/** 各事件的 payload 类型（typed publish 用；未列的事件 payload=unknown）。 */
export interface CoreEventPayloads {
  [CoreEventType.TurnStart]: { turn: number };
  [CoreEventType.TurnEnd]: { turn: number; usageContextRatio?: number };
  [CoreEventType.TurnAborted]: { turn: number; reason?: string };
  [CoreEventType.CapabilitiesResolved]: { toolNames: string[] };
  [CoreEventType.SystemPromptAssembled]: { blockCount: number };
  [CoreEventType.ToolCallRequested]: { toolName: string; toolUseId: string; input: unknown };
  [CoreEventType.ToolCalled]: { toolName: string; toolUseId: string };
  /**
   * 工具调用结果。亦充当 PostToolUse hook 的载荷——故额外携带 `toolName`/`result`
   * （additive 加宽，原 `{ toolUseId; isError? }` 字段保持 byte-stable）。
   */
  [CoreEventType.ToolCallResult]: {
    toolUseId: string;
    toolName?: string;
    result?: unknown;
    isError?: boolean;
  };
  [CoreEventType.CompactionApplied]: { coveredFrom: number; coveredTo: number; replacement: unknown };
  [CoreEventType.CompactionRevoked]: { appliedId: string };
  [CoreEventType.CapabilityReloaded]: { packName: string };
  // ★ hook 生命周期事件的 payload。
  /** 会话开始：哪个 session、工作目录、触发来源。 */
  [CoreEventType.SessionStart]: { sessionId?: string; cwd?: string; source?: string };
  /** 会话结束：哪个 session、结束原因。 */
  [CoreEventType.SessionEnd]: { sessionId?: string; reason?: string };
  /** 用户提交 prompt：本轮 prompt 文本 + 第几轮。 */
  [CoreEventType.UserPromptSubmit]: { prompt: string; turn: number };
  /** 压缩前：触发方式(auto/manual) + 当前 token 数。 */
  [CoreEventType.PreCompact]: { trigger?: 'auto' | 'manual'; tokenCount?: number };
  /** 压缩后:被压缩覆盖的消息区间。 */
  [CoreEventType.PostCompact]: { coveredFrom: number; coveredTo: number };
  /** 通知:消息文本 + 可选级别。 */
  [CoreEventType.Notification]: { message: string; level?: string };
  /**
   * 停止 hook：loop 从 publish receipt 上读 `preventStop`/`reason`
   * （镜像当前 'stop.hook' 的形状）。
   */
  [CoreEventType.Stop]: { turn: number; preventStop?: boolean; reason?: string; stopHookActive?: boolean };
  /** 子 agent 停止:子 agent 标识、类型、终态原因、轮数与工具调用数。 */
  [CoreEventType.SubagentStop]: {
    agentId?: string;
    agentType?: string;
    terminalReason?: string;
    turns?: number;
    toolCalls?: number;
  };
  /** 子 agent 启动:子 agent 标识、类型、角色、递归深度。 */
  [CoreEventType.SubagentStart]: { agentId: string; agentType?: string; role?: string; depth?: number };
  /** 子 agent 进入新一轮:子 agent 标识、轮号、递归深度。 */
  [CoreEventType.SubagentTurn]: { agentId: string; turn: number; depth?: number };
  /** 子 agent 工具调用:子 agent 标识、工具名、toolUseId、轮号、递归深度。 */
  [CoreEventType.SubagentToolCall]: { agentId: string; toolName: string; toolUseId: string; turn?: number; depth?: number };
  /** 子 agent 进度:子 agent 标识、进度文本、轮号。 */
  [CoreEventType.SubagentProgress]: { agentId: string; message?: string; turn?: number };
  /**
   * peer 消息(多 agent 协作):`from` 发送方 agentId,`to` 目标 agentId(寻址用;
   * 缺省/广播由 host 解释),`content` 消息体(文本或结构化),`replyTo` 可选关联上一条。
   */
  [CoreEventType.AgentMessage]: {
    from?: string;
    to?: string;
    content: unknown;
    replyTo?: string;
  };
  [CoreEventType.SoulPackLoaded]: SoulPackLoadedPayload;
  [CoreEventType.RebirthInitiated]: RebirthInitiatedPayload;
  [CoreEventType.IdentityProjected]: IdentityProjectedPayload;
}

/** loop 阶段 → 事件名映射（stage publish 用）。 */
export const STAGE_EVENT: Record<LoopStage, string> = {
  resolve_capabilities: CoreEventType.CapabilitiesResolved,
  assemble_system_prompt: CoreEventType.SystemPromptAssembled,
  context_compaction: CoreEventType.CompactionApplied,
  provider_call: 'provider.call',
  dispatch_tools: CoreEventType.ToolCallRequested,
  turn_end: CoreEventType.TurnEnd,
  handoff_decision: 'handoff.decision',
};

/** 终态 reason → 是否正常完成（telemetry/facade 用）。 */
export function isCleanTerminal(reason: TerminalReason): boolean {
  return reason === 'completed';
}
