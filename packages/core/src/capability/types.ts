/**
 * Capability ABI — the contract every tool / slot / plugin implements (C2).
 *
 * 设计稿: core-layer-spec §3.4 (capability host) + 最终实现方案 §0″ (干净律：core
 * 只出 ABI，具体包 ②/③/④ 经 loader 注入)。
 * Tool 接口 + buildTool 默认 fail-closed。
 *
 * Boundary: 仅 import core-local 类型。这是 host 与 capability 包之间唯一的接缝——
 * loader 按本 ABI 发现/加载/dispatch，LOOP/PERM 按本 ABI 解析与把闸。
 */
import type { CoreEvent } from '../events/types';
import type { Observability } from '../observability/contract';

// ─── 共享原语 ──────────────────────────────────────────────────────────────

/** JSON Schema 对象（MCP 工具直接给 JSON Schema，本地工具多用 zod→此形）。 */
export type JSONSchema = Record<string, unknown>;

/** 一次工具调用的执行环境（host 注入）。 */
export interface ToolContext {
  /** 取消信号——abort 必须中断 call() 并释放资源（不变量 §6.12）。 */
  signal: AbortSignal;
  /** 本 agent / 子系统 id。 */
  agentId?: string;
  agentType?: string;
  /** 已合并的只读配置视图（经 inject ConfigSource）。 */
  config?: Readonly<Record<string, unknown>>;
  /** 进度回调（流式工具结果用）。 */
  onProgress?: (p: unknown) => void;
  /** 本工具调用的 id（hooks / 权限关联）。 */
  toolUseId?: string;
  /** 008:结构化提问接缝（AskUserQuestion 工具用；host 经 inject 挂，缺省时工具优雅降级）。
   *  签名同 inject 的 `AskQuestionFn`；此处用结构等价的可选形避免 capability→inject 的反向 import。 */
  askQuestion?: (
    questions: ReadonlyArray<{ question: string; header: string; options: ReadonlyArray<{ label: string; description?: string }>; multiSelect?: boolean }>,
    signal?: AbortSignal,
  ) => Promise<Array<{ selected: string[]; other?: string }>>;
  /** ★ 可观测性(trace+log):工具内部经 ctx.observability 起 child span / 打 log。
   *  host 经 toolContext 注入;缺省时工具不产 telemetry(优雅降级)。见 observability/contract.ts。 */
  observability?: Observability;
  /** 调用者可挂任意 host 能力（terminal/fs/... 经 inject 提供）。开放形状。 */
  [key: string]: unknown;
}

/** 工具返回。`contextModifier` 仅对
 *  非并发安全工具生效（§6）。 */
export interface ToolResult<T = unknown> {
  data: T;
  /** 工具产生的附加消息（如错误提示、附件）。 */
  newMessages?: CoreEvent[];
  /** 修改后续 ToolContext（仅串行/非并发安全工具）。 */
  contextModifier?: (ctx: ToolContext) => ToolContext;
  /** MCP 工具透传的结构化 meta。 */
  mcpMeta?: unknown;
}

// ─── 权限把闸（被 PERM 消费，C2 的一部分）────────────────────────────────

export type PermissionBehavior = 'allow' | 'deny' | 'ask' | 'passthrough';

export interface PermissionResult {
  behavior: PermissionBehavior;
  /** allow/ask 可携带修正后的输入。 */
  updatedInput?: unknown;
  /** deny/ask 的人类可读理由。 */
  message?: string;
  /** 结构化决策来源（rule/hook/classifier/mode）。 */
  decisionReason?: { type: string; [k: string]: unknown };
}

export type ValidationResult =
  | { result: true }
  | { result: false; message: string; errorCode?: number };

// ─── AgentTool —— 工具 ABI ─────────────────────

export interface AgentTool<Input = unknown, Output = unknown> {
  // identity / discovery
  readonly name: string;
  /** model-facing 工具描述 → wire `tools[].description`。缺省时 provider 回落 searchHint。 */
  description?: string;
  /** 改名回溯别名。 */
  aliases?: string[];
  /** ToolSearch 关键词命中提示。 */
  searchHint?: string;
  /** 延迟加载（发 defer_loading:true，需先 ToolSearch）。 */
  shouldDefer?: () => boolean;
  /** 永不延迟（alwaysLoad / MCP `anthropic/alwaysLoad`）。 */
  alwaysLoad?: boolean;
  /** MCP 工具标记 + 来源（名 `mcp__server__tool`）。 */
  isMcp?: boolean;
  mcpInfo?: { serverName: string; toolName: string };

  // schema —— 二选一：本地 zod-like 或 MCP 原样 JSON Schema
  readonly inputSchema?: { parse(x: unknown): Input; safeParse(x: unknown): { success: boolean; data?: Input } };
  readonly inputJSONSchema?: JSONSchema;
  readonly outputSchema?: JSONSchema;
  strict?: boolean;

  // 安全 / 并发谓词（驱动串并行 + 把闸；默认 fail-closed，见 buildTool）
  isEnabled(): boolean;
  isConcurrencySafe(input: Input): boolean;
  isReadOnly(input: Input): boolean;
  isDestructive?(input: Input): boolean;
  /** 中断行为：cancel | block（默认 block）。 */
  interruptBehavior?(): 'cancel' | 'block';

  // 权限 ABI（PERM 消费）
  validateInput?(input: Input, ctx: ToolContext): Promise<ValidationResult>;
  /** 仅在 validateInput 通过后调用；通用逻辑在 PERM。 */
  checkPermissions(input: Input, ctx: ToolContext): Promise<PermissionResult>;
  /** 给 observers/hooks 看的字段补全；必须幂等，且不可改回流 API 的原始输入
   *  （保 prompt cache 字节稳定）。 */
  backfillObservableInput?(input: Input): Input;

  // 执行
  call(input: Input, ctx: ToolContext): Promise<ToolResult<Output>>;

  // 结果映射 / 大小
  /** Output → 可回灌的消息块。 */
  mapResult(output: Output, toolUseId: string): CoreEvent;
  /** 超过此字符数则 persist-to-preview（Infinity=永不）。 */
  maxResultSizeChars: number;

  // 渲染（可选，host 决定）
  renderToolUseMessage?(input: Input): string;
}

/** 可缺省的字段集（buildTool 填默认）。 */
export type ToolDef<I = unknown, O = unknown> = Omit<
  AgentTool<I, O>,
  'isEnabled' | 'isConcurrencySafe' | 'isReadOnly' | 'checkPermissions'
> &
  Partial<Pick<AgentTool<I, O>, 'isEnabled' | 'isConcurrencySafe' | 'isReadOnly' | 'checkPermissions'>>;

/** 默认 fail-closed：未声明并发安全/只读/可破坏 → 保守为
 *  否；checkPermissions 默认 allow（真正的把闸在 PERM 规则引擎前置）。 */
export function buildTool<I, O>(def: ToolDef<I, O>): AgentTool<I, O> {
  return {
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    checkPermissions: async (input) => ({ behavior: 'allow', updatedInput: input }),
    ...def,
  } as AgentTool<I, O>;
}

// ─── Slot —— system prompt 片段（动态/静态同一接口；详见 context/types C7）──

export interface SlotContext {
  agentId?: string;
  config?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface Slot {
  readonly name: string;
  /** 计算注入文本；返回 null = 本轮不注入。 */
  render(ctx: SlotContext): string | null | Promise<string | null>;
  /** 是否每轮重算（动态）。静态 slot 缓存到 /clear|/compact。 */
  dynamic?: boolean;
  /** 该 slot 进哪个缓存域（详见 C7 CacheScope）。 */
  cacheScope?: 'global' | 'org' | null;
}

// ─── Plugin —— 后台进程，订阅 EventBus 做副作用 ───────────────────────────

export interface PluginContext {
  agentId?: string;
  config?: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface Plugin {
  readonly name: string;
  /** start 时挂订阅；返回 dispose。 */
  start(ctx: PluginContext): Promise<() => void> | (() => void);
}

// ─── 包级准入条件（统一 evaluator §3.4.9，三处复用同一函数）────────────────

export interface ConditionContext {
  role?: string;
  config?: Readonly<Record<string, unknown>>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 包级 condition：按 role/config/STATUS 决定整包是否激活。 */
export type CapabilityCondition = (ctx: ConditionContext) => boolean;

// ─── Capability pack —— loader 从目录加载的单位 ───────────────────────────

export type CapabilityLayer = 'builtin' | 'user' | 'session' | 'agent';

export interface CapabilityPack {
  readonly name: string;
  readonly layer: CapabilityLayer;
  tools?: AgentTool[];
  slots?: Slot[];
  plugins?: Plugin[];
  /** 包级准入；缺省=总激活。 */
  condition?: CapabilityCondition;
}
