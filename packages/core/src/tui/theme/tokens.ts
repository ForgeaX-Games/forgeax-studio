/**
 * 单一 dark 主题 token(本期唯一允许出现颜色字面量的文件;见 PRD §6.7 / A8)。
 *
 * 中→重扩展:多主题 = 把这里改成 ThemeTokens[] + ThemePicker 选择,纯数据扩展,
 * 不改任何组件(组件只经 useTheme() 取 token)。
 *
 * 颜色用 Ink 支持的颜色字符串(命名色 / hex 皆可)。这里用命名色以利窄终端兼容。
 * Boundary(HOST 层):无 import。
 */
import type { ThemeTokens } from '../contracts';

export const darkTheme: ThemeTokens = {
  text: 'white',
  dim: 'gray',
  accent: 'cyan',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  border: 'gray',
  bg: 'black',
  userMark: 'cyan',
  assistantMark: 'magenta',
  diffAdd: 'green',
  diffRemove: 'red',
  diffAddBg: '#16361b', // 暗绿(新增行整行底色)
  diffRemoveBg: '#3d1414', // 暗红(删除行整行底色)
  codeBg: 'blackBright',
  userBg: '#3a3a3a', // 中灰(用户消息满宽条)
};

export const defaultTheme = darkTheme;
