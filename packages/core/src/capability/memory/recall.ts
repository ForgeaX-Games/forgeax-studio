/**
 * Memory recall — LLM-select over a frontmatter manifest (no embedding / no RAG).
 *
 * 召回 = 把 frontmatter
 * manifest 交给一个**模型选择器**挑出最相关的若干文件名(max 5)。core **不内置
 * LLM 调用**——选择器经注入(`MemorySelectFn`)由 host 提供;无 selectFn 时**回退取最新
 * N**(headers 已按 mtime 新→旧排)。max = `MEMORY_BUDGET.perTurnMaxFiles`。无 embedding。
 *
 * Boundary: 仅 import core-local 类型。
 */
import type { MemoryHeader } from './scan';
import { formatManifest } from './scan';
import { MEMORY_BUDGET } from '../memory-seam';

/**
 * 注入的记忆选择器(host 提供,通常背靠一次小模型 side-query)。
 * 入参:manifest 文本 + query;返回选中的 **filename 列表**(相对 memoryDir)。
 * core 只校验返回值是合法 filename 并裁到上限,不关心选择器内部实现。
 */
export type MemorySelectFn = (
  manifest: string,
  query: string,
) => string[] | Promise<string[]>;

/** 召回到的记忆头(含 mtime,供调用方渲染 freshness)。 */
export type RelevantMemory = MemoryHeader;

/**
 * 从已扫描的 headers 中挑出与 query 相关的记忆,上限 = MEMORY_BUDGET.perTurnMaxFiles。
 *
 * - 有 selectFn:渲染 manifest → selectFn(manifest, query) → 过滤为合法 filename →
 *   按选择器给出的顺序映射回 header → 裁到 max。选择器抛错 / 返回非数组 → 回退取最新。
 * - 无 selectFn:回退取最新 max 条(headers 已 mtime 新→旧排序)。
 *
 * `limit` 可进一步收窄(但不超过预算上限);<=0 视为用预算上限。
 */
export async function findRelevantMemories(
  headers: MemoryHeader[],
  query: string,
  selectFn?: MemorySelectFn,
  limit?: number,
): Promise<RelevantMemory[]> {
  const max =
    limit && limit > 0
      ? Math.min(limit, MEMORY_BUDGET.perTurnMaxFiles)
      : MEMORY_BUDGET.perTurnMaxFiles;
  if (headers.length === 0) return [];

  if (!selectFn) {
    return headers.slice(0, max);
  }

  let picked: string[];
  try {
    const result = await selectFn(formatManifest(headers), query);
    picked = Array.isArray(result) ? result : [];
  } catch {
    // 选择器失败 → 回退取最新,而非空(选择失败不应让本轮完全无记忆)。
    return headers.slice(0, max);
  }

  const byFilename = new Map(headers.map((h) => [h.filename, h]));
  const selected: RelevantMemory[] = [];
  const seen = new Set<string>();
  for (const name of picked) {
    if (seen.has(name)) continue;
    const h = byFilename.get(name);
    if (!h) continue; // 选择器幻觉的文件名:丢弃
    seen.add(name);
    selected.push(h);
    if (selected.length >= max) break;
  }
  return selected;
}
