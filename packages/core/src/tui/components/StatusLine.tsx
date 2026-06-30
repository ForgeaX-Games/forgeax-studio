/**
 * StatusLine(T8)—— 一行渲染 busy spinner / tokens / 耗时 / model(经 useStatusLine)。
 *
 * 布局:[spinner?] N(tokens,随流实时,>=1k 紧凑成 N.Nk)| N.Ns | model
 *   - 仅 s.busy 时前缀 <Spinner/>(ink-spinner);非 busy 不占位。
 *   - 各段缺失即优雅留空(不渲染空 ' | '),整行无数据时空行。
 *   - 刻意只留 token / 耗时 / 模型三项;ctx%、cwd、键位提示等一律不显示(用户要求极简)。
 * 无硬编码颜色(A8):一切走 useTheme() token。
 * Boundary(HOST 层):react + ink + 相对 import(Spinner)。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import { useStatusLine } from '../providers/status-line';
import { Spinner } from './Spinner';

/** token 计数紧凑化:>=1000 用 k(一位小数),否则原值。状态栏寸土寸金。 */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function StatusLine(): React.ReactElement {
  const theme = useTheme();
  const s = useStatusLine();

  const parts: string[] = [];
  if (s.tokens != null) parts.push(fmtTokens(s.tokens));
  if (s.elapsedMs != null) parts.push(`${(s.elapsedMs / 1000).toFixed(1)}s`);
  if (s.model) parts.push(s.model);

  const middle = parts.join(' | ');

  return (
    <Box flexDirection="row">
      {s.busy ? (
        <Box marginRight={1}>
          <Spinner />
        </Box>
      ) : null}
      {middle ? <Text color={theme.dim}>{middle}</Text> : null}
    </Box>
  );
}
