/**
 * ModelPicker 浮层(受控,无 useInput)—— /model 选择页。
 *
 * 列表 + 高亮 index 由上层 state 持有,本组件只做纯渲染;导航(↑↓/enter/esc)交给
 * 本文件导出的纯 reducer `modelPickerReducer`,供 P6 router 调。
 * 选中 → router 调 driver.setModel(id);esc → router 关闭回 prompt。
 * **本组件不调 useInput**(梁③:单一输入 owner)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import type { Key } from '../contracts';
import type { NavResult } from './CommandMenu';

export type { NavResult };

/** 内置候选模型(可后续做成可配置)。current 不在表里也会并入。 */
export const KNOWN_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5',
  'gemini-2.5-pro',
  'deepseek-v4',
];

/** 把 current 并入已知模型表(去重,current 不在表里则置首)。 */
export function modelList(current: string): string[] {
  return KNOWN_MODELS.includes(current) ? KNOWN_MODELS : [current, ...KNOWN_MODELS];
}

/**
 * ModelPicker 纯导航 reducer —— 供 P6 router 调。
 * ↑↓ 环形移动、enter 选中当前、esc 关闭。
 */
export function modelPickerReducer(index: number, length: number, key: Key): NavResult {
  if (key.kind === 'esc') return { kind: 'close' };
  if (length === 0) return { kind: 'none' };
  if (key.kind === 'up') return { kind: 'move', index: (index - 1 + length) % length };
  if (key.kind === 'down') return { kind: 'move', index: (index + 1) % length };
  if (key.kind === 'enter') return { kind: 'select', index };
  return { kind: 'none' };
}

export interface ModelPickerProps {
  /** 候选模型(由上层 modelList(current) 算好传入)。 */
  models: string[];
  /** 当前生效模型(标 ●)。 */
  current: string;
  /** 当前高亮下标(由上层 state 持有)。 */
  index: number;
}

export function ModelPicker(props: ModelPickerProps): React.ReactElement {
  const theme = useTheme();
  const { models, current, index } = props;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{'选择模型(up/down 选择 | enter 切换 | esc 返回)'}</Text>
      {models.map((m, i) => {
        const active = i === index;
        const isCurrent = m === current;
        return (
          <Box key={m}>
            <Text color={active ? theme.accent : theme.text}>
              {active ? '> ' : '  '}
              {isCurrent ? '* ' : '  '}
              {m}
            </Text>
            {isCurrent ? <Text color={theme.dim}>{'  (当前)'}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
