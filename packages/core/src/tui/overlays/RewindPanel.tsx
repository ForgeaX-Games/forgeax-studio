/**
 * RewindPanel 浮层(受控,无 useInput)—— 回退点面板(空输入时双击 esc 拉起)。
 *
 * 三个子态(stage),共用 ↑↓/enter/esc 导航(router 走 navReduce → overlay-move/select/close,
 * 由 P6/Repl 据 stage 解释 select 语义):
 *   - list    选回退点(每个 user 轮一个);enter → 进 confirm。
 *   - confirm 显示选中点的 diff 摘要;enter → 执行回退(对话截断 + 文件还原),esc → 回 list。
 *   - pending 回退已挂起:Redo 恢复 / 这些文件也回退 / 撤销 / 选更早回退点;enter → 执行动作。
 *
 * 列表/动作 + 高亮 index 由上层 state 持有,本组件只做纯渲染。
 * **本组件不调 useInput**(梁③:单一输入 owner)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import type { Key, DiffStats } from '../contracts';
import type { NavResult } from './CommandMenu';

export type { NavResult };
export { MAX_VISIBLE } from './CommandMenu';

/** 一个回退点:展示用标签 + 它在 session.messages 里的「保留到」下标(含该轮之前)。 */
export interface Checkpoint {
  label: string;
  /** 选中后 session 只保留前 keep 条消息。 */
  keep: number;
  /** 文件快照锚点;'' = 该消息无文件快照(/resume 重建的历史)。 */
  msgId: string;
  /** 是否含文件快照(决定回退是否还原文件)。 */
  hasCode: boolean;
}

export type RewindStage = 'list' | 'confirm' | 'pending';

/** pending 子态的一项动作(由 Repl 据 pending 状态动态构造)。 */
export interface RewindAction {
  key: 'redo' | 'overwrite' | 'undo' | 'more';
  label: string;
}

/**
 * RewindPanel 纯导航 reducer —— 列表/动作通用(↑↓ 环形、enter 选中、esc 关闭/返回)。
 * 注:router 对 OVERLAY_MODES 走通用 navReduce,本 reducer 保留供直接单测/复用。
 */
export function rewindReducer(index: number, length: number, key: Key): NavResult {
  if (key.kind === 'esc') return { kind: 'close' };
  if (length === 0) return { kind: 'none' };
  if (key.kind === 'up') return { kind: 'move', index: (index - 1 + length) % length };
  if (key.kind === 'down') return { kind: 'move', index: (index + 1) % length };
  if (key.kind === 'enter') return { kind: 'select', index };
  return { kind: 'none' };
}

export interface RewindPanelProps {
  stage: RewindStage;
  checkpoints: Checkpoint[];
  /** 当前高亮下标(由上层 state 持有)。 */
  index: number;
  /** confirm 子态:选中的回退点 + 其 diff 摘要(null = 纯对话回退/无文件变更)。 */
  pick?: { cp: Checkpoint; diff: DiffStats | null } | null;
  /** pending 子态:可执行动作列表。 */
  actions?: RewindAction[];
}

const MAX = 8;

export function RewindPanel(props: RewindPanelProps): React.ReactElement {
  const theme = useTheme();
  const { stage, checkpoints, index, pick, actions } = props;

  if (stage === 'confirm' && pick) {
    const d = pick.diff;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
        <Text color={theme.warning}>{'<< 确认回退(enter 确认 | esc 返回)'}</Text>
        <Text color={theme.text}>{pick.cp.label}</Text>
        {!pick.cp.hasCode || !d ? (
          <Text color={theme.dim}>{'(纯对话回退:不改动任何文件)'}</Text>
        ) : d.filesChanged.length === 0 ? (
          <Text color={theme.dim}>{'(文件无变更,仅截断对话)'}</Text>
        ) : (
          <Box flexDirection="column">
            <Text color={theme.text}>
              {`将还原 ${d.filesChanged.length} 个文件 `}
              <Text color={theme.diffAdd}>{`+${d.insertions}`}</Text>
              {' '}
              <Text color={theme.diffRemove}>{`-${d.deletions}`}</Text>
              {d.binaryOrLarge > 0 ? <Text color={theme.dim}>{`  (${d.binaryOrLarge} 二进制/大文件)`}</Text> : null}
            </Text>
            {d.files.slice(0, MAX).map((f) => (
              <Text key={f.path} color={theme.dim}>
                {`  ${statusMark(f.status)} ${f.path}`}
                {f.binary ? ' (二进制)' : ` +${f.insertions} -${f.deletions}`}
              </Text>
            ))}
            {d.files.length > MAX ? <Text color={theme.dim}>{`  …还有 ${d.files.length - MAX} 个`}</Text> : null}
          </Box>
        )}
      </Box>
    );
  }

  if (stage === 'pending') {
    const acts = actions ?? [];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent}>{'<< 回退已挂起(up/down 选择 | enter 执行 | esc 关闭)'}</Text>
        {acts.length === 0 ? (
          <Text color={theme.dim}>{'(无可执行动作)'}</Text>
        ) : (
          acts.map((a, i) => (
            <Box key={a.key}>
              <Text color={i === index ? theme.accent : theme.text}>
                {(i === index ? '> ' : '  ') + a.label}
              </Text>
            </Box>
          ))
        )}
      </Box>
    );
  }

  // stage === 'list'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{'<< 回退点(up/down 选择 | enter 回退 | esc 取消)'}</Text>
      {checkpoints.length === 0 ? (
        <Text color={theme.dim}>{'(还没有可回退的对话)'}</Text>
      ) : (
        checkpoints.slice(0, MAX).map((cp, i) => {
          const active = i === index;
          return (
            <Box key={cp.keep}>
              <Text color={active ? theme.accent : theme.text}>
                {active ? '> ' : '  '}
                {cp.label}
                {cp.hasCode ? <Text color={theme.dim}>{' (代码)'}</Text> : null}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function statusMark(s: 'added' | 'deleted' | 'modified'): string {
  return s === 'added' ? '+' : s === 'deleted' ? '-' : '~';
}
