/**
 * ResumePicker 浮层(受控,无 useInput)—— /resume 会话选择页(对齐 cc LogSelector)。
 *
 * 「编辑 + 导航」混合态(与 command-menu 同形,**不**进 OVERLAY_MODES):输入框复用为
 * 搜索框,敲字实时收窄列表;↑↓ 在过滤后的列表里环形移高亮,enter 选中,esc 关闭。
 * 列表 + 高亮 index + 搜索串由上层 state 持有,本组件只做纯渲染;导航由 router 的
 * routeResumePicker 处理。**本组件不调 useInput**(梁③:单一输入 owner)。
 *
 * 选中 → Repl 调 agent.resumeSession(id):既 reseed 下一轮 LLM 历史,又把恢复会话的
 * transcript 回灌(替换)当前会话。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import type { Key, SessionSummary } from '../contracts';
import type { NavResult } from './CommandMenu';

export type { NavResult };

/** 列表一屏最多可见条数(超出用上下「更多」提示,窗口随高亮滚动;对齐 CommandMenu)。 */
export const MAX_VISIBLE = 8;

/** 子串模糊匹配(对 title + id 大小写不敏感)。空 query → 全列表。 */
export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((s) => `${s.title ?? ''} ${s.id}`.toLowerCase().includes(needle));
}

/** 相对时间文案(纯函数,now 由上层传入以便单测)。粒度到天,够列表用。 */
export function formatRelTime(mtimeMs: number, now: number): string {
  const diff = Math.max(0, now - mtimeMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

/** KB 文案(一位小数)。 */
function formatSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/** /resume 打开时的默认高亮下标:优先**当前激活会话**(activeId),不在列表则回退第一条(0)。 */
export function initialResumeIndex(sessions: SessionSummary[], activeId: string | undefined): number {
  const i = sessions.findIndex((s) => s.id === activeId);
  return i >= 0 ? i : 0;
}

/**
 * ResumePicker 纯导航 reducer —— 与 CommandMenu/ModelPicker 同构,供测试 / router 复用语义。
 * ↑↓ 环形移动高亮、enter 选中当前、esc 关闭;其余按键 none(router 据混合态决定是否转 edit)。
 */
export function resumeReducer(index: number, length: number, key: Key): NavResult {
  if (key.kind === 'esc') return { kind: 'close' };
  if (length === 0) return { kind: 'none' };
  if (key.kind === 'up') return { kind: 'move', index: (index - 1 + length) % length };
  if (key.kind === 'down') return { kind: 'move', index: (index + 1) % length };
  if (key.kind === 'enter') return { kind: 'select', index };
  return { kind: 'none' };
}

export interface ResumePickerProps {
  /** 经 filterSessions(query) 得到的会话列表(由上层算好传入)。 */
  sessions: SessionSummary[];
  /** 当前高亮下标(由上层 state 持有)。 */
  index: number;
  /** 当前搜索串(= 复用的输入框内容);用于无匹配提示。 */
  query: string;
  /** 渲染相对时间的「现在」(由上层传 Date.now())。 */
  now: number;
}

export function ResumePicker(props: ResumePickerProps): React.ReactElement {
  const theme = useTheme();
  const { sessions, index, query, now } = props;

  const window = useMemo(() => {
    if (sessions.length === 0) return null;
    const begin = Math.max(
      0,
      Math.min(index - Math.floor(MAX_VISIBLE / 2), sessions.length - MAX_VISIBLE),
    );
    const visible = sessions.slice(begin, begin + MAX_VISIBLE);
    return { begin, visible, hiddenAbove: begin, hiddenBelow: sessions.length - (begin + visible.length) };
  }, [sessions, index]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{'恢复会话(输入搜索 | up/down 选择 | enter 恢复 | esc 返回)'}</Text>
      {!window ? (
        <Text color={theme.dim}>{query ? `无匹配会话:${query}` : '没有可恢复的会话'}</Text>
      ) : (
        <>
          {window.hiddenAbove > 0 ? <Text color={theme.dim}>{`  ^ ${window.hiddenAbove} 更多`}</Text> : null}
          {window.visible.map((s, vi) => {
            const i = window.begin + vi;
            const active = i === index;
            const title = s.title && s.title.length > 0 ? s.title : s.id;
            return (
              <Box key={s.id} flexDirection="column">
                <Text color={active ? theme.accent : theme.text}>
                  {active ? '> ' : '  '}
                  {title}
                </Text>
                <Text color={theme.dim}>
                  {`    ${formatRelTime(s.mtimeMs, now)} · ${formatSize(s.sizeBytes)} · ${s.id}`}
                </Text>
              </Box>
            );
          })}
          {window.hiddenBelow > 0 ? <Text color={theme.dim}>{`  v ${window.hiddenBelow} 更多`}</Text> : null}
        </>
      )}
    </Box>
  );
}
