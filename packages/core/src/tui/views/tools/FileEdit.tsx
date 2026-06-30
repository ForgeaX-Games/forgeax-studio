/**
 * 写文件卡(梁① · canonical 真名 `write_file`→Write / `edit_file`→Update),
 * 渲染形态:
 *   ● Write(path)            ● Update(path)
 *     ⎿ Wrote N lines to path   ⎿ Added/Removed N line(s)
 *        1 hello world             1  hello2
 *                                  2 +我爱你   ← 新增行整行绿底
 *
 * 同一渲染器在两个真名下各 register 一次(by-name 的「多工具共用一卡」)。
 * 用 p.name(已是 canonical)区分 write/edit;只读 file-edit 自己的 input 形状。
 * Boundary(HOST 层):react + ink + diff + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import { diffLines } from 'diff';
import type { ToolView } from '../../contracts';
import { registerTool } from './registry';
import { ToolHeader, ResultLine, padToWidth, termWidth } from './Default';

interface EditInput {
  file_path?: string;
  path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
}

type ViewProps = Parameters<ToolView>[0];

const MAX_LINES = 20;

/** 行号宽度(右对齐)。 */
function gutter(n: number, w: number): string {
  return String(n).padStart(w, ' ');
}

/** Write:带行号的内容预览(全新增,不上绿底,保持轻量)。 */
function writeBody(p: ViewProps, path: string, content: string): React.ReactElement {
  const lines = content.split('\n');
  const shown = lines.slice(0, MAX_LINES);
  const gw = String(lines.length).length;
  return (
    <Box flexDirection="column">
      <ResultLine p={p} text={`Wrote ${lines.length} line${lines.length === 1 ? '' : 's'} to ${path}`} />
      {shown.map((ln, i) => (
        <Box key={i}>
          <Text color={p.theme.dim}>{`     ${gutter(i + 1, gw)} `}</Text>
          <Text color={p.theme.text}>{ln}</Text>
        </Box>
      ))}
      {lines.length > MAX_LINES ? <Text color={p.theme.dim}>{`     ... +${lines.length - MAX_LINES} 行`}</Text> : null}
    </Box>
  );
}

/** Update:old→new 行级 diff,带行号;新增行整行绿底、删除行红底。 */
function editBody(p: ViewProps, path: string, oldText: string, newText: string): React.ReactElement {
  const parts = diffLines(oldText, newText);
  const width = termWidth();
  const rows: React.ReactElement[] = [];
  let added = 0;
  let removed = 0;
  let lineNo = 0;
  let key = 0;
  for (const part of parts) {
    const ls = part.value.split('\n');
    if (ls[ls.length - 1] === '') ls.pop();
    for (const ln of ls) {
      if (rows.length >= MAX_LINES) break;
      if (part.added) {
        added++;
        lineNo++;
        const txt = `  ${String(lineNo).padStart(3)} +${ln}`;
        rows.push(
          <Text key={key++} color={p.theme.text} backgroundColor={p.theme.diffAddBg}>{padToWidth(txt, width)}</Text>,
        );
      } else if (part.removed) {
        removed++;
        const txt = `      -${ln}`;
        rows.push(
          <Text key={key++} color={p.theme.diffRemove} backgroundColor={p.theme.diffRemoveBg}>{padToWidth(txt, width)}</Text>,
        );
      } else {
        lineNo++;
        rows.push(
          <Box key={key++}>
            <Text color={p.theme.dim}>{`  ${String(lineNo).padStart(3)}  `}</Text>
            <Text color={p.theme.text}>{ln}</Text>
          </Box>,
        );
      }
    }
  }
  const summary =
    added && removed ? `Updated ${path} (+${added} −${removed})` : added ? `Added ${added} line${added === 1 ? '' : 's'}` : `Removed ${removed} line${removed === 1 ? '' : 's'}`;
  return (
    <Box flexDirection="column">
      <ResultLine p={p} text={summary} />
      {rows}
    </Box>
  );
}

export const FileEditView: ToolView = (p) => {
  const input = (p.input ?? {}) as EditInput;
  const path = input.file_path ?? input.path ?? '';
  const isWrite = p.name === 'write_file' || (input.content != null && input.old_string == null);
  const res = (p.result as { isError?: boolean; ok?: boolean; message?: string } | undefined) ?? undefined;
  const error = p.isError === true || res?.isError === true || res?.ok === false;

  return (
    <Box flexDirection="column">
      <ToolHeader p={p} />
      {p.status === 'running' ? null : error ? (
        <ResultLine p={p} text={res?.message ?? 'error'} error />
      ) : isWrite ? (
        writeBody(p, path, input.content ?? input.new_string ?? '')
      ) : (
        editBody(p, path, input.old_string ?? '', input.new_string ?? '')
      )}
    </Box>
  );
};

registerTool('edit_file', FileEditView);
registerTool('write_file', FileEditView);
