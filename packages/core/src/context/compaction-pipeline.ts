/**
 * Compaction pipeline (Stream E / #5·#12) — 三层管线编排,产单条 replacement 供 ledger fold。
 *
 *   L1 确定性瘦身(deterministic-compact:剥图/omit tool结果/大参数)
 *      ↓ 估 token
 *   sufficiency 短路(#12):L1 后已 ≤ effective×ratio → **不调 LLM**,用确定性骨架产 replacement
 *      ↓ 否则
 *   L2 LLM 摘要(host summarize;scenario prompt)
 *      ↓ summarize 抛 PTL → head-drop 重试(≤MAX_PTL_RETRIES);抛非 PTL → 上抛(E 回滚 + 熔断++)
 *   L3 PTL 兜底(在 summarizeWithPTLRetry 内)
 *
 * 两路都产 **单条 replacement** 覆盖 [coveredFrom..coveredTo],经 CompactionApplied → fold(可逆)。
 * 保留尾部 messagesToKeep 条不进压缩范围;边界安全:范围尾不以孤儿 tool_result 起头。
 *
 * 纯编排 + 注入 summarize(core 不自调 LLM)。Boundary: 仅 import core-local 类型。
 */
import type { ProviderMessage } from '../provider/types';
import type { CompactPipelineInput, CompactPipelineResult } from './compaction-types';
import { deterministicCompact, isSufficient, estimateTokens } from './deterministic-compact';
import {
  getCompactUserSummaryMessage,
  truncateHeadForPTLRetry,
  MAX_PTL_RETRIES,
} from './compaction-llm';
import { isPromptTooLong } from './reactive-recovery';
import { startsWithToolResult } from './tool-pairing';

/** 确定性骨架的固定 header(单 run 内唯一;de-nest 时据此剥旧 header,防多次压缩 header 堆叠)。 */
export const DETERMINISTIC_SUMMARY_HEADER = 'Summary of the conversation so far (deterministic compaction — no LLM):';

/** 一条消息是否为「上一轮压缩产出的摘要」(确定性或 LLM 路都会打 `_compactionSummary` 标记)。 */
export function isPriorCompactionSummary(m: unknown): boolean {
  return !!(m && typeof m === 'object' && (m as Record<string, unknown>)._compactionSummary === true);
}

/** 剥掉确定性骨架的 header 行(若存在),返回其内层结构(已含 <previous_*> 包裹,不再重包)。 */
export function stripDeterministicHeader(content: string): string {
  const idx = content.indexOf(DETERMINISTIC_SUMMARY_HEADER);
  if (idx >= 0) return content.slice(idx + DETERMINISTIC_SUMMARY_HEADER.length).trimStart();
  return content;
}

/** 把 L1 瘦身后的前缀渲染成确定性骨架文本(sufficiency 短路时替代 LLM 摘要)。
 *  结构采用 previous_* 标签,但仅保骨架、零 LLM。
 *
 *  ★ de-nest(防多次压缩递归折叠):若某条是**上一轮压缩摘要**(`_compactionSummary`),
 *  **不再重包** `<previous_*>` —— 剥掉它的旧 header 后**原样并入**其内层(确定性摘要的内层已是
 *  `<previous_*>` 包裹;LLM 摘要内层是续接文本)。 */
export function renderDeterministicSummary(messages: readonly ProviderMessage[]): string {
  const lines: string[] = [DETERMINISTIC_SUMMARY_HEADER, ''];
  for (const m of messages) {
    const rec = m as unknown as Record<string, unknown>;
    // 旧压缩摘要 → de-nest:剥 header、原样并入内层,绝不二次包裹。
    if (isPriorCompactionSummary(m)) {
      const inner = stripDeterministicHeader(typeof rec.content === 'string' ? rec.content : '');
      if (inner.trim()) lines.push(inner);
      continue;
    }
    const role = rec.role;
    const content = rec.content;
    const text = typeof content === 'string' ? content : renderBlocks(content);
    if (!text.trim()) continue;
    if (role === 'user') lines.push(`<previous_user_message>\n${text}\n</previous_user_message>`);
    else if (role === 'assistant') lines.push(`<previous_assistant_message>\n${text}\n</previous_assistant_message>`);
    else lines.push(text);
  }
  return lines.join('\n');
}

function renderBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'tool_use') out.push(`[tool_call ${String(b.name ?? 'unknown')} ${jsonish(b.input)}]`);
    else if (b.type === 'tool_result') out.push(`[tool_result: ${truncate(String((b as any).content ?? ''), 200)}]`);
  }
  return out.join('\n');
}

function jsonish(v: unknown): string {
  try {
    return truncate(JSON.stringify(v ?? {}), 300);
  } catch {
    return '{}';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Carve 待压前缀(保留尾 messagesToKeep),边界安全回退避免孤儿 tool_result。返回 exclusive 上界。 */
function carveSummarizeUpTo(messages: readonly ProviderMessage[], messagesToKeep: number): number {
  const keep = Math.min(Math.max(0, messagesToKeep), Math.max(0, messages.length - 1));
  let upTo = messages.length - keep;
  while (upTo > 1 && upTo < messages.length && startsWithToolResult(messages[upTo])) upTo--;
  return upTo;
}

/** L2:调 summarize,PTL → head-drop 重试(≤MAX_PTL_RETRIES);非 PTL 上抛。 */
async function summarizeWithPTLRetry(
  messages: readonly ProviderMessage[],
  scenario: CompactPipelineInput['scenario'],
  summarize: CompactPipelineInput['summarize'],
): Promise<string> {
  let current: readonly ProviderMessage[] = messages;
  let attempts = 0;
  for (;;) {
    try {
      return await summarize(current, scenario);
    } catch (err) {
      if (!isPromptTooLong(err)) throw err; // 非 PTL → 上抛(E 回滚)
      attempts++;
      const truncated = attempts <= MAX_PTL_RETRIES ? truncateHeadForPTLRetry(current) : null;
      if (!truncated) throw err instanceof Error ? err : new Error('compaction failed: prompt too long');
      current = truncated as ProviderMessage[];
    }
  }
}

/**
 * 跑压缩管线,产 CompactPipelineResult。throw = 压缩失败(E 应回滚 + 熔断计数)。
 */
export async function runCompaction(input: CompactPipelineInput): Promise<CompactPipelineResult> {
  const { messages, marks, sufficiencyRatio, scenario, summarize, messagesToKeep } = input;
  if (messages.length === 0) throw new Error('Not enough messages to compact.');

  const upTo = carveSummarizeUpTo(messages, messagesToKeep);
  const prefix = messages.slice(0, upTo);
  if (prefix.length === 0) throw new Error('Not enough messages to compact.');

  // L1 确定性瘦身
  const l1 = deterministicCompact(prefix);
  const coveredTo = upTo - 1;

  // sufficiency 短路 → 确定性骨架,不调 LLM
  if (isSufficient(l1.estimatedTokens, marks.effectiveWindow, sufficiencyRatio)) {
    const content = renderDeterministicSummary(l1.messages as ProviderMessage[]);
    const replacement: ProviderMessage = {
      role: 'user',
      content,
      ...({ _compactionSummary: true, _deterministic: true, _coveredCount: prefix.length } as Record<string, unknown>),
    } as ProviderMessage;
    return { replacement, coveredFrom: 0, coveredTo, usedLLM: false, estimatedTokens: estimateTokens([replacement]) };
  }

  // L2 LLM 摘要(喂 L1 瘦身后的前缀,省 token)
  const summary = await summarizeWithPTLRetry(l1.messages as ProviderMessage[], scenario, summarize);
  const replacement: ProviderMessage = {
    role: 'user',
    content: getCompactUserSummaryMessage(summary),
    ...({ _compactionSummary: true, _coveredCount: prefix.length } as Record<string, unknown>),
  } as ProviderMessage;
  return { replacement, coveredFrom: 0, coveredTo, usedLLM: true, estimatedTokens: estimateTokens([replacement]) };
}
