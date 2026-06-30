/**
 * CommandMenu 浮层(受控,无 useInput)—— slash 命令菜单。
 *
 * 由 P6 router 在 mode==='command-menu' 时驱动:列表 + 高亮 index 由上层 state 持有,
 * 本组件只做纯渲染;导航(↑↓/enter/esc)交给本文件导出的纯 reducer
 * `commandMenuReducer`,供 router 调。**本组件不调 useInput**(梁③:单一输入 owner)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import { listCommands } from '../commands/registry';
import { displayWidth, termWidth, clampToLines } from '../text-width';
import type { Key, SlashCommand } from '../contracts';

/** 描述最多展示几行(超出截断为省略号)。 */
const DESC_MAX_LINES = 2;
/** 名列宽上限/下限(显示列;含前导 marker)。 */
const NAME_COL_MAX = 28;
const NAME_COL_MIN = 12;

export const MAX_VISIBLE = 8;

/** 子串模糊匹配(对 name + desc 大小写不敏感)。 */
function matches(cmd: SlashCommand, needle: string): boolean {
  if (!needle) return true;
  const hay = `${cmd.name} ${cmd.desc}`.toLowerCase();
  return hay.includes(needle);
}

/** 纯过滤+排序:给定 filter 串(不含前导 '/')→ 命令列表(name 子串优先,次 name 字典序)。 */
export function filterCommands(filter: string | undefined): SlashCommand[] {
  const needle = (filter ?? '').toLowerCase();
  return listCommands()
    .filter((c) => matches(c, needle))
    .sort((a, b) => {
      const an = a.name.toLowerCase().includes(needle) ? 0 : 1;
      const bn = b.name.toLowerCase().includes(needle) ? 0 : 1;
      if (an !== bn) return an - bn;
      return a.name.localeCompare(b.name);
    });
}

/** 导航 reducer 的产出:新高亮 index、或选中某项、或关闭。 */
export type NavResult =
  | { kind: 'move'; index: number }
  | { kind: 'select'; index: number }
  | { kind: 'close' }
  | { kind: 'none' };

/**
 * CommandMenu 纯导航 reducer —— 供 P6 router 调。
 * ↑↓ 环形移动高亮、enter 选中当前、esc 关闭;其余按键返回 none(由 router 决定是否转交 prompt)。
 * @param index 当前高亮下标
 * @param length 可见命令数量
 * @param key 归一化按键
 */
export function commandMenuReducer(index: number, length: number, key: Key): NavResult {
  if (key.kind === 'esc') return { kind: 'close' };
  if (length === 0) return { kind: 'none' };
  if (key.kind === 'up') return { kind: 'move', index: (index - 1 + length) % length };
  if (key.kind === 'down') return { kind: 'move', index: (index + 1) % length };
  if (key.kind === 'enter') return { kind: 'select', index };
  return { kind: 'none' };
}

export interface CommandMenuProps {
  /** 用户已输入的过滤串('/' 之后的内容);用于无匹配时的提示文案。 */
  filter?: string;
  /** 经 filterCommands(filter) 得到的命令列表(由上层算好传入)。 */
  commands: SlashCommand[];
  /** 当前高亮下标(由上层 state 持有)。 */
  index: number;
}

export function CommandMenu(props: CommandMenuProps): React.ReactElement {
  const theme = useTheme();
  const { commands, index } = props;

  const window = useMemo(() => {
    if (commands.length === 0) return null;
    const start = Math.max(
      0,
      Math.min(index - Math.floor(MAX_VISIBLE / 2), commands.length - MAX_VISIBLE),
    );
    const begin = Math.max(0, start);
    const visible = commands.slice(begin, begin + MAX_VISIBLE);
    return {
      visible,
      hiddenAbove: begin,
      hiddenBelow: commands.length - (begin + visible.length),
    };
  }, [commands, index]);

  // 两列布局:左=名(定宽,随最长名自适应并设上限),右=描述(最多 DESC_MAX_LINES 行,宽字符感知截断)。
  const layout = useMemo(() => {
    // 名列宽 = max(可见命令 `  /name` 的显示宽) + 1 间隔,夹在 [MIN, MAX]。
    const longest = commands.reduce((m, c) => Math.max(m, displayWidth(`  /${c.name}`)), 0);
    const nameCol = Math.min(NAME_COL_MAX, Math.max(NAME_COL_MIN, longest + 1));
    const inner = termWidth() - 2; // round border 各占 1 列
    const descCol = Math.max(10, inner - nameCol);
    return { nameCol, descCol };
  }, [commands]);

  if (!window) {
    return (
      <Box flexDirection="column">
        <Text color={theme.dim}>
          {props.filter ? `无匹配命令:/${props.filter}` : '无可用命令'}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border}>
      {window.hiddenAbove > 0 ? <Text color={theme.dim}>{`  ^ ${window.hiddenAbove} 更多`}</Text> : null}
      {window.visible.map((c) => {
        const active = commands[index]?.name === c.name;
        const descLines = clampToLines(c.desc ?? '', layout.descCol, DESC_MAX_LINES);
        return (
          <Box key={c.name} flexDirection="row">
            {/* 左列:名(定宽,不收缩 → 描述列对齐) */}
            <Box width={layout.nameCol} flexShrink={0}>
              <Text color={active ? theme.accent : theme.text} wrap="truncate-end">
                {active ? '> ' : '  '}
                {`/${c.name}`}
              </Text>
            </Box>
            {/* 右列:描述(至多 2 行;预截断后再加 truncate-end 兜底) */}
            <Box flexDirection="column" flexShrink={1}>
              {descLines.map((ln, i) => (
                <Text key={i} color={theme.dim} wrap="truncate-end">
                  {ln}
                </Text>
              ))}
            </Box>
          </Box>
        );
      })}
      {window.hiddenBelow > 0 ? <Text color={theme.dim}>{`  v ${window.hiddenBelow} 更多`}</Text> : null}
    </Box>
  );
}
