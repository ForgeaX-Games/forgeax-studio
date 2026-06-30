/**
 * components/ 纯叶子 smoke renders(ink-testing-library 可用 → 真渲染)。
 *
 * 只覆盖 P7 后保留的纯叶子组件(Markdown/Diff/Select/Code)。原本一并验的
 * 工具/消息卡 helper 与渲染(summarize/statusColor/resultSummary/thinkingText/
 * DefaultTool/UserMessage)已随 views/ 重写,覆盖搬到 views.test.ts(DefaultView/
 * UserView/ThinkingView + 各 view 关键字段);此处不再重复。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Markdown } from '../../src/tui/components/Markdown';
import { Diff } from '../../src/tui/components/Diff';
import { Select } from '../../src/tui/components/Select';
import { Code } from '../../src/tui/components/Code';

describe('component smoke renders (ink-testing-library)', () => {
  test('Markdown renders plain text without throwing', () => {
    const { lastFrame } = render(<Markdown>{'# Title\n\n- item one\n- item two'}</Markdown>);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Title');
    expect(frame).toContain('item one');
  });

  test('Diff renders line-level +/- markers (context kept, changes signed)', () => {
    // diffLines → context '  '、removed '- '、added '+ '。
    const { lastFrame } = render(<Diff oldText={'a\nb\n'} newText={'a\nc\n'} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('  a'); // 未变行保留双空格前缀
    expect(frame).toContain('- b'); // 删除行
    expect(frame).toContain('+ c'); // 新增行
  });

  test('Diff wordLevel renders both old and new word fragments inline', () => {
    const { lastFrame } = render(<Diff oldText="hello world" newText="hello there" wordLevel />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
    expect(frame).toContain('world');
    expect(frame).toContain('there');
  });

  test('Select renders all items inactive (no keyboard, first not highlighted-active)', () => {
    const items = [
      { label: 'Alpha', value: 'a' },
      { label: 'Beta', value: 'b' },
    ];
    const { lastFrame } = render(<Select items={items} onSelect={() => {}} isActive={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Alpha');
    expect(frame).toContain('Beta');
  });

  test('Select filter narrows the visible items (substring, case-insensitive)', () => {
    const items = [
      { label: 'Apple', value: 'apple' },
      { label: 'Banana', value: 'banana' },
    ];
    const { lastFrame } = render(
      <Select items={items} onSelect={() => {}} isActive={false} filter="ban" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Banana');
    expect(frame).not.toContain('Apple');
  });

  test('Code renders the source text (highlight degrades gracefully)', () => {
    const { lastFrame } = render(<Code code={'const x = 1;'} lang="javascript" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('const');
    expect(frame).toContain('x');
  });
});
