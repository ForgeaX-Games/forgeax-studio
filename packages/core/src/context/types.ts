/**
 * system-prompt slot 契约 (C7) — 装配 + cache 边界 + host 可控首段。
 *
 * 设计稿: 最终实现方案 §5 (★ 统一首段 slot 规格：T0 魂 + M4 preamble 共用同一
 * host 可控稳定首段 slot) + §0″。
 *(splitSysPromptPrefix cacheScope 边界) /
 *(getCLISyspromptPrefix 注入点) /
 *(段顺序 + DYNAMIC_BOUNDARY)。
 *
 * CTX 实现本契约（K4/K7/K12 经此接缝）。Boundary: 仅 import core-local 类型。
 */
import type { Slot } from '../capability/types';
import type { SystemBlock } from '../provider/types';

/** cache 域（CacheScope）：
 *  - 'global' —— 跨 session/user 共享前缀（静态段，DYNAMIC_BOUNDARY 之前）。
 *  - 'org'    —— 组织级（默认 / 有 MCP 工具时回退）。
 *  - null     —— 不缓存（attribution header / 动态段）。 */
export type CacheScope = 'global' | 'org' | null;

/** 哨兵：静态段(之前)进 global cache，动态段(之后)不缓存（SYSTEM_PROMPT_DYNAMIC_BOUNDARY）。 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/**
 * ★ host 可控稳定首段 slot —— 一个 seam 撑两件事（最终方案 §5）：
 *  - 数字生命 T0「魂」注入（soul-pack capability 经此注 identity/persona）。
 *  - M4 订阅伪装 preamble（host 注入的稳定首段;具体文本由 host 决定,core 不感知)。
 * 规格：host 提供文本，core 放 system 最前、进 cache 断点内（字节稳定 → cache 命中），
 * core 不解释其语义；dynamicSuffix 绝不混入（保前缀稳定）。
 */
export interface LeadingSystemSlot {
  /** 返回首段文本；null = 不注入。host 保证字节稳定（否则破 cache）。 */
  render(): string | null;
}

/** 装配输入。 */
export interface SystemPromptAssembleInput {
  /** ★ 稳定首段（进 cache 前缀；T0 魂 / M4 preamble）。 */
  leading?: LeadingSystemSlot;
  /** 静态 slots（boundary 之前，可 global cache）。 */
  staticSlots: Slot[];
  /** 动态 slots（boundary 之后，每轮重算，不缓存）。 */
  dynamicSlots: Slot[];
  /** 渲染上下文。 */
  ctx: { agentId?: string; config?: Readonly<Record<string, unknown>>; [k: string]: unknown };
  /** 是否启用 global cache scope（无则全 org）。 */
  globalCacheEnabled?: boolean;
}

/** 装配器契约：slots → 带 cacheScope 的 SystemBlock[]（供 provider 打 cache_control）。 */
export interface SystemPromptAssembler {
  assemble(input: SystemPromptAssembleInput): Promise<SystemBlock[]>;
}

// ─── compaction 契约（CTX 拥有引擎，strategy 作 ③ 注入；最终方案 §12）────────

/**
 * 多区水位。两套并存(向后兼容):
 *  - 旧绝对 buffer 字段(`computeWatermarks(number)` 产出,既有测试依赖):
 *    `autoCompactThreshold`(effective-13k)/ `warningThreshold`(effective-20k)/
 *    `blockingLimit`(effective-3k)。
 *  - 新比例字段(`computeWatermarksFromModel` 产出,改造后主用):`preCompactThreshold`
 *    (effective×0.80 主动预压)/ `emergencyThreshold`(effective×0.92 紧急压)。
 *    比例版的 `autoCompactThreshold` 取 `emergencyThreshold`(供旧 shouldCompact strategy 复用),
 *    `warningThreshold` 取 effective×0.60。
 */
export interface Watermarks {
  effectiveWindow: number; // window - reservedForSummary
  /** 主动预压触发点(比例版 effective×preCompactPct;绝对版 = autoCompactThreshold)。 */
  preCompactThreshold: number;
  /** 紧急压触发点(比例版 effective×emergencyPct;绝对版 = autoCompactThreshold)。 */
  emergencyThreshold: number;
  /** 旧自动压触发点(absolute:effective-13k)。比例版 = emergencyThreshold。供旧 strategy 复用。 */
  autoCompactThreshold: number;
  /** UI 预警水位(absolute:effective-20k;比例版 effective×0.60)。 */
  warningThreshold: number;
  /** 硬阻断上限(effective-3k / 比例版同绝对兜底)。 */
  blockingLimit: number;
}

export interface CompactionStrategy {
  readonly name: string;
  /** 是否该压缩（按 token 水位）。 */
  shouldCompact(tokenCount: number, marks: Watermarks): boolean;
  /** 执行压缩，产出 CompactionApplied 事件载荷（由 ledger fold 消费）。 */
  compact(messages: unknown[]): Promise<{ replacement: unknown; coveredFrom: number; coveredTo: number }>;
}
