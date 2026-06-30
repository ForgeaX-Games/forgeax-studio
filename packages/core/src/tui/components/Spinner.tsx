/** Spinner(T1 转交)—— ink-spinner 包装,色走 token。
 *  Boundary(HOST 层):react + ink + ink-spinner + 相对 import。 */
import React from 'react';
import { Text } from 'ink';
import InkSpinner from 'ink-spinner';
import { useTheme } from '../providers/theme';
export function Spinner(): React.ReactElement {
  const theme = useTheme();
  return <Text color={theme.accent}><InkSpinner type="dots" /></Text>;
}
