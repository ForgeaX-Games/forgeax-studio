/**
 * Provider 接口 (C4) — LLM 调用层的契约。
 *
 * 设计稿: 最终实现方案 §2/§3 (provider 抽自 llm/，唯一封装 @anthropic-ai/*) +
 * core-layer-spec §3.3 (provider 两正交轴：backend / model 代际，不 fork)。
 * 职责: 请求构造 + 流循环 + 重试 + 错误映射 + prompt-cache 断点检测。
 *
 * LOOP 经本接口调模型、消费流式事件；它不知 backend/SDK 细节（K2 解耦）。
 * Boundary: 仅 import core-local 类型。具体 provider 实现（anthropic/openai/...）
 * 在 provider/ 子模块，唯一允许 import @anthropic-ai/* 等运行时依赖处。
 */

// ─── 请求形状 ─────────────────

/** system prompt 块——每块带 cacheScope，决定 cache_control 边界（C7）。 */
export interface SystemBlock {
  type: 'text';
  text: string;
  cacheScope?: 'global' | 'org' | null;
  /** 仅作内部 static/dynamic cache 分界标记(SYSTEM_PROMPT_DYNAMIC_BOUNDARY),
   *  不是给模型看的内容——provider 转 wire 时必须剔除,否则哨兵串泄漏给模型。 */
  boundary?: boolean;
}

/** 发给模型的消息（provider 中立形；具体映射在各 backend）。 */
export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: unknown; // string | ContentBlock[]——backend 各自规范化
}

/** 工具定义传给模型（name + schema）。 */
export interface ProviderToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ThinkingConfig {
  type: 'enabled' | 'disabled' | 'adaptive';
  budgetTokens?: number;
  /** adaptive 思考的展示模式;`summarized` 才会流式吐 thinking 增量(UI 可见思考)。
   *  缺省不发 → 模型仍思考但不显示(实测 adaptive 不带 display 时 thinking_delta=0)。 */
  display?: 'summarized';
}

export interface ProviderRequest {
  model: string;
  system: SystemBlock[];
  tools: ProviderToolDef[];
  messages: ProviderMessage[];
  thinking?: ThinkingConfig;
  maxOutputTokens?: number;
  /** thinking 禁用时才发（thinking 开启要求 temp=1，省略）。 */
  temperature?: number;
  /** 关联/计费 source（决定 beta header 与缓存 latch）。 */
  querySource?: string;
  /** 开启 prompt caching（默认按 backend）。 */
  enablePromptCaching?: boolean;
  /** fire-and-forget fork：cache 标记打倒数第二条（skipCacheWrite）。 */
  skipCacheWrite?: boolean;
  /** 子 agent id（影响 betas）。 */
  agentId?: string;
}

// ─── 用量（累计语义）──────────────────

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** 1h/5m ephemeral 细分（可选）。 */
  cacheCreation?: { ephemeral1h?: number; ephemeral5m?: number };
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** 累计 usage：input/cache 只在 >0 时覆盖（防 message_delta 的 0 冲掉真值）；
 *  output 直接取最新。 */
export function mergeUsage(acc: Usage, next: Partial<Usage>): Usage {
  return {
    inputTokens: next.inputTokens && next.inputTokens > 0 ? next.inputTokens : acc.inputTokens,
    outputTokens: next.outputTokens ?? acc.outputTokens,
    cacheCreationInputTokens:
      next.cacheCreationInputTokens && next.cacheCreationInputTokens > 0
        ? next.cacheCreationInputTokens
        : acc.cacheCreationInputTokens,
    cacheReadInputTokens:
      next.cacheReadInputTokens && next.cacheReadInputTokens > 0
        ? next.cacheReadInputTokens
        : acc.cacheReadInputTokens,
    cacheCreation: next.cacheCreation ?? acc.cacheCreation,
  };
}

// ─── 流式事件（流循环）──────────────────

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'model_context_window_exceeded'
  | null;

export type ProviderStreamEvent =
  | { type: 'message_start'; usage: Partial<Usage>; ttftMs?: number }
  | { type: 'content_block_start'; index: number; blockType: 'text' | 'thinking' | 'tool_use' | 'server_tool_use' }
  | { type: 'content_block_delta'; index: number; delta: unknown }
  | { type: 'content_block_stop'; index: number; block: unknown }
  | { type: 'message_delta'; usage: Partial<Usage>; stopReason: StopReason }
  | { type: 'message_stop' }
  /** provider 规范化后吐出的一条完整 assistant 消息（content_block_stop 时）。 */
  | { type: 'assistant'; message: unknown; usage: Usage; stopReason: StopReason; requestId?: string };

// ─── Provider 接口 ─────────────────────────────────────────────────────────

export interface ProviderCallOpts {
  signal: AbortSignal;
  /** 切模型回调（流式 fallback 时 LOOP 决定真正切换）。 */
  onStreamingFallback?: () => void;
  fallbackModel?: string;
}

export interface LLMProvider {
  /** backend+model 代际标识（不 fork：差异走 api_base / per-model hook）。 */
  readonly api: string;
  /** 流式调用；返回异步事件流。abort 必中断。 */
  stream(req: ProviderRequest, opts: ProviderCallOpts): AsyncIterable<ProviderStreamEvent>;
}

/** provider 工厂（apiKey + baseUrl 经 ConfigSource per-session 注入，支持 M4 伪装路：
 *  core 只见 baseUrl+token，sidecar 改写出口）。 */
export interface ProviderFactoryOpts {
  apiKey: string;
  baseUrl?: string;
  /** 额外出口 header（M1/M2/M4 由 host/sidecar 注入；core 不解释）。 */
  headers?: Record<string, string>;
}
export type ProviderFactory = (opts: ProviderFactoryOpts) => LLMProvider;

// ─── 错误类型 ───────────────────────────

/** 529 连发达阈值 + 有 fallbackModel → 上抛此错，由 LOOP 切模型。 */
export class FallbackTriggeredError extends Error {
  constructor(public readonly originalModel: string, public readonly fallbackModel: string) {
    super(`fallback ${originalModel} → ${fallbackModel}`);
    this.name = 'FallbackTriggeredError';
  }
}

/** 不可重试。 */
export class CannotRetryError extends Error {
  constructor(public readonly originalError: unknown, message?: string) {
    super(message ?? 'cannot retry');
    this.name = 'CannotRetryError';
  }
}

/** PROMPT_TOO_LONG：content 用固定串（UI 精确匹配），token 数进 errorDetails 供
 *  reactive compact 解析 gap。 */
export const PROMPT_TOO_LONG_MESSAGE = 'Prompt is too long';
