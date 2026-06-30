/**
 * CoreAgent (Wave3 LOOP) — implements the C5 `Agent` contract by wiring the
 * frozen seams: EventBus(K1) · provider.stream(K2) · capability registry(K3) ·
 * system-prompt assembler(K4) · permission engine + tool dispatch(K5).
 *
 * queryLoop 的 normal 每迭代阶段顺序 + 三场景
 * (最终方案 §5)。这是耦合最密的集成枢纽,由单一集成者编写(WBS §4),不 fan-out。
 * Boundary: 仅 core 相对 import。
 */
import type {
  Agent,
  AgentContext,
  AgentEvent,
  RunInput,
  Terminal,
  TerminalReason,
} from './types';
import type { CoreEvent } from '../events/types';
import type { Observability } from '../observability/contract';
import { NOOP_OBS } from '../observability/contract';
import { briefError } from '../observability/usage';
// ★ v3/B 档:span 走 explicit parent —— 只取 @opentelemetry/api 的 trace.setSpan / ROOT_CONTEXT /
//   Span 类型。机制层唯一允许 import @opentelemetry/api 的两个入口之一(另一是 contract.ts);
//   永不读 context.active()/getActiveSpan()/baggage(显式 ctx 是唯一传播路径)。
import { trace, ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import { EventBus } from '../events/event-bus';
import { CoreEventType } from '../events/events';
import type { ProviderMessage, ProviderRequest, ProviderToolDef, SystemBlock, StopReason } from '../provider/types';
import { systemPromptAssembler } from '../context/system-prompt';
import type { SystemPromptAssembler } from '../context/types';
import type { PermissionRuleSet } from '../permission/rules';
import type { PermissionMode } from '../permission/engine';
import { dispatchTools, type ToolUse, type AskUserFn, type ToolDispatchResult } from './dispatch';
import type { Slot, AgentTool } from '../capability/types';
import { streamWithRetry, type StreamRetryConfig } from '../provider/stream-retry';
import { computeWatermarks, computeWatermarksFromModel } from '../context/watermarks';
import type { CompactionStrategy } from '../context/types';
import { lookupModelContext } from '../context/model-context-table';
import {
  evaluateGate,
  markCompactStart,
  markCompactSuccess,
  markCompactFailure,
  initialGateState,
} from '../context/compaction-gate';
import { runCompaction } from '../context/compaction-pipeline';
import { rehydrate } from '../context/post-compact-rehydrate';
import {
  CompactType,
  compactTrigger,
  DEFAULT_GATE_CONFIG,
  type CompactionGateState,
  type CompactionGateConfig,
  type ModelContextInfo,
  type WatermarkConfig,
  type CompactSummarize,
  type SummaryScenario,
} from '../context/compaction-types';
import { ensureToolResultPairing } from '../context/tool-pairing';
import { applyResultBudget } from '../context/tool-result-budget';
import { buildToolSearchTool, formatDeferredManifest } from '../capability/tool-search';
import {
  shouldContinueOnMaxTokens,
  buildContinuationMessage,
  isPromptTooLong,
  isOverBlockingLimit,
} from '../context/reactive-recovery';
import { evaluateStopHook, type StopHookPublishResult } from './stop-hook';
import { isBudgetExhausted, shouldContinueForBudget } from './token-budget';
import { ReadTracker } from '../capability/read-tracker';
import { aggregateErrorCategories, summarizeErrorStats } from '../diagnostics/error-stats';
import type { HandoffSink, HandoffIntent, HandoffResolution } from '../inject/types';
import { HANDOFF_INTENT_KEY } from '../capability/builtin-tools/message-tools';
import { EXIT_PLAN_INTENT_KEY } from '../capability/builtin-tools/plan-tools';

/**
 * Compaction V2(压缩改造,可选;注入即激活新路径,缺省走旧 `compaction` strategy → 零回归)。
 * 把 Stream A–F 接进 loop:比例 per-model 水位 + 有序触发闸(冷却/熔断/querySource)+
 * 三层管线(L1 剥离→sufficiency 短路→L2 LLM)+ 压后重挂 + 三 CompactType + pre-message 预压。
 */
export interface CompactionV2Options {
  /** host 注入的摘要器(带 scenario);core 不自调 LLM。 */
  summarize: CompactSummarize;
  /** 模型上下文信息;不传则按 context.config.model 查内置表(model-context-table)。 */
  modelInfo?: ModelContextInfo;
  /** 比例水位覆写(preCompact 0.80 / emergency 0.92 / warning 0.60 默认 + env)。 */
  watermarkConfig?: WatermarkConfig;
  /** 触发闸配置(cooldown 30s / 熔断 3 默认)。 */
  gateConfig?: CompactionGateConfig;
  /** L1 后 ≤ effective×ratio 跳过 LLM,默认 0.15。 */
  sufficiencyRatio?: number;
  /** 压缩范围外保留尾部条数,默认 0。 */
  messagesToKeep?: number;
  /** 自动压总开关,默认 true。 */
  autoCompactEnabled?: boolean;
  /** 来源标记(摘要 / subagent 内部传 'summary'/'subagent-internal' 防递归自压)。 */
  querySource?: string;
  /** 启用 pre-message 预压(turn 顶部按 preCompactThreshold 静默预压),默认 true。 */
  preMessage?: boolean;
  /** 压后重挂(简化版):取最近读过的文件重挂。 */
  rehydrate?: {
    recentReadPaths: () => readonly string[];
    readFile: (path: string) => Promise<string>;
    tokenBudget?: number;
    maxFiles?: number;
  };
  /** 当前时间源(注入,便于测 cooldown);默认 () => Date.now()。 */
  nowFn?: () => number;
}

/** auto-memory 钩子:loop 每 user turn 调 recall(注入相关
 *  记忆作 system-reminder),done 后调 extract(后台抽取持久记忆)。AutoMemory 结构满足之。 */
export interface AutoMemoryHook {
  recall(query: string, signal?: AbortSignal): Promise<string | null>;
  extract(messages: Array<{ role: string; content: unknown }>, signal?: AbortSignal): Promise<void>;
}

export interface CoreAgentOptions {
  context: AgentContext;
  bus?: EventBus;
  rules?: Partial<PermissionRuleSet> | null;
  mode?: PermissionMode;
  /** 启用 core 内置受保护路径 safetyCheck(.git/.forgeax/shell-rc)。默认 false——
   *  core 不默认限路径,权限归 host。CLI 独立形态(host 自管)可显式开。 */
  enableSafetyCheck?: boolean;
  assembler?: SystemPromptAssembler;
  /** static/dynamic slot 二分(默认全 static)。 */
  globalCacheEnabled?: boolean;
  /** compaction 策略(③ 注入);缺省=不压缩(§12 strategy 作 capability 注入)。 */
  compaction?: CompactionStrategy;
  /** ★ Compaction V2(注入即激活新压缩路径;与 `compaction` 互斥,V2 优先)。 */
  compactionV2?: CompactionV2Options;
  /** 上下文窗口 token 数(算水位用),默认 200k。 */
  contextWindow?: number;
  /** stage4 流式重试/fallback 配置。 */
  retry?: StreamRetryConfig;
  /** auto-memory:开箱即自动召回 + 自动抽取。 */
  autoMemory?: AutoMemoryHook;
  /** micro-compaction(**每轮** pre-API 清旧 tool result,time-based)。纯函数,缺省不跑。 */
  microCompact?: (messages: ProviderMessage[]) => ProviderMessage[];
  /** 交互式权限:'ask' 判定时咨询 host(REPL 提示);无则 fail-closed deny。 */
  askUser?: AskUserFn;
  /** thinking(扩展思考)请求配置;缺省=不开。透传到 provider(anthropic 已支持)。 */
  thinking?: ProviderRequest['thinking'];
  /** mid-turn steering:每 turn 顶部 drain 一次,把返回的消息 append 进上下文(回合中插话)。
   *  返回空数组=本轮无插话。 */
  steeringSource?: () => ProviderMessage[];
  /** 同一工具(name+args)连续报错达此次数 → 循环兜底终止(移植 agentic_os 02.4)。
   *  默认 2;设 0 或 Infinity 关闭。 */
  maxToolErrorStreak?: number;
  /** 反应式续轮(max_output_tokens 续写 / stop-hook prevented / token-budget)的硬上限,
   *  防无限循环。默认 4;设 0 关闭这些续轮(回退到「该停就停」)。 */
  maxContinuations?: number;
  /** 同一文件重复读越线阈值 K(对齐 agentic_os same_file_read_limit);默认 20。
   *  越线后注入 system-reminder 提示复用,绝不硬杀。 */
  sameFileReadLimit?: number;
  /** 开机回放(resume/replay)的历史 seed:normal 场景下作内核内置历史**置于最前**,
   *  在 input.history(FACADE host-owned seed)与本轮 user 输入之前。由 run.ts 从
   *  EventStore.read() → foldEvents 重建得到(设计稿 §3.8.7 / §6.1)。不传 = 空,
   *  行为与今天逐字一致(纯函数式,§6.5)。 */
  initialMessages?: ProviderMessage[];
  /** ★ 多 agent 协作:handoff 调度接缝(§4.2)。注入后,模型经 `Handoff` 工具发出的意图
   *  会在 handoff_decision 阶段经 `declare(intent)` 交给 host 调度器,按 resolution 续转/
   *  收口/等待。**缺省不注入 → handoff_decision 维持单 agent no-op(零行为变化)。 */
  handoff?: HandoffSink;
  /** ★ 多 agent 协作:peer 消息收件箱(可选)。host 把投递给本 agent 的消息(常来自他人
   *  的 `SendMessage` → `agent.message` 事件)经此回调暴露;loop 每 turn 顶部 drain 一次,
   *  把消息作 user 轮 append 进上下文(与 steeringSource 同机制,二者皆 drain)。返回空数组=
   *  本轮无新消息。**缺省不注入 → 零行为变化(peer 消息纯靠 host 经 steeringSource 灌)。 */
  inbox?: () => ProviderMessage[];
  /** ★ 可观测性(trace+log)注入缝 —— loop 真正读的主缝(v3/B 档)。缺省 → 兜底 NOOP_OBS:
   *  tracer noop(不出 span)、logger noop,零行为变化。注入后 run() 顶部建本轮 root span +
   *  span-bound child logger(显式 ctx 下传,不押 active-context)。见 observability/contract.ts。 */
  observability?: Observability;
  /** ★ v3/B 档:本轮 root span(由 kernel-facade runTurn 顶部建,显式下传)。run() 把 agent.run
   *  span 建成它的**显式** child(`trace.setSpan(ROOT_CONTEXT, parentSpan)`),保并发下父子树不串。
   *  缺省 → agent.run 作 root span(library/独立形态)。本字段内部于 core,不对外契约(其它 track
   *  不依赖)。绝不读 active-context —— parent 只认这个显式参数。 */
  parentSpan?: Span;
}

/** 粗估 messages token 数(量级:~4 char/token)。 */
function estimateTokens(messages: ProviderMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  return Math.ceil(chars / 4);
}

/** 稳定 JSON 序列化(键排序):用作「同 tool + 同 args」循环兜底的去重 key。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

interface AssistantBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

/** 从 provider 规范化后的 assistant message 抽 tool_use 块(anthropic-ish 形状)。 */
function extractAssistant(message: unknown): { content: AssistantBlock[]; toolUses: ToolUse[] } {
  const content: AssistantBlock[] =
    message && typeof message === 'object' && Array.isArray((message as { content?: unknown }).content)
      ? ((message as { content: AssistantBlock[] }).content)
      : [];
  const toolUses: ToolUse[] = content
    .filter((b) => b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
    .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input }));
  return { content, toolUses };
}

/** read 类工具调用的目标路径(用于 same-file read 计数);非 read / 无路径 → null。
 *  判定:工具名形似 read(read_file/read/Read)或声明 isReadOnly(input)===true,
 *  且 input 带 path / file_path 字符串字段。fail-open:任何不确定 → null(不计数)。 */
function readPathOf(use: ToolUse, tools: AgentTool[]): string | null {
  const input = use.input;
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const path = typeof rec.path === 'string' ? rec.path : typeof rec.file_path === 'string' ? rec.file_path : null;
  if (path == null) return null;
  const nameLooksRead = /(^|_|\.)read(_file)?$/i.test(use.name) || use.name.toLowerCase() === 'read';
  let readOnly = false;
  const tool = tools.find((t) => t.name === use.name || (t.aliases?.includes(use.name) ?? false));
  if (tool) {
    try {
      readOnly = tool.isReadOnly(input);
    } catch {
      readOnly = false;
    }
  }
  return nameLooksRead || readOnly ? path : null;
}

/** tool_result.content 必须是 string 或 content-block 数组(Anthropic/OpenAI 皆然);
 *  工具 mapResult 的 payload 多为对象 → 这里规整成字符串,否则回灌时 provider 400
 *  (真 e2e 实测:对象 content → 次轮 model_error)。 */
function toolResultContent(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  // 优先取常见文本字段(bash stdout / 工具 message / result),否则整体 JSON 化。
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.stdout === 'string' && p.stdout.length > 0) return p.stdout;
    if (typeof p.message === 'string') return p.message;
    if (typeof p.result === 'string') return p.result;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** 多模态(011):从 tool.result payload 取 image content blocks(read_file 读图时挂在
 *  payload.imageBlocks)。无图返回 []。只挑形状合法的 `{type:'image',source}` 项,避免
 *  把脏数据塞进回灌内容触发 provider 400。 */
function imageBlocksFromPayload(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return [];
  const arr = (payload as Record<string, unknown>).imageBlocks;
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (b): b is Record<string, unknown> =>
      !!b &&
      typeof b === 'object' &&
      (b as Record<string, unknown>).type === 'image' &&
      typeof (b as Record<string, unknown>).source === 'object',
  );
}

/** 从 user 消息 payload 取文本(用于 auto-memory 召回 query)。payload 为纯字符串时直返;
 *  为多模态 content 数组时,拼接其中的 text 块(忽略 image/其它块,避免 base64 进检索)。 */
function userQueryText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) {
    return payload
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** hook 决议合并到 publish 回执上的 structured-output 字段(additive,未挂在
 *  CoreEvent 类型上,from-settings.ts 经 ctl.modify 注入)。loop 从回执读出:
 *  - additionalContext:注入下一轮 prompt 的附加上下文(system-reminder)。
 *  - systemMessage:展示/写 system 通道的一段消息。
 *  - continueLoop===false:hook 请求 loop 停止轮转(优雅停)。 */
interface HookExtraReceipt {
  additionalContext?: string;
  systemMessage?: string;
  continueLoop?: boolean;
}

/** 从 publish 回执(可能被 hook ctl.modify 合并了 structured-output 字段)提取
 *  additionalContext / systemMessage / continueLoop。无 hook 注入时三者皆 undefined。 */
function readHookExtra(receipt: CoreEvent): HookExtraReceipt {
  const r = receipt as CoreEvent & HookExtraReceipt;
  return {
    additionalContext: typeof r.additionalContext === 'string' ? r.additionalContext : undefined,
    systemMessage: typeof r.systemMessage === 'string' ? r.systemMessage : undefined,
    continueLoop: r.continueLoop === false ? false : undefined,
  };
}

/** 提取一条 newMessage(如 skill.prompt)给模型读的文本。 */
function newMessageText(ev: CoreEvent): string {
  const p = ev.payload as Record<string, unknown> | undefined;
  if (p) {
    if (typeof p.prompt === 'string') return p.prompt;
    if (typeof p.text === 'string') return p.text;
    if (typeof p.message === 'string') return p.message;
  }
  return '';
}

/** 从本轮工具结果里取出 `Handoff` 工具打进 payload 的 HandoffIntent(键见 message-tools)。
 *  多条 handoff 取**第一条**(单 turn 一个 handoff 语义最清晰);无 → null。 */
function extractHandoffIntent(
  results: { result: CoreEvent }[],
): HandoffIntent | null {
  for (const r of results) {
    const payload = r.result.payload as Record<string, unknown> | undefined;
    if (payload && HANDOFF_INTENT_KEY in payload) {
      const intent = payload[HANDOFF_INTENT_KEY];
      if (intent && typeof intent === 'object' && typeof (intent as { kind?: unknown }).kind === 'string') {
        return intent as HandoffIntent;
      }
    }
  }
  return null;
}

/** 本轮工具结果里是否含 ExitPlanMode sentinel(键见 plan-tools)。命中 → loop 把权限模式翻回 default。 */
function hasExitPlanIntent(results: { result: CoreEvent }[]): boolean {
  for (const r of results) {
    const payload = r.result.payload as Record<string, unknown> | undefined;
    if (payload && payload[EXIT_PLAN_INTENT_KEY] === true) return true;
  }
  return false;
}

/** 把 host 回传的子 agent 事件折成一条可回灌的 user 文本(child_result resolution)。
 *  简单 append:抽各事件里可读的文本(assistant text / result / message),拼成一段
 *  `<handoff-result>` 块喂回父模型。无可读文本时退回事件类型清单(至少让模型知道发生了什么)。 */
function foldHandoffEvents(events: CoreEvent[]): string {
  const parts: string[] = [];
  for (const ev of events) {
    const text = newMessageText(ev);
    if (text) {
      parts.push(text);
      continue;
    }
    const p = ev.payload as Record<string, unknown> | undefined;
    if (p) {
      if (typeof p.result === 'string') {
        parts.push(p.result);
        continue;
      }
      // assistant.message 形状:payload.content 里的 text 块。
      const content = (p as { content?: Array<{ type?: string; text?: string }> }).content;
      if (Array.isArray(content)) {
        const t = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
        if (t) {
          parts.push(t);
          continue;
        }
      }
    }
  }
  const body = parts.length > 0 ? parts.join('\n') : events.map((e) => e.type).join(', ') || '(no events)';
  return `<handoff-result>\n${body}\n</handoff-result>`;
}

function toolResultsToContent(
  results: { toolUseId: string; toolName: string; result: CoreEvent; isError: boolean; newMessages?: CoreEvent[] }[],
  budgetFor?: (toolName: string) => number,
): unknown {
  const blocks: unknown[] = results.map((r) => {
    // 全局预算兜底(移植 agentic_os 03.B):单 tool 声明 maxResultSizeChars,这里统一裁。
    const max = budgetFor?.(r.toolName) ?? Infinity;
    const { output } = applyResultBudget(toolResultContent(r.result.payload), max);
    // 多模态(011):工具(如 read_file 读图)在 payload 带 imageBlocks → tool_result.content
    //   组成 content 数组 [text, image…]。Anthropic 原样吃图;openai-compat 的
    //   toolResultToText 只取 text 块 → 优雅降级(丢图留文,不 400)。
    const images = imageBlocksFromPayload(r.result.payload);
    const content =
      images.length > 0 ? [{ type: 'text', text: output }, ...images] : output;
    return {
      type: 'tool_result',
      tool_use_id: r.toolUseId,
      content,
      is_error: r.isError,
    };
  });
  // 工具的 newMessages(如 skill inline 展开的 prompt)作 text 块并入**同一** user 轮
  // (不能另起一条 user 消息——会破坏 Anthropic 角色交替)。让模型看到展开后的指令并续跑。
  for (const r of results) {
    for (const m of r.newMessages ?? []) {
      const text = newMessageText(m);
      if (text) blocks.push({ type: 'text', text });
    }
  }
  return blocks;
}

export class CoreAgent implements Agent {
  readonly id: string;
  private readonly o: CoreAgentOptions;
  private readonly bus: EventBus;
  private readonly assembler: SystemPromptAssembler;
  private ac: AbortController | null = null;
  /** auto-memory 后台抽取的 in-flight promise(host 可 drain 等其落盘)。 */
  private pendingExtract: Promise<void> = Promise.resolve();
  /** Compaction V2 触发闸状态(冷却戳 / 熔断计数 / 压缩中标记;跨 turn 持有)。 */
  private gateState: CompactionGateState = initialGateState();
  /** 当前权限模式(可被 facade `setMode` 在运行中切换;ExitPlanMode 命中后翻回 default)。
   *  初值取 options.mode(缺省 'default'),从此**取代** o.mode 作为 dispatch 的权威模式源。 */
  private currentMode: PermissionMode;
  /** 当前模型(可被 facade `setModel` 在运行中切换)。初值取 context.config.model,
   *  从此**取代** o.context.config.model 作为 buildRequest 的权威模型源。 */
  private currentModel: string;

  constructor(opts: CoreAgentOptions) {
    this.o = opts;
    this.id = opts.context.agentId;
    this.bus = opts.bus ?? new EventBus();
    this.assembler = opts.assembler ?? systemPromptAssembler;
    this.currentMode = opts.mode ?? 'default';
    this.currentModel = opts.context.config.model;
  }

  abort(reason?: string): void {
    this.ac?.abort(reason);
  }

  /** 运行中切换权限模式(facade `TurnHandle.setPermissionMode` → translateNeutral → 此)。
   *  影响后续 turn 的 dispatch 把闸;当前正在执行的工具批不回溯。 */
  setMode(m: PermissionMode): void {
    this.currentMode = m;
  }

  /** 运行中切换模型(facade `TurnHandle.setModel` → 此)。下一次 provider 调用即生效;
   *  正在飞的流不回溯。fallbackModel 仍取 context.config.fallbackModel(不随之变)。 */
  setModel(m: string): void {
    this.currentModel = m;
  }

  /** 等 auto-memory 后台抽取落盘完成(CLI 一次性模式退出前调)。 */
  async drainAutoMemory(): Promise<void> {
    await this.pendingExtract;
  }

  private ev<T>(type: string, payload: T): CoreEvent<T> {
    return { type, payload, ts: 0, source: this.id };
  }

  /** 反应式压缩一次:PreCompact → strategy.compact → 发 CompactionApplied/PostCompact →
   *  就地 splice(skip-and-replace)。返回是否真压缩了(count>0)。compact() 自身抛错
   *  时**向上抛**(由 caller 决定优雅终止,不在此吞,避免异常穿出 generator 崩整轮)。
   *  供 PROMPT_TOO_LONG 与 model_context_window_exceeded 两条反应式恢复路复用。 */
  private async reactiveCompactOnce(messages: ProviderMessage[], turn: number): Promise<boolean> {
    const strategy = this.o.compaction;
    if (!strategy) return false;
    this.bus.publish(this.ev(CoreEventType.PreCompact, { trigger: 'auto', tokenCount: estimateTokens(messages) }));
    const { replacement, coveredFrom, coveredTo } = await strategy.compact(messages);
    const count = Math.max(0, coveredTo - coveredFrom + 1);
    if (count <= 0) return false;
    this.bus.publish(this.ev(CoreEventType.CompactionApplied, { coveredFrom, coveredTo, replacement }));
    messages.splice(coveredFrom, count, replacement as ProviderMessage);
    this.bus.publish(this.ev(CoreEventType.PostCompact, { coveredFrom, coveredTo }));
    this.bus.publish(this.ev(CoreEventType.TurnAborted, { turn, reason: 'reactive_compact_retry' }));
    return true;
  }

  /** Compaction V2 水位(比例 + per-model)。 */
  private v2Watermarks() {
    const v2 = this.o.compactionV2!;
    const modelInfo = v2.modelInfo ?? lookupModelContext(this.o.context.config.model);
    return computeWatermarksFromModel(modelInfo, v2.watermarkConfig);
  }

  /**
   * Compaction V2 一次压缩尝试(闸 → PreCompact(可阻断)→ 管线 → CompactionApplied →
   * skip-and-replace splice → 重挂 → PostCompact → gate 状态)。
   * 返回 'compacted' | 'skipped';管线失败时 **throw**(caller 决定终态;此时 messages 未变 = 自动回滚,
   * 熔断计数已 +1)。`type` 决定阈值(emergency/preCompact)与摘要 scenario。
   */
  private async runCompactionV2(
    messages: ProviderMessage[],
    type: CompactType,
    turn: number,
    tokenCountHint?: number,
    force = false,
  ): Promise<'compacted' | 'skipped'> {
    const v2 = this.o.compactionV2!;
    const now = (v2.nowFn ?? (() => Date.now()))();
    const marks = this.v2Watermarks();
    const tokenCount = tokenCountHint ?? estimateTokens(messages);

    // 反应式路(provider 已报超长)force=true,绕过闸强压;否则走有序闸。
    if (!force) {
      const decision = evaluateGate({
        tokenCount,
        marks,
        type,
        state: this.gateState,
        now,
        querySource: v2.querySource,
        autoCompactEnabled: v2.autoCompactEnabled ?? true,
        config: v2.gateConfig ?? DEFAULT_GATE_CONFIG,
      });
      if (!decision.compact) return 'skipped';
    }

    // PreCompact(可阻断):hook 回执 blocked===true → 跳过本次压缩(E-I5)。
    const pre = this.bus.publish(
      this.ev(CoreEventType.PreCompact, { trigger: compactTrigger(type), tokenCount, type }),
    ) as CoreEvent & { blocked?: boolean };
    if (pre.blocked === true) return 'skipped';

    this.gateState = markCompactStart(this.gateState);
    const scenario: SummaryScenario =
      type === CompactType.PRE_MESSAGE_AUTO ? 'pre-message' : 'full';
    try {
      const result = await runCompaction({
        messages,
        scenario,
        marks,
        summarize: v2.summarize,
        sufficiencyRatio: v2.sufficiencyRatio ?? 0.15,
        messagesToKeep: v2.messagesToKeep ?? 0,
        now,
      });
      this.bus.publish(
        this.ev(CoreEventType.CompactionApplied, {
          coveredFrom: result.coveredFrom,
          coveredTo: result.coveredTo,
          replacement: result.replacement,
        }),
      );
      const count = Math.max(0, result.coveredTo - result.coveredFrom + 1);
      messages.splice(result.coveredFrom, count, result.replacement);

      // 压后重挂(#13):取最近文件附在 replacement 之后(replacement 现位于 coveredFrom)。
      if (v2.rehydrate) {
        const reh = await rehydrate({
          recentReadPaths: v2.rehydrate.recentReadPaths(),
          readFile: v2.rehydrate.readFile,
          tokenBudget: v2.rehydrate.tokenBudget ?? 10_000,
          maxFiles: v2.rehydrate.maxFiles ?? 1,
        });
        if (reh.attachments.length > 0) {
          messages.splice(result.coveredFrom + 1, 0, ...reh.attachments);
        }
      }

      this.bus.publish(
        this.ev(CoreEventType.PostCompact, {
          coveredFrom: result.coveredFrom,
          coveredTo: result.coveredTo,
          usedLLM: result.usedLLM,
        }),
      );
      this.gateState = markCompactSuccess(this.gateState, now);
      this.bus.publish(this.ev(CoreEventType.TurnAborted, { turn, reason: 'reactive_compact_retry' }));
      return 'compacted';
    } catch (e) {
      // 失败:messages 未 splice(自动回滚)+ 熔断计数 +1;上抛交 caller 处理终态。
      this.gateState = markCompactFailure(this.gateState);
      throw e;
    }
  }

  private buildRequest(system: SystemBlock[], messages: ProviderMessage[], toolset: AgentTool[]): ProviderRequest {
    const tools: ProviderToolDef[] = toolset.map((t) => {
      // model-facing 描述:显式 description 优先,回落 searchHint(总比裸名字强)。
      // 不带 → provider 不发该字段 → 模型只能靠名字猜工具(重构曾整段丢了这条接线)。
      const description = t.description ?? t.searchHint;
      return {
        name: t.name,
        ...(description ? { description } : {}),
        inputSchema: t.inputJSONSchema ?? {},
      };
    });
    // max_tokens 按模型查表(opus→64000),不再吃 provider 8192 兜底——后者会把
    // 「一次写整文件」截断成半截 JSON / 把单轮拖到撞上游 ~300s 超时。
    const maxOutputTokens = lookupModelContext(this.currentModel).maxOutputTokens;
    return {
      model: this.currentModel,
      system,
      tools,
      // 每次发 provider 前兜底 tool 配对(压缩/历史可能留孤儿 → 不修必 400)。
      messages: ensureToolResultPairing(messages),
      enablePromptCaching: true,
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(this.o.thinking ? { thinking: this.o.thinking } : {}),
    };
  }

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const scenario = input.scenario ?? 'normal';
    this.ac = new AbortController();
    const signal = mergeSignals(this.ac.signal, input.signal);

    // ─── interrupt 场景:必发 turn_aborted + done(aborted)──────────────────
    if (scenario === 'interrupt' || signal.aborted) {
      yield { type: 'turn_aborted', turn: 0 };
      this.bus.publish(this.ev(CoreEventType.TurnAborted, { turn: 0, reason: 'interrupt' }));
      yield { type: 'done', terminal: { reason: 'aborted_streaming' } };
      return;
    }

    // ─── agent_command 场景:trust channel,跳 LLM,直接 dispatch ───────────
    if (scenario === 'agent_command') {
      const cmd = input.input.payload as { name: string; input?: unknown };
      const results = await dispatchTools([{ id: 'cmd', name: cmd.name, input: cmd.input }], {
        tools: this.o.context.config.tools,
        toolContext: this.o.context.toolContext,
        signal,
        trusted: true,
      });
      for (const r of results) yield { type: 'tool_result', toolUseId: r.toolUseId, result: r.result };
      yield { type: 'done', terminal: { reason: 'completed' } };
      return;
    }

    // ─── normal 场景:多 turn 工具循环 ────────────────────────────────────
    const maxTurns = this.o.context.config.maxTurns ?? 16;
    // 开机回放 seed(resume/replay)在最前 → FACADE 注入的 host-owned 历史 seed → 本轮
    // user 输入(native 内核消费 TurnRequest.history)。initialMessages 不传则 [],行为不变。
    const messages: ProviderMessage[] = [
      ...(this.o.initialMessages ?? []),
      ...(input.history ?? []),
      { role: 'user', content: input.input.payload },
    ];

    // ★ SessionStart hook:normal run 开跑前发一次(整个 run 仅一次,
    //   turn 循环之前)。payload.source='agent' 标明本 session 由内核 agent 驱动。
    this.bus.publish(this.ev(CoreEventType.SessionStart, { sessionId: this.id, source: 'agent' }));

    // SessionEnd:normal run 收尾前发且只发一次。把它内联进 `done`(本闭包只在
    //   normal 路径可达——interrupt/agent_command 已在前面 return),配 sessionEnded
    //   幂等位,使每一处 `yield done(...)` 都自然带上 SessionEnd(reason 取终态)。
    let sessionEnded = false;
    const done = (reason: TerminalReason, extra?: Partial<Terminal>): AgentEvent => {
      if (!sessionEnded) {
        sessionEnded = true;
        this.bus.publish(this.ev(CoreEventType.SessionEnd, { sessionId: this.id, reason }));
      }
      return { type: 'done', terminal: { reason, ...extra } };
    };

    // ★ auto-memory 自动召回:每个 user turn 跑一次(per-turn prefetch),把相关
    //   记忆作 system-reminder 在本 run 各 turn 注入(dynamic slot,cacheScope=null)。
    // payload 可能是纯文本(常态)或多模态 content 数组([text, image…]);auto-memory 召回
    //   只用其中的文本块,避免把 base64 图片塞进检索 query。
    const userQuery = userQueryText(input.input.payload);
    const memReminder = this.o.autoMemory ? await this.o.autoMemory.recall(userQuery, signal) : null;
    const autoMemSlots: Slot[] = memReminder
      ? [{ name: 'auto-memory', dynamic: true, cacheScope: null, render: () => memReminder }]
      : [];

    // ★ hook 注入的附加上下文(UserPromptSubmit / Stop / PostToolUse 的 additionalContext):
    //   作 dynamic system-reminder slot(cacheScope=null)注入本 run 各 turn,与 auto-memory /
    //   deferred / same-file-read 同机制。各处 hook 决议把 additionalContext 合到事件回执上,
    //   loop 在此累加。
    const hookContextReminders: string[] = [];
    const hookContextSlots = (): Slot[] =>
      hookContextReminders.length > 0
        ? [{ name: 'hook-context', dynamic: true, cacheScope: null, render: () => hookContextReminders.join('\n') }]
        : [];

    // ★ UserPromptSubmit hook:turn 0 开跑前发一次。若回执(或合并其上的 hook
    //   决议)携带 additionalContext,注成下一轮可见的 system-reminder。
    const ups = this.bus.publish(this.ev(CoreEventType.UserPromptSubmit, { prompt: userQuery, turn: 0 }));
    const upsExtra = readHookExtra(ups);
    if (upsExtra.additionalContext) hookContextReminders.push(`<system-reminder>${upsExtra.additionalContext}</system-reminder>`);

    // ─── deferred tool loading + ToolSearch(无工具声明 shouldDefer 时与今天逐字一致)。
    const allTools = this.o.context.config.tools;
    const deferred = allTools.filter((t) => t.shouldDefer?.() === true && t.alwaysLoad !== true);
    const activeTools = deferred.length > 0 ? allTools.filter((t) => !deferred.includes(t)) : allTools;
    const activated = new Set<string>();
    const toolSearch =
      deferred.length > 0 ? buildToolSearchTool(deferred, (names) => names.forEach((n) => activated.add(n))) : null;

    // ─── 全局 tool-result 预算兜底(移植 agentic_os 03.B):单 tool 声明 maxResultSizeChars,LOOP 统一裁。
    const budgetMap = new Map<string, number>();
    for (const t of allTools) budgetMap.set(t.name, t.maxResultSizeChars);
    if (toolSearch) budgetMap.set(toolSearch.name, toolSearch.maxResultSizeChars);
    const budgetFor = (name: string): number => budgetMap.get(name) ?? Infinity;

    // ─── 真实 token 账(reactive autocompact):用上一轮 API 回传 prompt token 判水位。
    let lastPromptTokens = 0;
    // ─── token 预算(taskBudget):累计本 run 已花 token(output 增量累加)。
    const taskBudget = this.o.context.config.taskBudget;
    let spentTokens = 0;
    // ─── 循环兜底(移植 02.4):同一工具(name+args)连续报错计数。
    const errorStreak = new Map<string, number>();
    const maxStreak = this.o.maxToolErrorStreak ?? 2;
    // ─── 反应式续轮硬上限(max_tokens 续写 / stop-hook prevented / token-budget),防无限循环。
    const maxContinuations = this.o.maxContinuations ?? 4;
    let continuations = 0;
    // ─── 同一文件重复读计数(移植 same_file_read_limit);越线注入 system-reminder(下一轮)。
    const readTracker = new ReadTracker();
    const readLimit = this.o.sameFileReadLimit ?? undefined;
    const readReminders: string[] = [];
    const readReminderSlots = (): Slot[] =>
      readReminders.length > 0
        ? [{ name: 'same-file-read', dynamic: true, cacheScope: null, render: () => readReminders.join('\n') }]
        : [];

    // ★ v3/B 档 可观测性:本 run 的 agent.run span + span-bound child logger。
    //   parent 只认显式 this.o.parentSpan(kernel-facade runTurn 顶部建的本轮 root);缺省 → root。
    //   永不读 active-context。缺省 obs=NOOP_OBS → noop tracer 不出 span、noop logger 不出 log,
    //   零行为变化(§9 Graceful Degradation;loop 无需分支即可降级)。
    const obs = this.o.observability ?? NOOP_OBS;
    // agentType:CoreAgent 无独立类型概念,以 agentId 兜底(facade 在 root span 已盖 agentId)。
    const parentCtx = this.o.parentSpan ? trace.setSpan(ROOT_CONTEXT, this.o.parentSpan) : ROOT_CONTEXT;
    const runSpan = obs.tracer.startSpan('agent.run', { attributes: { agentId: this.id, agentType: this.id } }, parentCtx);
    const runSpanCtx = runSpan.spanContext();
    const log = obs.logger.child({ traceId: runSpanCtx.traceId, spanId: runSpanCtx.spanId, agentId: this.id });
    log.info('agent.run start', { maxTurns });
    let runStatus: 'ok' | 'error' = 'ok';
    let turnsRun = 0; // 诊断维度:本 run 实际进入了几轮(finally 盖到 span + done log)。
    try {
    for (let turn = 0; turn < maxTurns; turn++) {
      turnsRun = turn + 1;
      if (signal.aborted) {
        yield { type: 'turn_aborted', turn };
        this.bus.publish(this.ev(CoreEventType.TurnAborted, { turn, reason: 'abort' }));
        yield done('aborted_streaming');
        return;
      }
      yield { type: 'turn_start', turn };
      log.info('turn start', { turn });
      this.bus.publish(this.ev(CoreEventType.TurnStart, { turn }));

      // mid-turn steering:回合中插话——drain 队列把消息 append 进上下文。
      if (this.o.steeringSource) {
        const steer = this.o.steeringSource();
        if (steer.length > 0) {
          messages.push(...steer);
          this.bus.publish(this.ev('steering.injected', { turn, count: steer.length }));
        }
      }
      // peer 消息收件箱:与 steering 同机制,每 turn 顶部 drain 一次——把别的 agent 投来的
      //   消息(host 经 inbox 暴露)作 user 轮 append 进上下文,让模型本轮看到并续答。
      if (this.o.inbox) {
        const inbound = this.o.inbox();
        if (inbound.length > 0) {
          messages.push(...inbound);
          this.bus.publish(this.ev('inbox.drained', { turn, count: inbound.length }));
        }
      }

      // ★ Compaction V2 pre-message 预压(#11):turn 顶部按 preCompactThreshold(0.80)静默预压,
      //   比 emergency(0.92,stage3)更早、更平滑。闸内冷却/熔断兜底,失败不崩(吞 → 留给 stage3/反应式)。
      if (this.o.compactionV2 && this.o.compactionV2.preMessage !== false) {
        const tokenCount = lastPromptTokens > 0 ? lastPromptTokens : estimateTokens(messages);
        try {
          await this.runCompactionV2(messages, CompactType.PRE_MESSAGE_AUTO, turn, tokenCount);
        } catch {
          /* 预压失败不致命:交给 stage3 emergency / provider 反应式兜底 */
        }
      }

      // stage1 resolve capabilities —— effectiveTools = active + 已激活 deferred + ToolSearch。
      const tools: AgentTool[] = toolSearch
        ? [...activeTools, ...deferred.filter((d) => activated.has(d.name)), toolSearch]
        : activeTools;
      yield { type: 'stage', stage: 'resolve_capabilities', turn };
      this.bus.publish(this.ev(CoreEventType.CapabilitiesResolved, { toolNames: tools.map((t) => t.name) }));

      // 未激活 deferred 工具清单作 system-reminder 注入(dynamic、不缓存),供模型 ToolSearch。
      const deferredManifest = formatDeferredManifest(deferred.filter((d) => !activated.has(d.name)));
      const deferredSlots: Slot[] = deferredManifest
        ? [{ name: 'deferred-tools', dynamic: true, cacheScope: null, render: () => deferredManifest }]
        : [];

      // stage2 assemble system prompt (leading 首段 → static → boundary → dynamic)
      const leading = resolveLeading(this.o.context.config.leadingSystemText);
      const system = await this.assembler.assemble({
        leading: leading != null ? { render: () => leading } : undefined,
        staticSlots: this.o.context.config.systemPromptSlots,
        dynamicSlots: [...autoMemSlots, ...deferredSlots, ...readReminderSlots(), ...hookContextSlots()],
        ctx: { agentId: this.id },
        globalCacheEnabled: this.o.globalCacheEnabled,
      });
      yield { type: 'stage', stage: 'assemble_system_prompt', turn };
      this.bus.publish(this.ev(CoreEventType.SystemPromptAssembled, { blockCount: system.length }));

      // stage3 context/compaction(顺序:micro(每轮) → auto(水位))。
      //   micro:time-based 清旧 tool result(纯函数,缺省不跑)。
      //   auto:水位触发 → strategy.compact → 发 CompactionApplied 事件 → skip-and-replace
      //   应用到 messages(闭合"派生=fold";§3.8 / 不变量 §6.1)。
      yield { type: 'stage', stage: 'context_compaction', turn };
      if (this.o.microCompact) {
        const micro = this.o.microCompact(messages);
        messages.splice(0, messages.length, ...micro);
      }
      if (this.o.compactionV2) {
        // ★ Compaction V2(emergency auto):比例水位 + 有序闸 + 三层管线 + 重挂。
        const marks = this.v2Watermarks();
        const tokenCount = lastPromptTokens > 0 ? lastPromptTokens : estimateTokens(messages);
        try {
          await this.runCompactionV2(messages, CompactType.EMERGENCY_AUTO, turn, tokenCount);
        } catch (e) {
          yield done('prompt_too_long', { error: e });
          return;
        }
        if (marks.blockingLimit > 0 && isOverBlockingLimit(estimateTokens(messages), marks)) {
          yield done('blocking_limit');
          return;
        }
      } else if (this.o.compaction) {
        const marks = computeWatermarks(this.o.contextWindow ?? 200_000);
        // 真实 token 优先(上一轮 API 回传的 prompt 规模);首轮无 usage 回退 char/4 估算。
        const tokenCount = lastPromptTokens > 0 ? lastPromptTokens : estimateTokens(messages);
        if (this.o.compaction.shouldCompact(tokenCount, marks)) {
          // ★ PreCompact hook:压缩真正触发前发(trigger=auto + 当前 token 数)。
          this.bus.publish(this.ev(CoreEventType.PreCompact, { trigger: 'auto', tokenCount }));
          try {
            const { replacement, coveredFrom, coveredTo } = await this.o.compaction.compact(messages);
            this.bus.publish(this.ev(CoreEventType.CompactionApplied, { coveredFrom, coveredTo, replacement }));
            const count = Math.max(0, coveredTo - coveredFrom + 1);
            messages.splice(coveredFrom, count, replacement as ProviderMessage);
            // ★ PostCompact hook:应用压缩后发(被覆盖的消息区间)。
            this.bus.publish(this.ev(CoreEventType.PostCompact, { coveredFrom, coveredTo }));
          } catch (e) {
            // 压缩自身失败(如 summarize 仍超长且无法再头部截断、provider 报错)→ 优雅终止,
            //   绝不让异常穿出 generator 崩掉整轮(>1M resume 的兜底:host 拿到 prompt_too_long)。
            yield done('prompt_too_long', { error: e });
            return;
          }
        }
        // blocking 硬上限(MANUAL_COMPACT_BUFFER 水位 effective-3k):压缩后仍越线
        //   → 无法把 prompt 拉回安全区,阻断续发(reactive-recovery.isOverBlockingLimit)。
        //   压缩可能已缩小 messages,故用压缩后的估算重判(无真实 usage 可依)。
        //   仅在 blockingLimit 为正(窗口够大、水位有意义)时启用——退化的小窗口(limit≤0)
        //   不硬 bail,交由 provider 侧 PROMPT_TOO_LONG 反应式恢复兜底。
        if (marks.blockingLimit > 0) {
          const afterTokens = estimateTokens(messages);
          if (isOverBlockingLimit(afterTokens, marks)) {
            yield done('blocking_limit');
            return;
          }
        }
      }

      // stage4 provider call (stream + retry/fallback + abort)
      yield { type: 'stage', stage: 'provider_call', turn };
      const req = this.buildRequest(system, messages, tools);
      let assistantMessage: unknown = null;
      let stopReason: StopReason = null;
      let turnOutputTokens = 0;
      try {
        for await (const sev of streamWithRetry(
          this.o.context.provider,
          req,
          { signal, fallbackModel: this.o.context.config.fallbackModel },
          this.o.retry,
        )) {
          yield { type: 'stream', event: sev };
          if (sev.type === 'assistant') {
            assistantMessage = sev.message;
            stopReason = sev.stopReason;
            // 记下本轮实际送入的 prompt token(input + cache read),供下一轮水位判定。
            lastPromptTokens = (sev.usage.inputTokens ?? 0) + (sev.usage.cacheReadInputTokens ?? 0);
            if (sev.usage.outputTokens) turnOutputTokens = sev.usage.outputTokens;
          } else if (sev.type === 'message_delta') {
            stopReason = sev.stopReason;
            if (sev.usage?.outputTokens) turnOutputTokens = sev.usage.outputTokens;
          }
        }
      } catch (e) {
        if (signal.aborted) {
          yield { type: 'turn_aborted', turn };
          yield done('aborted_streaming');
          return;
        }
        // PROMPT_TOO_LONG 反应式压缩(autoCompact reactive 路):
        //   provider 抛 content === PROMPT_TOO_LONG_MESSAGE 时,若挂了 compaction,
        //   强压一次 messages 再 continue 重试**同一 turn**(turn-- 抵消 for-loop ++,
        //   仍受 maxTurns 限);压缩后无可压(coveredTo<coveredFrom)→ done(prompt_too_long)。
        if (!signal.aborted && isPromptTooLong(e) && (this.o.compactionV2 || this.o.compaction)) {
          try {
            const compacted = this.o.compactionV2
              ? (await this.runCompactionV2(messages, CompactType.EMERGENCY_AUTO, turn, undefined, true)) === 'compacted'
              : await this.reactiveCompactOnce(messages, turn);
            if (compacted) {
              turn--; // 重试同一 turn(for-loop ++ 抵消);maxTurns 仍兜底
              continue;
            }
          } catch {
            // 压缩自身也失败(summarize 仍超长且无法再截断)→ 落 prompt_too_long(下方),不崩。
          }
          yield done('prompt_too_long', { error: e });
          return;
        }
        yield done('model_error', { error: e });
        return;
      }
      // token 预算:累加本轮 output token(taskBudget 缺省 → spentTokens 仅记账不参与判定)。
      spentTokens += turnOutputTokens;

      // ④ 上下文窗口溢出经 stop reason 上报(provider 不抛 400 而是回 stop_reason,
      //   见 anthropic.ts:normalizeStopReason 'model_context_window_exceeded'):等同 PTL
      //   反应式路——有压缩策略则压一次重试同一 turn,否则优雅终止。绝不静默当完成
      //   (否则会把被截断/失败的输出当成功收尾,丢上下文)。
      if (stopReason === 'model_context_window_exceeded') {
        if (this.o.compactionV2 || this.o.compaction) {
          try {
            const compacted = this.o.compactionV2
              ? (await this.runCompactionV2(messages, CompactType.EMERGENCY_AUTO, turn, undefined, true)) === 'compacted'
              : await this.reactiveCompactOnce(messages, turn);
            if (compacted) {
              turn--;
              continue;
            }
          } catch {
            // 压缩失败 → 落 prompt_too_long(下方),不崩。
          }
        }
        yield done('prompt_too_long');
        return;
      }

      const { content, toolUses } = extractAssistant(assistantMessage);
      const asstEvent = this.ev('assistant.message', { role: 'assistant', content });
      // ★ 事件溯源:assistant 轮也是一条事件,必须 publish 到 bus —— 否则 connectStore 的 WAL
      //   只记 user/tool 轮,resume 回放会丢掉 assistant 轮(开机回放 §3.8.7 的闭环缺环);
      //   peer 子 agent 经 bus 收集结果时也会丢掉子产物。在 yield 前发,保证 store 内
      //   assistant 先于本轮 tool_result 落盘(fold 重建顺序正确)。
      this.bus.publish(asstEvent);
      yield { type: 'assistant', message: asstEvent };
      messages.push({ role: 'assistant', content });

      // ① max_output_tokens 续写(queryLoop 恢复):纯文本被 max_tokens 截断、本轮零
      //   tool_use → 话没说完,自动续一条 "Please continue..." 让模型接着写,而非判完成。
      //   受 maxContinuations 硬上限兜底;assistant message 已 push(上一行),只需 append 续条。
      if (shouldContinueOnMaxTokens(stopReason, toolUses.length) && continuations < maxContinuations) {
        continuations++;
        messages.push(buildContinuationMessage());
        this.bus.publish(this.ev(CoreEventType.TurnAborted, { turn, reason: 'max_output_tokens_recovery' }));
        yield { type: 'turn_end', turn };
        this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));
        continue;
      }

      // 无 tool_use → end_turn → 完成
      if (toolUses.length === 0 || stopReason === 'end_turn' || stopReason === 'stop_sequence') {
        // ② stop-hook gate(Stop hook):收尾前发 Stop 事件给 hook 一个「别停」的机会。
        //   hook 经 EventBus 把 preventStop/reason 合并进回执(modify/返回替换事件);
        //   preventStop===true 且未触续轮上限 → 注回 reason(system-reminder)并续轮,不收尾。
        //   blocked(拦动作)与 preventStop(拦收尾)语义不同——evaluateStopHook 只认后者。
        // stopHookActive(即 stop_hook_active 字段):本轮 Stop 是由上一次 Stop hook
        //   阻止收尾(preventStop)续轮而来时为 true,供 hook 命令识别重入避免无限阻止。
        const stopReceipt = this.bus.publish(
          this.ev(CoreEventType.Stop, { turn, stopHookActive: continuations > 0 }),
        ) as CoreEvent & {
          preventStop?: boolean;
          reason?: string;
        };
        // hook 在 Stop 上挂的 additionalContext → 注成下一轮 system-reminder(若续轮)。
        const stopExtra = readHookExtra(stopReceipt);
        if (stopExtra.additionalContext) {
          hookContextReminders.push(`<system-reminder>${stopExtra.additionalContext}</system-reminder>`);
        }
        // hook 在 Stop 上设 continue:false(回执 continueLoop===false)→ 视作优雅停:
        //   不再走 preventStop 续轮逻辑,直接正常收尾(continue:false 语义)。
        if (stopExtra.continueLoop === false) {
          yield { type: 'turn_end', turn };
          this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));
          if (this.o.autoMemory) {
            this.pendingExtract = this.o.autoMemory
              .extract(messages.map((m) => ({ role: m.role, content: m.content })), signal)
              .catch(() => {});
          }
          yield done('completed');
          return;
        }
        const stopDecision = evaluateStopHook({
          blocked: stopReceipt.blocked,
          preventStop: stopReceipt.preventStop,
          reason: stopReceipt.reason ?? stopReceipt.blockReason,
        } satisfies StopHookPublishResult);
        if (stopDecision.prevented && continuations < maxContinuations) {
          continuations++;
          const reason = stopDecision.reason ?? 'A stop hook requested that you keep going.';
          messages.push({ role: 'user', content: `<system-reminder>${reason}</system-reminder>` });
          yield { type: 'turn_end', turn };
          this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));
          continue;
        }
        // hook 反复要求继续但已触上限 → 终止(TerminalReason stop_hook_prevented)。
        if (stopDecision.prevented) {
          yield { type: 'turn_end', turn };
          this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));
          yield done('stop_hook_prevented');
          return;
        }

        // ③ token-budget gate(token_budget_continuation):设了 taskBudget 且未耗尽且
        //   模型本欲收尾时,按预算续轮(让其继续干活直至预算用尽);耗尽则正常收尾。
        //   无 taskBudget → 两谓词皆 false → 零行为变化(语义与今天逐字一致)。
        if (
          taskBudget &&
          !isBudgetExhausted(spentTokens, taskBudget) &&
          shouldContinueForBudget(spentTokens, taskBudget) &&
          continuations < maxContinuations
        ) {
          continuations++;
          messages.push(buildContinuationMessage());
          this.bus.publish(this.ev(CoreEventType.TurnAborted, { turn, reason: 'token_budget_continuation' }));
          yield { type: 'turn_end', turn };
          this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));
          continue;
        }

        yield { type: 'turn_end', turn };
        this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));
        // ★ auto-memory 自动抽取:done 后台触发(fire-and-forget;CLI 经 drainAutoMemory 等落盘)。
        if (this.o.autoMemory) {
          this.pendingExtract = this.o.autoMemory
            .extract(messages.map((m) => ({ role: m.role, content: m.content })), signal)
            .catch(() => {});
        }
        yield done('completed');
        return;
      }

      // budget 耗尽硬护栏:带 tool_use 但预算已耗尽 → 优雅收口(不再继续烧 token)。
      if (taskBudget && isBudgetExhausted(spentTokens, taskBudget)) {
        // 仍把已产出的 assistant 消息留在上下文;按 max_turns 语义收尾(turnCount 透出)。
        yield { type: 'turn_end', turn };
        this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));
        yield done('max_turns', { turnCount: turn + 1 });
        return;
      }

      // stage5 dispatch tools (serial/parallel + 权限把闸 + hook block)
      yield { type: 'stage', stage: 'dispatch_tools', turn };
      // ★ v3/B 档:每个工具调用一棵 child span,显式认 runSpan 作 parent(trace.setSpan(ROOT_CONTEXT,
      //   runSpan))—— 并发多 run 各自的工具 span 只会挂到自己的 runSpan 下,绝不串父(B2)。
      const toolSpanCtx = trace.setSpan(ROOT_CONTEXT, runSpan);
      const toolSpans = new Map<string, Span>();
      for (const tu of toolUses) {
        yield { type: 'tool_call', toolName: tu.name, toolUseId: tu.id, input: tu.input };
        log.info('tool call', { turn, tool: tu.name, callId: tu.id });
        toolSpans.set(
          tu.id,
          obs.tracer.startSpan('tool', { attributes: { tool: tu.name, callId: tu.id, agentId: this.id } }, toolSpanCtx),
        );
      }

      // 同一文件重复读护栏(移植 same_file_read_limit):read 类调用先记次数;越线(>K)
      //   的 read 不真正执行——合成一条「已读过 N 次,复用此前输出」的 error 结果拦下(绝不硬杀
      //   run),并注一条 system-reminder 供下一轮提示模型复用。其余调用照常 dispatch。
      const interceptedReads = new Map<string, ToolDispatchResult>();
      for (const tu of toolUses) {
        const path = readPathOf(tu, tools);
        if (path == null) continue;
        const n = readTracker.record(path);
        if (readTracker.over(path, readLimit)) {
          const msg = `You have already read ${path} ${n} times; reuse the prior result instead of re-reading.`;
          interceptedReads.set(tu.id, {
            toolUseId: tu.id,
            toolName: tu.name,
            result: { type: 'tool.result', payload: { toolUseId: tu.id, isError: true, message: msg }, ts: 0 },
            isError: true,
          });
          readReminders.push(`<system-reminder>${msg}</system-reminder>`);
        }
      }

      const toDispatch = toolUses.filter((tu) => !interceptedReads.has(tu.id));
      // PreToolUse 每工具只发布一次:isBlocked 与 preToolPermission 共用同一回执
      //   (避免对同一 use 重复触发 hook)。回执携带 blocked(K1/K5 闸)与
      //   permissionDecision(allow/deny/ask 三态)。
      const preToolReceipts = new Map<string, CoreEvent & { permissionDecision?: 'allow' | 'deny' | 'ask' }>();
      const preToolReceipt = (use: ToolUse): CoreEvent & { permissionDecision?: 'allow' | 'deny' | 'ask' } => {
        let r = preToolReceipts.get(use.id);
        if (!r) {
          r = this.bus.publish(
            this.ev(CoreEventType.ToolCallRequested, { toolName: use.name, toolUseId: use.id, input: use.input }),
          ) as CoreEvent & { permissionDecision?: 'allow' | 'deny' | 'ask' };
          preToolReceipts.set(use.id, r);
        }
        return r;
      };
      const dispatched = await dispatchTools(toDispatch, {
        tools,
        toolContext: this.o.context.toolContext,
        signal,
        rules: this.o.rules,
        mode: this.currentMode,
        enableSafetyCheck: this.o.enableSafetyCheck,
        askUser: this.o.askUser,
        isBlocked: (use) => preToolReceipt(use).blocked === true,
        preToolPermission: (use) => preToolReceipt(use).permissionDecision,
      });
      // 合并:保持工具调用的原始顺序(拦下的 read 用合成结果占位)。
      const dispById = new Map(dispatched.map((r) => [r.toolUseId, r]));
      const results: ToolDispatchResult[] = toolUses.map(
        (tu) => interceptedReads.get(tu.id) ?? dispById.get(tu.id)!,
      ).filter((r): r is ToolDispatchResult => r != null);

      // ExitPlanMode:本轮工具结果含 sentinel → 把权限模式翻回 default(plan→执行)。
      //   置于 dispatch 之后:本轮 ExitPlanMode 调用本身仍在 plan 把闸下被放行(只读豁免),
      //   翻模式只影响下一 turn 的 dispatch(模型据 tool.result 知道已可执行)。
      if (this.currentMode === 'plan' && hasExitPlanIntent(results)) {
        this.currentMode = 'default';
        this.bus.publish(this.ev('permission.mode_changed', { turn, mode: 'default', reason: 'exit_plan_mode' }));
      }

      // 诊断:本轮工具错误按五类聚合,发一条 tool.error_stats 事件(纯函数,无 IO;WS5)。
      const errorStats = aggregateErrorCategories(results);
      if (Object.keys(errorStats).length > 0) {
        this.bus.publish(this.ev('tool.error_stats', { turn, stats: errorStats, summary: summarizeErrorStats(errorStats) }));
      }

      // ★ PostToolUse hook:dispatch 完成后,逐结果发 ToolCalled('tool.called')
      //   与 ToolCallResult('tool.result')。后者即 PostToolUse 载荷——hook 经回执 ctl.modify
      //   可改写 payload.result / payload.isError(回写进本结果 → 同时影响 yield 与回灌模型),
      //   或挂 additionalContext(注成下一轮 system-reminder)。原 isBlocked PreToolUse 闸不动。
      for (const r of results) {
        this.bus.publish(this.ev(CoreEventType.ToolCalled, { toolName: r.toolName, toolUseId: r.toolUseId }));
        const postReceipt = this.bus.publish(
          this.ev(CoreEventType.ToolCallResult, {
            toolUseId: r.toolUseId,
            toolName: r.toolName,
            result: r.result.payload,
            isError: r.isError,
          }),
        );
        const pp = postReceipt.payload as { result?: unknown; isError?: boolean } | undefined;
        // hook 改写了 result → 回写进结果 payload(供回灌模型与 yield 一致);改写 isError 同理。
        if (pp && 'result' in pp && pp.result !== undefined) {
          r.result = { ...r.result, payload: pp.result };
        }
        if (pp && typeof pp.isError === 'boolean') r.isError = pp.isError;
        const postExtra = readHookExtra(postReceipt);
        if (postExtra.additionalContext) {
          hookContextReminders.push(`<system-reminder>${postExtra.additionalContext}</system-reminder>`);
        }
      }

      for (const r of results) {
        yield { type: 'tool_result', toolUseId: r.toolUseId, result: r.result };
        // ★ v3/B 档:收尾对应工具 span(status 据 isError;1=OK / 2=ERROR)。noop tracer 下为空操作。
        const ts = toolSpans.get(r.toolUseId);
        if (ts) {
          ts.setStatus({ code: r.isError ? 2 : 1 });
          // ★ 诊断维度:工具失败时把错误摘要盖到 tool span(截断防爆 span);span 已带工具名,
          //   排查时从 trace 即读出「哪个工具、为何失败」,无需另翻 tool_result 事件。
          if (r.isError) {
            try { ts.setAttribute('error', briefError(r.result)); } catch { /* noop tracer 无 setAttribute */ }
          }
          ts.end();
          toolSpans.delete(r.toolUseId);
        }
      }
      // 防御:任何未配到结果的工具 span(理论不应有)也收尾,绝不泄漏未 end 的 span。
      for (const ts of toolSpans.values()) ts.end();
      toolSpans.clear();
      messages.push({ role: 'user', content: toolResultsToContent(results, budgetFor) });

      // 循环兜底(移植 02.4):同一工具(name+args)连续报错达阈值 → 终止,避免空转烧 maxTurns。
      //   模型已见到本轮错误结果(上一行已 push),但不再续轮重试同一失败动作。
      if (maxStreak > 0 && Number.isFinite(maxStreak)) {
        const resById = new Map(results.map((r) => [r.toolUseId, r]));
        let bail = false;
        for (const tu of toolUses) {
          const r = resById.get(tu.id);
          if (!r) continue;
          const key = JSON.stringify([tu.name, stableStringify(tu.input)]);
          if (r.isError) {
            const n = (errorStreak.get(key) ?? 0) + 1;
            errorStreak.set(key, n);
            if (n >= maxStreak) bail = true;
          } else {
            errorStreak.set(key, 0);
          }
        }
        if (bail) {
          yield { type: 'turn_aborted', turn };
          this.bus.publish(this.ev(CoreEventType.TurnAborted, { turn, reason: 'unrecoverable_tool_error' }));
          yield done('unrecoverable_tool_error');
          return;
        }
      }

      // stage6 turn end
      yield { type: 'stage', stage: 'turn_end', turn };
      yield { type: 'turn_end', turn };
      this.bus.publish(this.ev(CoreEventType.TurnEnd, { turn }));

      if (signal.aborted) {
        yield { type: 'turn_aborted', turn };
        yield done('aborted_tools');
        return;
      }
      // stage7 handoff decision —— 多 agent 协作接缝(§4.2)。
      //   未注入 handoff,或本轮模型没经 `Handoff` 工具发意图 → 维持单 agent no-op:续下一 turn
      //   (与今天逐字一致,零行为变化)。注入了 handoff 且本轮有意图 → declare 交 host 调度器,
      //   按 resolution 处理:child_result 折进上下文续转 / wakeup 记录续转 / ack 据意图终态或续转。
      yield { type: 'stage', stage: 'handoff_decision', turn };
      if (this.o.handoff) {
        const intent = extractHandoffIntent(results);
        if (intent) {
          this.bus.publish(this.ev('handoff.declared', { turn, kind: intent.kind }));
          let resolution: HandoffResolution;
          try {
            resolution = await this.o.handoff.declare(intent);
          } catch (e) {
            // 调度器抛错 → 不静默吞;作 system-reminder 喂回模型并续转(绝不硬杀 run)。
            const msg = e instanceof Error ? e.message : String(e);
            messages.push({ role: 'user', content: `<system-reminder>Handoff failed: ${msg}</system-reminder>` });
            continue;
          }
          this.bus.publish(this.ev('handoff.resolved', { turn, kind: resolution.kind }));
          if (resolution.kind === 'child_result') {
            // 子结果折进上下文(fg spawn_child:父等子,把子产出的事件摘要作 user 轮续答)。
            messages.push({ role: 'user', content: foldHandoffEvents(resolution.events) });
            continue;
          }
          if (resolution.kind === 'wakeup') {
            // MVP:被唤醒——把唤醒触发作 system-reminder 注入并续转(真正的挂起/恢复由 host 调度器
            //   驱动多次 run;core 这里只把唤醒事件喂回模型)。TODO:F-later 接 sleep 真挂起。
            messages.push({
              role: 'user',
              content: `<system-reminder>Woken up by ${resolution.trigger.eventType}.</system-reminder>`,
            });
            continue;
          }
          // resolution.kind === 'ack':host 已受理。pop_self / abort 是终态意图 → 本 agent 收口
          //   (控制权已交出);其余(sleep/resume_target/bg spawn_child)→ 续下一 turn。
          if (intent.kind === 'pop_self' || intent.kind === 'abort') {
            yield done('handed_off');
            return;
          }
          continue;
        }
      }
    }

    yield done('max_turns', { turnCount: maxTurns });
    } catch (e) {
      // 任意未捕获异常(provider/dispatch 等)→ 标 span error 并上抛(绝不吞;finally 收尾 span)。
      runStatus = 'error';
      const msg = e instanceof Error ? e.message : String(e);
      try { runSpan.recordException(e instanceof Error ? e : new Error(msg)); } catch { /* noop tracer 可能无此 API */ }
      log.error('agent.run error', { error: msg });
      throw e;
    } finally {
      // SpanStatusCode: 1=OK, 2=ERROR(用字面量避免 import SDK 常量;@opentelemetry/api 仅取类型/trace)。
      runSpan.setStatus({ code: runStatus === 'ok' ? 1 : 2 });
      try { runSpan.setAttribute('turns', turnsRun); } catch { /* noop tracer 无 setAttribute */ }
      log.info('agent.run done', { status: runStatus, turns: turnsRun });
      runSpan.end();
    }
  }
}

function resolveLeading(leading: string | (() => string | null) | undefined): string | null {
  if (leading == null) return null;
  return typeof leading === 'function' ? leading() : leading;
}

/** 合并外部 signal 与内部 abort：任一 abort 即 abort。 */
function mergeSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return ac.signal;
}
