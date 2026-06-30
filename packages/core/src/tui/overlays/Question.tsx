/**
 * Question 浮层(受控,无 useInput)—— AskUserQuestion 工具的结构化提问卡。
 *
 * 一次只渲染**当前题**(cursor/total 进度提示);选项列表末尾**恒补一行「其它/自填」**
 * (对齐 cc:Other 由 UI 自动提供,模型不必给)。高亮下标 index 由上层 state 持有:
 *   - index ∈ [0, options.length)  → 高亮某真选项;
 *   - index === options.length     → 高亮自填行(此时显示可编辑文本框 + 光标)。
 * 多选题真选项用 [x]/[ ] 勾选框 + 空格切换;单选题用 > 高亮 + enter 确认。本组件不调
 * useInput(梁③:单一输入 owner);导航/编辑由 input/router.ts 的 routeQuestion 产出。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { AskQuestionItem, PromptState, ThemeTokens } from '../contracts';
import { PromptInput } from '../input/PromptInput';

export interface QuestionOverlayProps {
  /** 当前正在回答的问题。 */
  item: AskQuestionItem;
  /** 当前题序(0-based)与总题数(进度提示)。 */
  cursor: number;
  total: number;
  /** 当前高亮下标(0..options.length;== options.length 即自填行)。 */
  index: number;
  /** 已勾选的真选项下标(multiSelect 用;单选题为空)。 */
  selected: number[];
  /** 当前题的自填文本缓冲(value+cursor;高亮自填行时可编辑)。 */
  other: PromptState;
  theme: ThemeTokens;
}

export function Question(props: QuestionOverlayProps): React.ReactElement {
  const { item, cursor, total, index, selected, other, theme } = props;
  const multi = item.multiSelect === true;
  const otherIndex = item.options.length;
  const otherActive = index === otherIndex;
  const progress = total > 1 ? `  (${cursor + 1}/${total})` : '';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent}>{`[${item.header}]${progress}`}</Text>
      <Text color={theme.text}>{item.question}</Text>
      <Box flexDirection="column">
        {item.options.map((o, i) => {
          const on = i === index;
          const mark = multi ? (selected.includes(i) ? '[x] ' : '[ ] ') : on ? '> ' : '  ';
          return (
            <Box key={`${o.label}-${i}`} flexDirection="column">
              <Text color={on ? theme.accent : theme.text}>{`${mark}${o.label}`}</Text>
              {o.description ? <Text color={theme.dim}>{`     ${o.description}`}</Text> : null}
            </Box>
          );
        })}
        {/* 自填行(恒在末尾):高亮时变可编辑文本框;否则只显示已填文本/占位。 */}
        {otherActive ? (
          <PromptInput value={other.value} cursor={other.cursor} placeholder="其它(自填答案)…" />
        ) : (
          <Text color={theme.text}>{`  其它(自填):${other.value ? other.value : '…'}`}</Text>
        )}
      </Box>
      <Text color={theme.dim}>
        {otherActive
          ? '输入自填答案 · enter 确认 · ↑↓ 切回选项 · esc 跳过'
          : multi
            ? '空格勾选 · ↑↓ 移动(末行可自填) · enter 确认 · esc 跳过'
            : '↑↓ 选择(末行可自填) · enter 确认 · esc 跳过'}
      </Text>
    </Box>
  );
}
