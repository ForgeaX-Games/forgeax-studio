/**
 * 搜索工具卡(梁① · canonical 真名 `glob` / `grep`)—— `● Search(pattern)` 头 + 命中数摘要。
 *
 * glob/grep input 形状各异但都有 `pattern`(glob: 文件 glob;grep: 正则);此卡读其
 * 各自已知形状,各自 register 一次(by-name:不共享 input 形状假设,只读自己有的)。
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box } from 'ink';
import type { ToolView } from '../../contracts';
import { registerTool } from './registry';
import { ToolHeader, ResultLine, summarize } from './Default';

/** 从 result 估算命中条数(数组长度 / 换行计数 / 文本摘要)。 */
function resultSummaryText(p: Parameters<ToolView>[0]): { error: boolean; text: string } {
  if (p.status === 'running') return { error: false, text: '' };
  const payload = p.result as
    | { isError?: boolean; ok?: boolean; result?: unknown; message?: string }
    | undefined;
  const error = p.isError === true || payload?.isError === true || payload?.ok === false;
  if (error) return { error: true, text: payload?.message ?? 'error' };
  const r = payload?.result ?? payload;
  if (Array.isArray(r)) return { error: false, text: `Found ${r.length} match${r.length === 1 ? '' : 'es'}` };
  if (typeof r === 'string') {
    const n = r.trim() === '' ? 0 : r.trim().split('\n').length;
    return { error: false, text: `Found ${n} match${n === 1 ? '' : 'es'}` };
  }
  return { error: false, text: summarize(r) };
}

export const SearchView: ToolView = (p) => {
  const res = resultSummaryText(p);
  return (
    <Box flexDirection="column">
      <ToolHeader p={p} />
      <ResultLine p={p} text={res.text} error={res.error} />
    </Box>
  );
};

registerTool('glob', SearchView);
registerTool('grep', SearchView);
