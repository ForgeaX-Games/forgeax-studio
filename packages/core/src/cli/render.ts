/**
 * CLI renderer — AgentEvent stream → terminal text。
 * 纯函数:返回要打印的字符串(或 null 跳过),由 main 写 stdout。Boundary: 仅 core 相对。
 */
import type { AgentEvent } from '../agent/types';

function shortJson(v: unknown, max = 80): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function assistantText(ev: Extract<AgentEvent, { type: 'assistant' }>): string {
  const content = (ev.message.payload as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** 映射一个事件为终端输出片段;null = 不打印。 */
export function renderEvent(ev: AgentEvent): string | null {
  switch (ev.type) {
    case 'assistant': {
      const t = assistantText(ev);
      return t ? `\n${t}\n` : null;
    }
    case 'tool_call':
      return `\n⏺ ${ev.toolName}(${shortJson(ev.input)})`;
    case 'tool_result': {
      const p = ev.result.payload as { isError?: boolean; ok?: boolean; result?: unknown; message?: string };
      const err = p.isError || p.ok === false;
      return `\n  ⎿ ${err ? '✗ ' + (p.message ?? 'error') : shortJson(p.result ?? p)}`;
    }
    case 'turn_aborted':
      return `\n[aborted]`;
    case 'done':
      return ev.terminal.reason === 'completed' ? null : `\n[done: ${ev.terminal.reason}]`;
    default:
      return null;
  }
}
