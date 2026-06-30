/**
 * Theme provider —— useTheme() 取单主题 token(PRD §6.7)。
 *
 * 中→重:把 value 换成可切换的 token 数组即升级,组件零改动。
 * Boundary(HOST 层):react + 相对 import。
 */
import React, { createContext, useContext } from 'react';
import type { ThemeTokens } from '../contracts';
import { defaultTheme } from '../theme/tokens';

const ThemeContext = createContext<ThemeTokens>(defaultTheme);

export function ThemeProvider(props: { theme?: ThemeTokens; children: React.ReactNode }): React.ReactElement {
  return <ThemeContext.Provider value={props.theme ?? defaultTheme}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeTokens {
  return useContext(ThemeContext);
}
