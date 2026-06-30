/**
 * PromptInput —— 受控纯渲染多行输入框(梁③:单 owner 后,组件自身不再 useInput)。
 *
 * 旧版自带 useInput + 内部 cursor state 已下沉到 input/{normalize,promptReducer,router}。
 * 本组件现为**纯展示**:value / cursor 由上层(P6 持 PromptState)传入,光标块按 cursor
 * 叠在多行文本上;无键盘处理、无内部可变状态 → 焦点不再与浮层/router 打架。
 *
 * 渲染规则:
 *   - 空 value → `> ` + 反显光标块 + 灰字 placeholder。
 *   - 多行 → 首行 `> `、续行 `  ` 缩进;光标所在行把字符拆 before/at/after,at 反显。
 *
 * ⚠️ 每个逻辑行必须渲染成**单个 `<Text>`**(prefix / 光标块用嵌套 `<Text>` 内联),
 * 绝不可用 `<Box>` 并列多个 `<Text>`:`<Box>` 是 flex 行容器,当某行长到软折行时,
 * 并列的各段会**各自独立折行**再被 yoga 拼接 → 整行错位、光标块被甩到首行末尾
 * (经典症状「光标跨行后停在第一行最后面」)。嵌套 `<Text>` 则作为一个文本流整体
 * 折行,光标块始终跟随内容。详见 cc 的 Cursor.render(单 Text + 内联 invert)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import { lineColOf } from './promptReducer';

export interface PromptInputProps {
  /** 全文(可含 \n)。 */
  value: string;
  /** 光标码点偏移(0..len);越界由渲染夹紧。 */
  cursor: number;
  /** value 为空时的灰字占位提示。 */
  placeholder?: string;
}

/** 受控纯渲染:不持状态、不调 useInput。 */
export function PromptInput(props: PromptInputProps): React.ReactElement {
  const theme = useTheme();
  return <Box>{renderValue(props.value, props.cursor, theme, props.placeholder)}</Box>;
}

/** 渲染多行 value,并在光标处叠一个反显光标块(theme.accent)。 */
function renderValue(
  value: string,
  cursor: number,
  theme: ReturnType<typeof useTheme>,
  placeholder?: string,
): React.ReactElement {
  if (value === '') {
    // 单 Text 内联:`> ` + 反显光标块 + 灰字 placeholder(整体作一个文本流,placeholder
    // 再长也随整行折行,不会因并列 Box 而错位)。
    return (
      <Text color={theme.text}>
        <Text color={theme.accent}>{'> '}</Text>
        <Text color={theme.accent} inverse>
          {' '}
        </Text>
        {placeholder ? <Text color={theme.dim}>{placeholder}</Text> : null}
      </Text>
    );
  }
  const lines = value.split('\n');
  const { line: curLine, col: curCol } = lineColOf(value, cursor);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const isCursorLine = i === curLine;
        const prefix = i === 0 ? '> ' : '  ';
        if (!isCursorLine) {
          return (
            <Text key={i} color={theme.text}>
              <Text color={theme.accent}>{prefix}</Text>
              {line.length ? line : ' '}
            </Text>
          );
        }
        // 光标行:拆 before / 光标字符 / after(按码点切,CJK 安全),光标用嵌套反显块。
        // 整行单 Text → 软折行时光标块随内容走,绝不被甩到首行末尾。
        const arr = Array.from(line);
        const before = arr.slice(0, curCol).join('');
        const at = arr[curCol] ?? ' ';
        const after = arr.slice(curCol + 1).join('');
        return (
          <Text key={i} color={theme.text}>
            <Text color={theme.accent}>{prefix}</Text>
            {before}
            <Text color={theme.accent} inverse>
              {at}
            </Text>
            {after}
          </Text>
        );
      })}
    </Box>
  );
}
