/**
 * AskUserQuestion 工具卡(梁① · canonical 真名 `AskUserQuestion`)。
 *
 * 默认卡会把结果 payload 当 JSON 摘要直接 dump(`⎿ {"toolUseId":...,"answers":...}`),
 * 不可读。本卡读 result.payload.answers(AskUserQuestionResultEntry[]),逐题渲染成
 * `⎿ <问题> -> <选中项>`(对齐 cc 的「User answered…」摘要)。无答案=已跳过;
 * unsupported/error → 显示提示文案。
 *
 * ⚠️ 箭头用 ASCII `->`、不用 `→`(ambiguous 宽字符会导致矮终端/CJK 残影,见 TUI 残影根因)。
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box } from 'ink';
import type { ToolView } from '../../contracts';
import { registerTool } from './registry';
import { ToolHeader, ResultLine } from './Default';

interface AnswerEntry {
  question?: string;
  header?: string;
  selected?: string[];
  other?: string;
}

export const AskUserQuestionView: ToolView = (p) => {
  const payload = p.result as
    | { answers?: AnswerEntry[]; unsupported?: boolean; message?: string }
    | undefined;
  const error = p.isError === true || payload?.unsupported === true;
  const answers = payload?.answers ?? [];
  return (
    <Box flexDirection="column">
      <ToolHeader p={p} />
      {p.status === 'running' ? null : error ? (
        <ResultLine p={p} text={payload?.message ?? 'error'} error />
      ) : answers.length === 0 ? (
        <ResultLine p={p} text="(已跳过)" />
      ) : (
        answers.map((a, i) => {
          const q = a.question ?? a.header ?? '';
          const label = a.selected && a.selected.length ? a.selected.join(', ') : '(未作答)';
          return <ResultLine key={i} p={p} text={`${q} -> ${label}`} />;
        })
      )}
    </Box>
  );
};

registerTool('AskUserQuestion', AskUserQuestionView);
