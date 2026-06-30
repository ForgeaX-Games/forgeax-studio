/**
 * Read 工具卡(梁① · canonical 真名 `read_file`)—— `● Read(path)` 头 + `⎿ Read N lines`。
 * 自注册 key='read_file'。只读 read_file 自己的 result 形状 `{ numLines | result }`。
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box } from 'ink';
import type { ToolView } from '../../contracts';
import { registerTool } from './registry';
import { ToolHeader, ResultLine } from './Default';

export const ReadView: ToolView = (p) => {
  // 行数:优先取 result.payload.numLines,否则按 result 文本计行。
  let summary = '';
  if (p.status !== 'running') {
    const payload = p.result as { numLines?: number; result?: unknown; isError?: boolean; message?: string } | undefined;
    if (payload?.isError || p.isError) {
      summary = payload?.message ?? 'error';
    } else if (typeof payload?.numLines === 'number') {
      summary = `Read ${payload.numLines} lines`;
    } else if (typeof payload?.result === 'string') {
      summary = `Read ${payload.result.split('\n').length} lines`;
    } else {
      summary = 'Read';
    }
  }
  return (
    <Box flexDirection="column">
      <ToolHeader p={p} />
      <ResultLine p={p} text={summary} error={p.isError} />
    </Box>
  );
};

registerTool('read_file', ReadView);
