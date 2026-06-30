/**
 * Memory seam (C8) — core 只出「记忆机制接缝」，分层记忆/数字生命实现作 ③ cli pack。
 *
 * 设计稿: 最终实现方案 §2/§0″ (core 只留 memory Tool ABI + slot + 重生事件；
 * layered-memory + soul-pack 留 forgeax-cli 启动注入，core/src 零 soul 代码) +
 * core-layer-spec §3.4.8 (转世 tier)。
 * LLM-select over frontmatter，max 5，无 embedding /
 * index 常驻 system + topic 召回 / taxonomy。
 *
 * MEMpack 据此实现（K7/K8/K14）。Boundary: 仅 import core-local 类型。
 */
import type { Slot } from './types';

// ─── memory_search / remember —— 就是普通 Tool（经 loader 注册，K8）──────────
// core 不规定 T0/T1/T2 实现，只规定工具签名形状，让 cli pack 照着做。

export interface MemorySearchInput {
  query: string;
  /** 召回上限（max 5）。 */
  limit?: number;
}
export interface MemoryHit {
  path: string;
  /** mtime 渲染为 "N days ago"（模型读人类文本而非 ISO）。 */
  freshness?: string;
  content: string;
}
export interface MemorySearchOutput {
  hits: MemoryHit[];
}

export interface RememberInput {
  /** 记忆类型（cli pack 扩展为 T0 identity / T1 traits / T2 episodic；taxonomy 是
   *  user/feedback/project/reference，本 seam 不锁枚举，由 pack 定义）。 */
  type: string;
  name: string;
  description: string;
  body: string;
}
export interface RememberOutput {
  path: string;
}

/** 工具名常量（loader/permission 据此识别 memory 工具）。 */
export const MEMORY_SEARCH_TOOL = 'memory_search';
export const REMEMBER_TOOL = 'remember';

// ─── memory slot —— index 常驻 system + topic 召回注入 ────

/** core 暴露一个 memory slot 接口；cli pack 提供 render（注入 MEMORY.md index + 指令）。
 *  topic 文件的选择性召回作 system-reminder 由 pack 在 loop ingress 注入，core 只提供
 *  slot 注入点 + 预算约束常量。 */
export interface MemorySlot extends Slot {
  readonly name: 'memory';
}

/** 注入预算——pack 必须遵守以保 cache/上下文稳定。 */
export const MEMORY_BUDGET = {
  perFileMaxLines: 200,
  perFileMaxBytes: 4096,
  perTurnMaxFiles: 5,
  sessionMaxBytes: 60_000,
  entrypointMaxLines: 200,
  entrypointMaxBytes: 25_000,
} as const;

// ─── 重生事件 payload（C8 ⊂ C1 catalog；数字生命转世 seam，core-layer-spec §3.4.8）─

export interface SoulPackLoadedPayload {
  agentId: string;
  /** trustTier 权威 = 加载路径，非 pack 自报（R6-02）。 */
  trustTier: 'own' | 'imported';
  packPath: string;
}
export interface RebirthInitiatedPayload {
  agentId: string;
  /** 转世层级数据指针（T0/T1/T2 落盘由 pack + PathConvention 决定，core 不约束布局）。 */
  tiers: { t0?: string; t1?: string; t2?: string };
}
export interface IdentityProjectedPayload {
  agentId: string;
  /** 投影进 system prompt 的 identity 文本摘要（仅事件可观测用，非 prompt 本体）。 */
  identityDigest?: string;
}
