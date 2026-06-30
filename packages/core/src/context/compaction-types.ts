/**
 * Compaction shared contracts (Stream 0) — 所有压缩相关 Stream 对着这里编码。
 *
 * 见 docs/features/compaction-overhaul-plan.md §4。本文件**只放类型/枚举/常量默认**,
 * 无行为、无 IO。Boundary: 仅 import core-local 类型 + node:。
 */
import type { ProviderMessage } from '../provider/types';
import type { Watermarks } from './types';

// ─── 触发类型(#8)───────────────────────────────────────────────────────────

/** 一次压缩的来源/类型(决策 #8;字符串值会进事件载荷,改名需同步 host/UI)。 */
export enum CompactType {
  /** 手动 `/compact`(或等价斜杠命令)。 */
  USER_COMMAND = 'user-command',
  /** token 越 emergency 阈值的紧急自动压。 */
  EMERGENCY_AUTO = 'emergency-auto',
  /** turn 发送前的静默预压(#11)。 */
  PRE_MESSAGE_AUTO = 'pre-message-auto',
}

/** 压缩触发方式(给 PreCompact hook matcher 用;manual/auto 两态)。 */
export function compactTrigger(type: CompactType): 'manual' | 'auto' {
  return type === CompactType.USER_COMMAND ? 'manual' : 'auto';
}

// ─── 水位 per-model(#1)──────────────────────────────────────────────────────

/** per-model 上下文信息(Stream A 的 model-context-table 产出)。 */
export interface ModelContextInfo {
  /** 完整上下文窗口 token 数。 */
  contextWindow: number;
  /** 模型最大输出 token(用于摘要预留 = min(maxOutputTokens, 20k));缺省按 20k 预留。 */
  maxOutputTokens?: number;
}

/** 比例水位配置 + env source(测试可注入 env)。 */
export interface WatermarkConfig {
  preCompactPct?: number; // 默认 0.80
  emergencyPct?: number; // 默认 0.92
  warningPct?: number; // 默认 0.60
  /** env source(默认 process.env;测试注入)。 */
  env?: Record<string, string | undefined>;
}

// ─── 触发闸状态/输入/决策(#7/#9/#10/#3)────────────────────────────────────

/** 触发闸可变状态(host 持有,跨压缩更新;纯状态,无 IO)。 */
export interface CompactionGateState {
  /** 是否正在压缩(防重入)。 */
  isCompressing: boolean;
  /** 上次压缩完成时间(ms);冷却判定用。undefined = 从未压过。 */
  lastCompactAt?: number;
  /** 连续失败次数(熔断用);成功清零。 */
  consecutiveFailures: number;
}

/** 触发闸配置(冷却窗 / 熔断阈值)。 */
export interface CompactionGateConfig {
  /** 冷却窗(ms),默认 30_000。 */
  cooldownMs: number;
  /** 连续失败达此值即熔断,默认 3。 */
  maxConsecutiveFailures: number;
}

/** 触发闸默认配置(决策 #9/#10)。 */
export const DEFAULT_GATE_CONFIG: CompactionGateConfig = {
  cooldownMs: 30_000,
  maxConsecutiveFailures: 3,
};

/** 触发闸输入(纯函数;now 注入)。 */
export interface CompactionGateInput {
  tokenCount: number;
  marks: Watermarks;
  type: CompactType;
  state: CompactionGateState;
  /** 当前时间 ms(注入,绝不读 Date.now)。 */
  now: number;
  /** 来源标记;'summary' / 'subagent-internal' 等会被拦(防递归自压,#3)。 */
  querySource?: string;
  /** 自动压总开关。 */
  autoCompactEnabled: boolean;
  config: CompactionGateConfig;
}

/** 触发闸拒绝原因(有序短路)。 */
export type GateRejectReason =
  | 'disabled'
  | 'busy'
  | 'cooldown'
  | 'circuit-open'
  | 'recursive'
  | 'below-threshold';

/** 触发闸决策。 */
export type GateDecision = { compact: true } | { compact: false; reason: GateRejectReason };

// ─── 压缩管线(#5/#12/#4/#2/#3)──────────────────────────────────────────────

/** 摘要场景(决策 #2)。 */
export type SummaryScenario = 'full' | 'partial' | 'pre-message';

/** host 注入的摘要器(管线版,带 scenario):一段消息 → 摘要文本。core 绝不自调 LLM。
 *  抛 message 以 PROMPT_TOO_LONG 前缀的 Error → 管线 head-truncate 重试;
 *  抛其它 Error → 压缩失败(供 E 回滚 + 熔断计数)。
 *  (与 compaction-llm 的旧 `Summarize`(无 scenario)区分;新管线用本类型。) */
export type CompactSummarize = (
  messages: readonly ProviderMessage[],
  scenario: SummaryScenario,
) => Promise<string>;

/** 压缩管线输入。 */
export interface CompactPipelineInput {
  messages: readonly ProviderMessage[];
  scenario: SummaryScenario;
  marks: Watermarks;
  summarize: CompactSummarize;
  /** L1 后估 token ≤ effectiveWindow × 此比例 → 跳过 LLM(决策 #12),默认 0.15。 */
  sufficiencyRatio: number;
  /** 摘要范围外保留的最近消息条数。 */
  messagesToKeep: number;
  /** 当前时间 ms(注入)。 */
  now: number;
}

/** 压缩管线结果(供 host 发 CompactionApplied)。 */
export interface CompactPipelineResult {
  replacement: ProviderMessage;
  coveredFrom: number;
  coveredTo: number;
  /** false = L1 sufficiency 短路成功,未调 LLM。 */
  usedLLM: boolean;
  estimatedTokens: number;
}

// ─── 压后重挂(#13)──────────────────────────────────────────────────────────

/** 默认重挂预算(决策 #13:简化版)。 */
export const DEFAULT_REHYDRATE_TOKEN_BUDGET = 10_000;
export const DEFAULT_REHYDRATE_MAX_FILES = 1;

/** 压后重挂输入(纯逻辑 + 注入 readFile)。 */
export interface RehydrateInput {
  /** 最近读过的文件路径(最新在前;来自 capability/read-tracker)。 */
  recentReadPaths: readonly string[];
  /** 读文件(注入;失败抛错由实现吞掉降级)。 */
  readFile: (path: string) => Promise<string>;
  /** token 预算上限,默认 10_000。 */
  tokenBudget: number;
  /** 最多重挂文件数,默认 1。 */
  maxFiles: number;
}

/** 压后重挂结果:附在摘要之后的 attachment 消息(可能为空)。 */
export interface RehydrateResult {
  attachments: ProviderMessage[];
}
