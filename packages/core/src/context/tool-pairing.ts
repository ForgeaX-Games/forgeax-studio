/**
 * tool_use / tool_result 配对完整性
 * (`ensureToolResultPairing` + `adjustIndexToPreserveAPIInvariants`)。
 *
 * Anthropic/OpenAI 都要求:每个 tool_use 必须有对应 tool_result,反之亦然;tool_use id
 * 唯一。压缩(summarize 掉一段)极易把一对 tool_use/tool_result 劈开 → 留下孤儿 → 次轮
 * 400。两道防线:
 *   1. **boundaryStartsWithToolResult / 边界回退**:压缩时让保留尾部不以孤儿 tool_result 起头
 *      (compaction-llm 用),把整对一起留进尾部,不劈开、不丢信息。
 *   2. **ensureToolResultPairing**:**每次发 provider 前**兜底——丢孤儿 tool_use / 孤儿
 *      tool_result、按 id 去重、清空消息丢弃。即使上游漏判也不 400。
 * Boundary: 仅 core 相对 import。
 */
import type { ProviderMessage } from '../provider/types';

interface Block {
  type: string;
  id?: string;
  tool_use_id?: string;
  [k: string]: unknown;
}

function asBlocks(content: unknown): Block[] | null {
  return Array.isArray(content) ? (content as Block[]) : null;
}

/** 该消息是否以 tool_result 块起头(用作压缩边界安全判定)。 */
export function startsWithToolResult(msg: ProviderMessage): boolean {
  const blocks = asBlocks(msg.content);
  return !!blocks && blocks.length > 0 && blocks[0].type === 'tool_result';
}

/** 该消息是否含任一 tool_result 块。 */
export function hasToolResult(msg: ProviderMessage): boolean {
  const blocks = asBlocks(msg.content);
  return !!blocks && blocks.some((b) => b.type === 'tool_result');
}

/**
 * 清理孤儿 + 去重,保证发给 provider 的消息序列 tool 配对完整(ensureToolResultPairing)。
 * - 丢 tool_result(其 tool_use_id 无对应 tool_use)。
 * - 丢 tool_use(其 id 无对应 tool_result)—— 压缩把结果摘掉后的孤儿。
 * - tool_use id 去重(防 "tool_use ids must be unique")。
 * - 清空 content 的消息整条丢弃(防空 content 400)。
 * 纯函数,不 mutate 入参。
 */
export function ensureToolResultPairing(messages: readonly ProviderMessage[]): ProviderMessage[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    const blocks = asBlocks(m.content);
    if (!blocks) continue;
    for (const b of blocks) {
      if (b.type === 'tool_use' && typeof b.id === 'string') toolUseIds.add(b.id);
      else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') toolResultIds.add(b.tool_use_id);
    }
  }

  const seenToolUse = new Set<string>();
  const out: ProviderMessage[] = [];
  for (const m of messages) {
    const blocks = asBlocks(m.content);
    if (!blocks) {
      out.push(m); // string content(含压缩摘要)原样
      continue;
    }
    const kept: Block[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        if (!toolResultIds.has(b.id)) continue; // 孤儿 tool_use → 丢
        if (seenToolUse.has(b.id)) continue; // 重复 id → 丢
        seenToolUse.add(b.id);
        kept.push(b);
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (!toolUseIds.has(b.tool_use_id)) continue; // 孤儿 tool_result → 丢
        kept.push(b);
      } else {
        kept.push(b);
      }
    }
    if (kept.length === 0) continue; // 整条空 → 丢(防空 content)
    out.push({ ...m, content: kept });
  }
  return out;
}
