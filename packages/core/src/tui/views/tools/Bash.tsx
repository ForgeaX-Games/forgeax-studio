/**
 * Bash 工具卡(梁① · canonical 真名 `bash`)—— `● Bash` 头 + `⎿ $ cmd` + 输出摘要。
 * 自注册 key='bash'。只读 bash 自己的 input 形状 `{ command }`。
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { ToolView } from '../../contracts';
import { registerTool } from './registry';
import { ToolHeader, resultSummary } from './Default';

export const BashView: ToolView = (p) => {
  const cmd = (p.input as { command?: string })?.command ?? '';
  const res = resultSummary(p);
  return (
    <Box flexDirection="column">
      <ToolHeader p={p} title="Bash" hideArg />
      {cmd ? (
        <Text color={p.theme.accent}>
          {'  ⎿ $ '}
          {cmd}
        </Text>
      ) : null}
      {res.text ? (
        <Text color={res.error ? p.theme.error : p.theme.dim}>
          {'       '}
          {res.text}
        </Text>
      ) : null}
    </Box>
  );
};

registerTool('bash', BashView);
