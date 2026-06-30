/** Markdown(T1)—— 依赖-free 行级解析 → Ink 渲染。
 *  支持:标题(bold+accent)、无序/有序列表、加粗/斜体/行内代码、
 *  围栏代码块委派 Code、链接(text + dim url)、简单管道表格(列对齐)。
 *  纯文本稳健透传(无 md 语法时原样)。无新增依赖,marked 未装故不用。
 *  Boundary(HOST 层):react + ink + 相对 import(Code 同目录)。 */
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import { Code } from './Code';

type Theme = ReturnType<typeof useTheme>;

// ── 行内片段(bold/italic/code/link/plain)──
type Inline =
  | { t: 'plain'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; text: string; url: string };

/** 行内解析:**bold** *italic* `code` [text](url),其余纯文本。robust:无标记即整体 plain。 */
function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push({ t: 'plain', v: buf });
      buf = '';
    }
  };
  while (i < src.length) {
    const rest = src.slice(i);
    // inline code `...`
    let m = /^`([^`]+)`/.exec(rest);
    if (m) {
      flush();
      out.push({ t: 'code', v: m[1]! });
      i += m[0].length;
      continue;
    }
    // link [text](url)
    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      flush();
      out.push({ t: 'link', text: m[1]!, url: m[2]! });
      i += m[0].length;
      continue;
    }
    // bold **...** or __...__
    m = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest);
    if (m) {
      flush();
      out.push({ t: 'bold', v: m[1]! });
      i += m[0].length;
      continue;
    }
    // italic *...* or _..._（避免吞掉 ** 已在上面优先处理）
    m = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (m) {
      flush();
      out.push({ t: 'italic', v: m[1]! });
      i += m[0].length;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return out;
}

function InlineRun(props: { src: string; theme: Theme; baseColor?: string }): React.ReactElement {
  const { theme } = props;
  const parts = parseInline(props.src);
  return (
    <Text color={props.baseColor ?? theme.text}>
      {parts.map((p, idx) => {
        switch (p.t) {
          case 'bold':
            return (
              <Text key={idx} bold>
                {p.v}
              </Text>
            );
          case 'italic':
            return (
              <Text key={idx} italic>
                {p.v}
              </Text>
            );
          case 'code':
            return (
              <Text key={idx} color={theme.accent} backgroundColor={theme.codeBg}>
                {p.v}
              </Text>
            );
          case 'link':
            return (
              <Text key={idx}>
                <Text color={theme.accent} underline>
                  {p.text}
                </Text>
                <Text color={theme.dim}> ({p.url})</Text>
              </Text>
            );
          default:
            return <Text key={idx}>{p.v}</Text>;
        }
      })}
    </Text>
  );
}

// ── 块级模型 ──
type Block =
  | { t: 'heading'; level: number; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }
  | { t: 'code'; lang?: string; code: string }
  | { t: 'table'; header: string[]; rows: string[][] }
  | { t: 'para'; text: string }
  | { t: 'blank' };

function splitTableRow(line: string): string[] {
  // 去首尾 | 再按 | 分列(简单表格,不处理转义 \|)。
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  // |---|:--:|---| 这类分隔行。
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

/** 行级解析成块。robust:任何不识别的行落 para。 */
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // 围栏代码块 ```lang
    const fence = /^```(\w[\w+-]*)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // 跳过收尾 ```
      blocks.push({ t: 'code', lang, code: body.join('\n') });
      continue;
    }

    // 标题 # .. ######
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ t: 'heading', level: h[1]!.length, text: h[2]!.trim() });
      i += 1;
      continue;
    }

    // 表格:当前行像 |a|b| 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const header = splitTableRow(line);
      i += 2; // 跳过 header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      blocks.push({ t: 'table', header, rows });
      continue;
    }

    // 无序列表(连续 - / * / +）
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ t: 'ul', items });
      continue;
    }

    // 有序列表(连续 1. 2. ...)
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push({ t: 'ol', items });
      continue;
    }

    // 空行
    if (line.trim() === '') {
      blocks.push({ t: 'blank' });
      i += 1;
      continue;
    }

    // 段落:合并到下一空行/块边界。
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^```/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ t: 'para', text: para.join('\n') });
  }
  return blocks;
}

function TableBlock(props: { header: string[]; rows: string[][]; theme: Theme }): React.ReactElement {
  const { header, rows, theme } = props;
  const cols = header.length;
  // 每列宽 = max(表头, 各行)可见长度。
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = (header[c] ?? '').length;
    for (const r of rows) w = Math.max(w, (r[c] ?? '').length);
    widths[c] = w;
  }
  const pad = (s: string, c: number): string => {
    const cell = s ?? '';
    return cell + ' '.repeat(Math.max(0, (widths[c] ?? 0) - cell.length));
  };
  return (
    <Box flexDirection="column">
      <Box>
        {header.map((cell, c) => (
          <Text key={c} bold color={theme.accent}>
            {pad(cell, c)}
            {c < cols - 1 ? '  ' : ''}
          </Text>
        ))}
      </Box>
      {rows.map((r, ri) => (
        <Box key={ri}>
          {Array.from({ length: cols }).map((_, c) => (
            <Text key={c} color={theme.text}>
              {pad(r[c] ?? '', c)}
              {c < cols - 1 ? '  ' : ''}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function Markdown(props: { children: string }): React.ReactElement {
  const theme = useTheme();
  const blocks = parseBlocks(props.children ?? '');
  return (
    <Box flexDirection="column">
      {blocks.map((b, idx) => {
        switch (b.t) {
          case 'heading':
            return (
              <Box key={idx}>
                <Text bold color={theme.accent}>
                  {'#'.repeat(b.level)} {b.text}
                </Text>
              </Box>
            );
          case 'ul':
            return (
              <Box key={idx} flexDirection="column">
                {b.items.map((it, ii) => (
                  <Box key={ii}>
                    <Text color={theme.accent}>{'  - '}</Text>
                    <InlineRun src={it} theme={theme} />
                  </Box>
                ))}
              </Box>
            );
          case 'ol':
            return (
              <Box key={idx} flexDirection="column">
                {b.items.map((it, ii) => (
                  <Box key={ii}>
                    <Text color={theme.accent}>{`  ${ii + 1}. `}</Text>
                    <InlineRun src={it} theme={theme} />
                  </Box>
                ))}
              </Box>
            );
          case 'code':
            return (
              <Box key={idx}>
                <Code code={b.code} lang={b.lang} />
              </Box>
            );
          case 'table':
            return <TableBlock key={idx} header={b.header} rows={b.rows} theme={theme} />;
          case 'blank':
            return <Text key={idx}> </Text>;
          default:
            return (
              <Box key={idx}>
                <InlineRun src={b.text} theme={theme} />
              </Box>
            );
        }
      })}
    </Box>
  );
}
