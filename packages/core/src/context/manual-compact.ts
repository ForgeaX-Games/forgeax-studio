/**
 * 手动压缩入口(014 A 层)—— 给 `/compact` 斜杠命令 / Studio `compact` RPC 用的
 * **薄封装**,复用 {@link runCompaction} 的同一条三层管线,只是把触发来源钉成
 * 手动 {@link CompactType.USER_COMMAND}(scenario 固定 `full`,与自动预压/紧急压区分)。
 *
 * 设计取舍(与 014 任务 A 层硬边界对齐):
 *  - 本文件**不碰** loop(`agent.ts`)/ `serve.ts` / `host-context.ts`,也不自调 LLM —
 *    所有外部依赖(history、marks、summarize)都**经入参注入**,做成纯函数,集成方
 *    在主循环里接线即可(见文件尾 §集成说明)。
 *  - 不改 `compaction-pipeline.ts` 本体,只在其上做手动路径的语义封装。
 *  - 自动压走闸(`compaction-gate`)按水位决策;**手动压不过闸**(用户显式要求即压),
 *    与 `compaction-gate.ts` 里 `USER_COMMAND` 阈值取 0 的语义一致。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { ProviderMessage } from '../provider/types';
import type { CompactPipelineResult, CompactSummarize } from './compaction-types';
import { CompactType } from './compaction-types';
import type { Watermarks } from './types';
import { runCompaction } from './compaction-pipeline';

/** 手动压缩入参(集成方从 host 现有装配里取齐后注入)。 */
export interface ManualCompactInput {
  /** 待压历史(只读;管线只读不就地改,splice 由集成方据结果做)。 */
  history: readonly ProviderMessage[];
  /** per-model 水位(host 现有 `v2Watermarks()` 等价产出)。 */
  marks: Watermarks;
  /**
   * host 注入的摘要器(管线版,带 scenario)。
   * 若用户给了 `/compact <自定义指令>`,集成方应在构造本 summarize 时把指令
   * 透传进压缩 prompt(经 `getCompactPrompt(scenario, instructions)`),
   * core 不自调 LLM、也不在此重组 prompt。
   */
  summarize: CompactSummarize;
  /** L1 后估 token ≤ effectiveWindow × 此比例 → 跳过 LLM(默认 0.15,与自动压一致)。 */
  sufficiencyRatio?: number;
  /** 摘要范围外保留的最近消息条数(默认 0)。 */
  messagesToKeep?: number;
  /** 当前时间 ms(注入,绝不读 Date.now;默认走 `Date.now()` 仅为调用方便)。 */
  now?: number;
}

/** 手动压缩结果:管线产出 + 钉死的手动触发类型(供集成方发事件/落 metric)。 */
export interface ManualCompactResult extends CompactPipelineResult {
  /** 恒为 {@link CompactType.USER_COMMAND};本封装的语义标记。 */
  type: CompactType.USER_COMMAND;
}

/**
 * 触发一次**手动**压缩。复用 {@link runCompaction},scenario 钉成 `full`、
 * type 标 {@link CompactType.USER_COMMAND}。
 *
 * - 历史空 / 无可压前缀 → 管线 throw `Not enough messages to compact.`(原样上抛,
 *   集成方据此给用户「无需压缩」反馈)。
 * - summarize 非 PTL 失败 → 上抛(集成方决定终态;手动场景一般直接报错给用户)。
 *
 * 注意:本函数**不就地修改** `history`,也不发事件 / 不更新闸状态 —— 那些副作用
 * 归集成方(主循环)按 `coveredFrom/coveredTo/replacement` 做 splice + 发
 * CompactionApplied/PostCompact,与自动压同路径(见文件尾 §集成说明)。
 */
export async function triggerCompact(input: ManualCompactInput): Promise<ManualCompactResult> {
  const result = await runCompaction({
    messages: input.history,
    scenario: 'full', // 手动 = 全量摘要(对齐 agent.ts 中 USER_COMMAND 不属 PRE_MESSAGE_AUTO)
    marks: input.marks,
    summarize: input.summarize,
    sufficiencyRatio: input.sufficiencyRatio ?? 0.15,
    messagesToKeep: input.messagesToKeep ?? 0,
    now: input.now ?? Date.now(),
  });
  return { ...result, type: CompactType.USER_COMMAND };
}

/*
 * ─── §集成说明(给主循环串行集成者;A 层不接线)───────────────────────────────
 *
 * serveMethodNeeded(建议给 Studio 的 RPC method):
 *   compact(params?: { instructions?: string }) -> { compacted: boolean; usedLLM: boolean;
 *                                                    coveredFrom: number; coveredTo: number }
 *   数据来源:host 持有 history(ledger/transcript)、marks(v2Watermarks())、
 *   summarize(makeProviderCompactSummarize(provider, model);有 instructions 时改用
 *   能透传 instructions 的变体 → getCompactPrompt(scenario, instructions))。
 *   主循环:调 triggerCompact(...) → 据结果 messages.splice(coveredFrom, count, replacement)
 *   → 发 CompactionApplied/PostCompact → markCompactSuccess(闸状态)。可直接复用
 *   agent.ts `runCompactionV2` 成功分支的 splice/事件/重挂代码(force 路径,绕闸)。
 *
 * hostGetterNeeded(给 TUI CommandCtx 的 host getter,B 层接):
 *   triggerCompact(instructions?: string): Promise<{ compacted: boolean; usedLLM: boolean }>
 *   数据来源:同上 —— host-context.ts(assembleCapabilities)装配出能调上面 serve/agent
 *   路径的闭包,经 AgentDriver 出墙;TUI commands/compact.ts 调 ctx.triggerCompact(args)。
 */
