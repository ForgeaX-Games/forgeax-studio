/** ThinkingIndicator(T8 转交)—— T0 stub:busy 时 spinner + thinking…。
 *  Boundary(HOST 层):react + ink + 相对 import。 */
import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner';
import { useTheme } from '../providers/theme';
export function ThinkingIndicator(props: { busy?: boolean }): React.ReactElement | null {
  const theme = useTheme();
  if (!props.busy) return null;
  return <Box><Spinner /><Text color={theme.dim}> thinking...</Text></Box>;
}
