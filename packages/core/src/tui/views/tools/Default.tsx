/**
 * Default 工具视图 + 共享卡件(`● Title(arg)` 头 + `⎿ 摘要`)。
 *
 * 自注册 key='default';resolveTool 未命中即回落本卡。其他工具视图复用这里的
 * ToolHeader / ResultLine / 宽度 & 行号工具。
 *
 * 注:ToolView 签名(梁① 契约)带 `displayName`(toolMeta 解出),故头部直接用
 * `p.displayName`,不再维护本地 friendlyName 名表(SSOT 收敛到 toolMeta)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { ToolView, ThemeTokens } from '../../contracts';
import { registerTool } from './registry';
import { Spinner } from '../../components/Spinner';

/** 头部括号里的关键参数(路径/命令/模式/查询)。 */
export function toolArg(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.file_path === 'string') return o.file_path;
  if (typeof o.path === 'string') return o.path;
  if (typeof o.pattern === 'string') return o.pattern;
  if (typeof o.query === 'string') return o.query;
  if (typeof o.command === 'string') return o.command.length > 50 ? o.command.slice(0, 45) + '...' : o.command;
  return '';
}

export function statusColor(status: 'running' | 'ok' | 'error', theme: ThemeTokens): string {
  if (status === 'error') return theme.error;
  if (status === 'ok') return theme.success;
  return theme.dim;
}

// 宽字符感知的宽度工具已抽到共享 ../../text-width;此处再导出,保持既有 import 路径不变。
export { displayWidth, padToWidth, termWidth } from '../../text-width';

export function summarize(v: unknown, max = 80): string {
  if (v == null) return '';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** ToolView 的窄属性别名,供共享卡件签名复用。 */
type ViewProps = Parameters<ToolView>[0];

/** 摘要时跳过的「协议/元」字段(非人读内容)——避免它们混进 scalar digest。 */
const HIDE_KEYS = new Set([
  'toolUseId', 'isError', 'ok', 'unsupported', 'status', 'tool', 'type', 'source', 'answers',
]);

/** 按优先级挑第一个非空字符串字段。 */
function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/** 把 payload 剩余**标量**字段拼成 `k: v`(数组→计数;对象→跳过)。
 *  这是「绝不 dump 原始 JSON」的兜底:无人读字段时也只出一行可读摘要。 */
function scalarDigest(o: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (HIDE_KEYS.has(k)) continue;
    if (typeof v === 'string') {
      if (v.trim() !== '') parts.push(`${k}: ${v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}: ${v}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}: ${v.length} item(s)`);
    }
    // object / null / undefined → 跳过(绝不渲染原始 JSON)
  }
  return parts.join('  ');
}

/**
 * result.payload 摘要(running 时空)。**绝不直接渲染原始 JSON**:
 *   1) 优先人读字段(content 是面向 LLM/人 的文本;再 result/message/… 的字符串值);
 *   2) 否则把剩余标量字段拼成 `k: v` 兜底;
 *   3) 实在没有 → 空(只剩头部 `* ToolName`)。
 */
export function resultSummary(p: ViewProps): { error: boolean; text: string } {
  if (p.status === 'running') return { error: false, text: '' };
  const payload = p.result as Record<string, unknown> | undefined;
  const error = p.isError === true || payload?.isError === true || payload?.ok === false;
  if (!payload || typeof payload !== 'object') return { error, text: error ? 'error' : '' };
  if (error) return { error: true, text: summarize(pickString(payload, ['message', 'error', 'content']) ?? 'error') };
  const human = pickString(payload, ['content', 'result', 'message', 'summary', 'text', 'path', 'output']);
  if (human) return { error: false, text: summarize(human) };
  return { error: false, text: summarize(scalarDigest(payload)) };
}

/** 卡片头:`● Title(arg)`(running→Spinner;ok→绿●;error→红●)。
 *  title 缺省取 p.displayName(toolMeta 解出的友好名)。 */
export function ToolHeader(props: { p: ViewProps; title?: string; hideArg?: boolean }): React.ReactElement {
  const { p } = props;
  const color = statusColor(p.status, p.theme);
  const name = props.title ?? p.displayName;
  const arg = props.hideArg ? '' : toolArg(p.input);
  return (
    <Box>
      {p.status === 'running' ? <Spinner /> : <Text color={color}>{'*'}</Text>}
      <Text color={p.theme.text} bold>{` ${name}`}</Text>
      {arg ? <Text color={p.theme.dim}>{`(${arg})`}</Text> : null}
    </Box>
  );
}

/** 结果行:`  ⎿ <text>`(error 红)。 */
export function ResultLine(props: { p: ViewProps; text: string; error?: boolean }): React.ReactElement | null {
  if (!props.text) return null;
  return (
    <Text color={props.error ? props.p.theme.error : props.p.theme.dim}>
      {'  ⎿ '}
      {props.text}
    </Text>
  );
}

export const DefaultView: ToolView = (p) => {
  const res = resultSummary(p);
  return (
    <Box flexDirection="column">
      <ToolHeader p={p} />
      <ResultLine p={p} text={res.text} error={res.error} />
    </Box>
  );
};

registerTool('default', DefaultView);
