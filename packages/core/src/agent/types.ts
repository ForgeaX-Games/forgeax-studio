/**
 * Agent 类型 (C5) — 原生 Agent API + loop 阶段事件 + 终态契约。
 *
 * 设计稿: 最终实现方案 §5 (agent loop 三场景) + core-layer-spec §3.1。
 * 每迭代阶段 / §1.7(Terminal reasons 全集) / 跨 turn 提交状态。
 *
 * FACADE 把 TurnRequest 翻成 Agent.run 的输入（K10）；LOOP 实现本契约。
 * Boundary: 仅 import core-local 类型。
 */
import type { CoreEvent } from '../events/types';
import type { AgentTool, ToolContext } from '../capability/types';
import type { LLMProvider, ProviderMessage } from '../provider/types';
import type { Slot } from '../capability/types';

// ─── loop 三场景（对齐最终方案 §5）────────────────────────────────────────

export type LoopScenario =
  | 'normal' // user/tool result 驱动，调 LLM，过护栏
  | 'interrupt' // abort signal，不调 LLM，必发 TurnAborted + 资源释放
  | 'agent_command'; // 内部 agent_command 事件，跳 stage1-4，绕过 LLM 护栏(trust channel)

// ─── normal 场景 7 阶段（每阶段 publish 给 hook；queryLoop）─────────

export type LoopStage =
  | 'resolve_capabilities' // stage1
  | 'assemble_system_prompt' // stage2 (slot)
  | 'context_compaction' // stage3 (fold + 水位)
  | 'provider_call' // stage4 (stream + abort)
  | 'dispatch_tools' // stage5 (serial/parallel + condition gate + hook block)
  | 'turn_end' // stage6 (usage/cost → contextRatio)
  | 'handoff_decision'; // stage7

// ─── 终态 / 续轮 reason（§1.7，必须产出同集合）─────────────────────

export type TerminalReason =
  | 'completed'
  | 'aborted_streaming'
  | 'aborted_tools'
  | 'prompt_too_long'
  | 'image_error'
  | 'model_error'
  | 'blocking_limit'
  | 'stop_hook_prevented'
  | 'hook_stopped'
  | 'unrecoverable_tool_error' // 同一工具连续报同类错达阈值 → 循环兜底(移植 agentic_os 02.4)
  | 'handed_off' // 本 agent 经 HandoffSink 把控制权交出(pop_self/abort 等),loop 收口
  | 'max_turns';

export type ContinueReason =
  | 'next_turn'
  | 'collapse_drain_retry'
  | 'reactive_compact_retry'
  | 'max_output_tokens_escalate'
  | 'max_output_tokens_recovery'
  | 'stop_hook_blocking'
  | 'token_budget_continuation';

export interface Terminal {
  reason: TerminalReason;
  error?: unknown;
  turnCount?: number;
}

// ─── AgentContext —— 一个 agent 的运行环境 ────────────────────────────────

export interface AgentLoopConfig {
  systemPromptSlots: Slot[];
  /** host 可控稳定首段（T0 魂 / M4 preamble；详见 C7）。 */
  leadingSystemText?: string | (() => string | null);
  model: string;
  fallbackModel?: string;
  tools: AgentTool[];
  maxTurns?: number;
  /** token 目标（taskBudget；用于 token_budget_continuation）。 */
  taskBudget?: { total: number };
}

export interface AgentContext {
  agentId: string;
  agentType?: string;
  provider: LLMProvider;
  config: AgentLoopConfig;
  /** 派生工具调用上下文（host 注入 IO 能力）。 */
  toolContext: Omit<ToolContext, 'signal'>;
}

// ─── AgentEvent —— loop 对外吐出的事件（原生 API 消费；FACADE 翻成 KernelEvent）─

export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'stage'; stage: LoopStage; turn: number }
  | { type: 'stream'; event: unknown } // 透传 provider 流事件
  | { type: 'assistant'; message: CoreEvent }
  | { type: 'tool_call'; toolName: string; toolUseId: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; result: CoreEvent }
  | { type: 'turn_end'; turn: number; usageContextRatio?: number }
  | { type: 'turn_aborted'; turn: number } // interrupt 必发
  | { type: 'done'; terminal: Terminal };

// ─── Agent —— 原生 API（stateful，跨 turn）────────────────────────────────

export interface RunInput {
  /** 本轮用户输入（normal）或内部命令（agent_command）。 */
  input: CoreEvent;
  scenario?: LoopScenario;
  signal?: AbortSignal;
  /** host-owned 历史（FACADE 消费 TurnRequest.history 时 seed；native 内核语义，
   *  对齐 contract.ts TurnRequest.history "NATIVE forgeax-core kernel CONSUMES it"）。 */
  history?: ProviderMessage[];
}

export interface Agent {
  readonly id: string;
  /** 跑一轮（可能内含多 turn 工具循环），吐 AgentEvent 流，以 done 结束。 */
  run(input: RunInput): AsyncIterable<AgentEvent>;
  /** 中断当前 run（触发 interrupt 场景，必发 turn_aborted）。 */
  abort(reason?: string): void;
}
