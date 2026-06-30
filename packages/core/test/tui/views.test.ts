/**
 * P4 — views/ 单测(梁① · by canonical name)。
 *
 * 覆盖:
 *  - tools registry:按真名 resolve / 别名经 fake toolMeta 后命中 / 未知→Default 兜底 /
 *    永不抛;resolveToolByMeta 便捷函数。
 *  - 各 ToolView(Bash/FileEdit/Read/Search/Default)对其自身 input/result 形状的关键字段。
 *  - messages registry:user/assistant/notice 按键命中,未知→thin 兜底;resolveMessageByItem。
 *  - 各 MessageView(User/Assistant/Thinking/Notice)关键字段。
 *
 * 仅 `bun test test/tui/views.test.ts`。
 */
import { test, expect, describe } from 'bun:test';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { defaultTheme } from '../../src/tui/theme/tokens';
import type { ToolView, AgentEvent, TranscriptItem } from '../../src/tui/contracts';

// barrel imports → 触发各视图副作用注册。
import {
  registerTool,
  resolveTool,
  resolveToolByMeta,
} from '../../src/tui/views/tools/index';
import { BashView } from '../../src/tui/views/tools/Bash';
import { FileEditView } from '../../src/tui/views/tools/FileEdit';
import { ReadView } from '../../src/tui/views/tools/Read';
import { SearchView } from '../../src/tui/views/tools/Search';
import { DefaultView } from '../../src/tui/views/tools/Default';

import {
  resolveMessage,
  resolveMessageByItem,
  messageKeyOf,
  registerMessage,
  type MessageView,
} from '../../src/tui/views/messages/index';
import { UserView } from '../../src/tui/views/messages/User';
import { AssistantView } from '../../src/tui/views/messages/Assistant';
import { ThinkingView } from '../../src/tui/views/messages/Thinking';
import { NoticeView } from '../../src/tui/views/messages/Notice';

const THEME = defaultTheme;
const NEVER = '__never_registered__';

/** 假 toolMeta:把 PascalCase 别名映射回 canonical 真名(模拟 driver.toolMeta)。 */
const ALIAS: Record<string, string> = {
  Bash: 'bash',
  Edit: 'edit_file',
  Write: 'write_file',
  Read: 'read_file',
  Glob: 'glob',
  Grep: 'grep',
};
function fakeToolMeta(name: string): { canonical: string } {
  return { canonical: ALIAS[name] ?? name };
}

/** ToolView 调用助手:渲染并返回 lastFrame。 */
function renderTool(view: ToolView, p: Partial<Parameters<ToolView>[0]>): string {
  const node = view({
    name: p.name ?? 'x',
    displayName: p.displayName ?? p.name ?? 'x',
    input: p.input,
    result: p.result,
    status: p.status ?? 'ok',
    isError: p.isError,
    theme: THEME,
  });
  return render(node as React.ReactElement).lastFrame() ?? '';
}

function renderMsg(view: MessageView, item: TranscriptItem, expanded?: boolean): string {
  // 仅 user/assistant/notice 三类进消息视图。
  const node = view({ item: item as never, theme: THEME, expanded });
  if (node == null) return '';
  return render(node as React.ReactElement).lastFrame() ?? '';
}

// ─────────────────────────── tools registry ───────────────────────────
describe('tools registry (by canonical name)', () => {
  test('builtin tools resolve under REAL canonical names (not default)', () => {
    const def = resolveTool('default');
    expect(resolveTool('bash')).toBe(BashView);
    expect(resolveTool('edit_file')).toBe(FileEditView);
    expect(resolveTool('write_file')).toBe(FileEditView);
    expect(resolveTool('read_file')).toBe(ReadView);
    expect(resolveTool('glob')).toBe(SearchView);
    expect(resolveTool('grep')).toBe(SearchView);
    // 各专用卡 ≠ default 卡。
    for (const name of ['bash', 'edit_file', 'read_file', 'glob']) {
      expect(resolveTool(name)).not.toBe(def);
    }
  });

  test('default key resolves to DefaultView (rich)', () => {
    expect(resolveTool('default')).toBe(DefaultView);
  });

  test('unknown canonical falls back to default (no throw, renders)', () => {
    const view = resolveTool(NEVER);
    expect(view).toBe(DefaultView);
    expect(() => renderTool(view, { name: NEVER, input: { a: 1 }, status: 'ok' })).not.toThrow();
  });

  test('registry does NOT do alias resolution itself (raw alias misses → default)', () => {
    // 'Bash'(别名)直查 registry 不命中 → 落 default(证明解析责任不在 registry)。
    expect(resolveTool('Bash')).toBe(DefaultView);
  });

  test('resolveToolByMeta: alias resolves via toolMeta then hits real view', () => {
    expect(resolveToolByMeta(fakeToolMeta, 'Bash')).toBe(BashView);
    expect(resolveToolByMeta(fakeToolMeta, 'Write')).toBe(FileEditView);
    expect(resolveToolByMeta(fakeToolMeta, 'Edit')).toBe(FileEditView);
    expect(resolveToolByMeta(fakeToolMeta, 'Read')).toBe(ReadView);
    expect(resolveToolByMeta(fakeToolMeta, 'Glob')).toBe(SearchView);
    expect(resolveToolByMeta(fakeToolMeta, 'Grep')).toBe(SearchView);
  });

  test('resolveToolByMeta: real name passes through; unknown → default', () => {
    expect(resolveToolByMeta(fakeToolMeta, 'bash')).toBe(BashView);
    expect(resolveToolByMeta(fakeToolMeta, 'mcp__foo__bar')).toBe(DefaultView);
  });

  test('registerTool under a fresh canonical name takes effect', () => {
    const marker = (() => createElement('Text', null, 'X')) as ToolView;
    registerTool('__dummy_tool__', marker);
    expect(resolveTool('__dummy_tool__')).toBe(marker);
  });
});

// ─────────────────────────── tool views key fields ───────────────────────────
describe('tool views render key fields', () => {
  test('BashView shows Bash header + $ command + output', () => {
    const out = renderTool(BashView, {
      name: 'bash',
      displayName: 'Bash',
      input: { command: 'echo hi' },
      result: { result: 'hi' },
      status: 'ok',
    });
    expect(out).toContain('Bash');
    expect(out).toContain('echo hi');
    expect(out).toContain('hi');
  });

  test('FileEditView (write) shows Wrote N lines + numbered content', () => {
    const out = renderTool(FileEditView, {
      name: 'write_file',
      displayName: 'Write',
      input: { file_path: '/tmp/a.txt', content: 'hello\nworld' },
      status: 'ok',
    });
    expect(out).toContain('Wrote 2 lines');
    expect(out).toContain('/tmp/a.txt');
    expect(out).toContain('hello');
    expect(out).toContain('world');
  });

  test('FileEditView (edit) shows added/removed diff lines', () => {
    const out = renderTool(FileEditView, {
      name: 'edit_file',
      displayName: 'Update',
      input: { file_path: '/tmp/a.txt', old_string: 'a\nb', new_string: 'a\nc' },
      status: 'ok',
    });
    // 新增的 c 行带 + 号;删除的 b 行带 - 号。
    expect(out).toContain('+c');
    expect(out).toContain('-b');
  });

  test('FileEditView error result shows message in red path', () => {
    const out = renderTool(FileEditView, {
      name: 'write_file',
      displayName: 'Write',
      input: { file_path: '/tmp/a.txt', content: 'x' },
      result: { isError: true, message: 'EACCES denied' },
      isError: true,
      status: 'error',
    });
    expect(out).toContain('EACCES denied');
  });

  test('ReadView shows Read N lines from numLines', () => {
    const out = renderTool(ReadView, {
      name: 'read_file',
      displayName: 'Read',
      input: { file_path: '/tmp/a.txt' },
      result: { numLines: 42 },
      status: 'ok',
    });
    expect(out).toContain('Read 42 lines');
    expect(out).toContain('/tmp/a.txt');
  });

  test('SearchView shows match count from array result', () => {
    const out = renderTool(SearchView, {
      name: 'grep',
      displayName: 'Search',
      input: { pattern: 'foo' },
      result: { result: ['a', 'b', 'c'] },
      status: 'ok',
    });
    expect(out).toContain('Found 3 matches');
    expect(out).toContain('foo');
  });

  test('DefaultView shows displayName + arg', () => {
    const out = renderTool(DefaultView, {
      name: 'mcp__foo__bar',
      displayName: 'mcp__foo__bar',
      input: { path: '/x/y' },
      result: { result: 'done' },
      status: 'ok',
    });
    expect(out).toContain('mcp__foo__bar');
    expect(out).toContain('/x/y');
  });

  test('running status renders without throwing (no result yet)', () => {
    expect(() =>
      renderTool(BashView, { name: 'bash', displayName: 'Bash', input: { command: 'sleep 1' }, status: 'running' }),
    ).not.toThrow();
  });

  test('DefaultView prefers human `content`, never dumps raw JSON', () => {
    const out = renderTool(DefaultView, {
      name: 'skill',
      displayName: 'skill',
      result: { toolUseId: 't', content: 'Launching skill: foo', status: 'forked' },
      status: 'ok',
    });
    expect(out).toContain('Launching skill: foo');
    expect(out).not.toContain('toolUseId'); // 不再 dump 协议字段
    expect(out).not.toContain('{');
  });

  test('DefaultView falls back to scalar digest (no JSON) when no human field', () => {
    const out = renderTool(DefaultView, {
      name: 'memory',
      displayName: 'memory',
      result: { toolUseId: 't', tool: 'memory', hits: 3 },
      status: 'ok',
    });
    expect(out).toContain('hits: 3');
    expect(out).not.toContain('toolUseId');
    expect(out).not.toContain('{');
  });
});

// ─────────────────────────── messages registry ───────────────────────────
function assistantEvent(text: string, thinking?: string): Extract<AgentEvent, { type: 'assistant' }> {
  const content: Array<{ type: string; text?: string; thinking?: string }> = [];
  if (thinking != null) content.push({ type: 'thinking', thinking });
  if (text) content.push({ type: 'text', text });
  return { type: 'assistant', message: { payload: { content } } as never };
}

describe('messages registry (by key)', () => {
  test('messageKeyOf maps user/notice/assistant correctly', () => {
    expect(messageKeyOf({ kind: 'user', id: 0, text: 'x' })).toBe('user');
    expect(messageKeyOf({ kind: 'notice', id: 0, level: 'info', text: 'x' })).toBe('notice');
    expect(messageKeyOf({ kind: 'assistant', id: 0, event: assistantEvent('hi') })).toBe('assistant');
  });

  test('builtin keys resolve to their views (not default)', () => {
    expect(resolveMessage('user')).toBe(UserView);
    expect(resolveMessage('assistant')).toBe(AssistantView);
    expect(resolveMessage('notice')).toBe(NoticeView);
  });

  test('unknown key falls back to thin default (no throw, renders)', () => {
    const view = resolveMessage(NEVER);
    expect(typeof view).toBe('function');
    const node = view({ item: { kind: 'user', id: 0, text: 'x' }, theme: THEME });
    expect(node).toBeTruthy();
  });

  test('resolveMessageByItem dispatches by item kind/event.type', () => {
    expect(resolveMessageByItem({ kind: 'user', id: 0, text: 'x' })).toBe(UserView);
    expect(resolveMessageByItem({ kind: 'notice', id: 0, level: 'warn', text: 'x' })).toBe(NoticeView);
    expect(resolveMessageByItem({ kind: 'assistant', id: 0, event: assistantEvent('hi') })).toBe(AssistantView);
  });

  test('registerMessage under fresh key takes effect', () => {
    const marker = (() => createElement('Text', null, 'M')) as MessageView;
    registerMessage('turn_start', marker);
    expect(resolveMessage('turn_start')).toBe(marker);
  });
});

// ─────────────────────────── message views key fields ───────────────────────────
describe('message views render key fields', () => {
  test('UserView shows › mark + text', () => {
    const out = renderMsg(UserView, { kind: 'user', id: 0, text: 'hello world' });
    expect(out).toContain('›');
    expect(out).toContain('hello world');
  });

  test('UserView 多行(显式 \\n)首行用 › 续行用缩进', () => {
    const out = renderMsg(UserView, { kind: 'user', id: 0, text: 'first\nsecond' });
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines[0]).toContain('›');
    expect(out).toContain('first');
    expect(out).toContain('second');
  });

  // 回归:长 CJK 段落软折行时不得丢字、不得出现孤立单字行,且整行须为扁平 Text。
  // 根因:旧版 User.tsx 让每个逻辑行的 <Text> 内嵌套一个前缀 <Text>;含子节点的 Text
  // 会触发 Ink(yoga)在真 TTY 下的盒子宽度测量偏差 → 提前断行 / 行尾大段留白(CJK 尤甚)。
  // 修复:每行渲染成一个扁平、无子节点的 <Text>,前缀(`› `/缩进)直接拼进字符串。
  // 注:本测试在非交互管道下跑,无法复现 yoga 偏差本身,故守住两条可在管道里验证的指纹
  // (不丢字、无孤立单字行);真 TTY 的「行尾留白」由 reporter 在 VSCode 终端实测确认。
  test('UserView 长 CJK 段落:窄宽下不丢字、不出现孤立单字行', () => {
    const text =
      '面对国内游戏产品数据隐私合规压力与监管趋严，本课程结合法规要求与实务痛点，' +
      '系统讲解个人信息处理全流程合规要点，助你掌握协议配置、权限管理、用户权利保障及特殊场景合规策略。';
    const prevCols = process.stdout.columns;
    // 模拟窄终端(50 列),触发软折行。
    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    try {
      const out = renderMsg(UserView, { kind: 'user', id: 0, text });
      // 1) 全部内容字符都在(逐码点都能在渲染输出里找到 —— 折行不丢字)。
      for (const ch of text) expect(out).toContain(ch);
      // 2) 不得有「只含一个 CJK 字符」的孤立行(旧 bug 的指纹)。
      const orphan = out
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /^[\u4e00-\u9fff，。、]$/.test(l));
      expect(orphan).toBeUndefined();
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prevCols, configurable: true });
    }
  });

  test('AssistantView renders text via markdown', () => {
    const out = renderMsg(AssistantView, { kind: 'assistant', id: 0, event: assistantEvent('assistant reply') });
    expect(out).toContain('assistant reply');
  });

  test('AssistantView with no text returns null (renders empty)', () => {
    const out = renderMsg(AssistantView, { kind: 'assistant', id: 0, event: assistantEvent('') });
    expect(out).toBe('');
  });

  test('ThinkingView collapsed shows preview + ctrl+o hint', () => {
    const out = renderMsg(
      ThinkingView,
      { kind: 'assistant', id: 0, event: assistantEvent('', 'pondering the universe') },
      false,
    );
    expect(out).toContain('thinking');
    expect(out).toContain('pondering the universe');
    expect(out).toContain('ctrl+o');
  });

  test('ThinkingView expanded shows full text without hint', () => {
    const out = renderMsg(
      ThinkingView,
      { kind: 'assistant', id: 0, event: assistantEvent('', 'deep thought') },
      true,
    );
    expect(out).toContain('deep thought');
    expect(out).not.toContain('ctrl+o');
  });

  test('NoticeView error shows x + text', () => {
    const out = renderMsg(NoticeView, { kind: 'notice', id: 0, level: 'error', text: 'boom' });
    expect(out).toContain('x');
    expect(out).toContain('boom');
  });

  test('NoticeView warn shows ! + text', () => {
    const out = renderMsg(NoticeView, { kind: 'notice', id: 0, level: 'warn', text: 'cancelled' });
    expect(out).toContain('!');
    expect(out).toContain('cancelled');
  });
});
