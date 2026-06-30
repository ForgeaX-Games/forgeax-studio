/**
 * TOOLS tests — AskUserQuestion (008, ask-tools ②).
 *
 * 用一个 stub askQuestion host 测:
 *   - 工具注册进 builtinToolsPack;谓词 / schema 形状;
 *   - agent 调 AskUserQuestion → host 收到**结构化 questions** → answers 正确回灌进
 *     工具结果(经 dispatchTools 全链路);
 *   - multiSelect / Other 自填路径;
 *   - 无 host 实现时优雅降级(unsupported,不断流)。
 *
 * 不打真 IO;host 全用内存 stub(对齐 test/builtin-tools.test.ts 风格)。
 */
import { test, expect, describe } from 'bun:test';
import type { ToolContext } from '../src/capability/types';
import type { AskQuestionFn, AskQuestionItem, AskQuestionAnswer } from '../src/inject/types';
import { CoreEventType } from '../src/events/events';
import { builtinToolsPack, askUserQuestionTool, type AskUserQuestionInput } from '../src/capability/builtin-tools/index';
import { dispatchTools } from '../src/agent/dispatch';

// ─── ctx helper ──────────────────────────────────────────────────────────────

function ctxWith(extra: Record<string, unknown>, signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, ...extra };
}

/** 记录被问到的 questions,并按 responder 决定回答。 */
function stubAskQuestion(responder: (q: AskQuestionItem[]) => AskQuestionAnswer[]): {
  fn: AskQuestionFn;
  seen: AskQuestionItem[][];
} {
  const seen: AskQuestionItem[][] = [];
  const fn: AskQuestionFn = async (questions) => {
    seen.push(questions);
    return responder(questions);
  };
  return { fn, seen };
}

// ─── pack 注册 ────────────────────────────────────────────────────────────────

describe('AskUserQuestion registration', () => {
  test('is registered in builtinToolsPack with sane shape', () => {
    const pack = builtinToolsPack();
    const names = (pack.tools ?? []).map((t) => t.name);
    expect(names).toContain('AskUserQuestion');
    const t = askUserQuestionTool();
    expect(t.aliases).toContain('ask_user_question');
    expect(t.isEnabled()).toBe(true);
    expect(t.inputJSONSchema).toBeDefined();
    // 交互式索取输入 → 非只读 / 非并发安全(fail-closed)。
    expect(t.isReadOnly({ questions: [] })).toBe(false);
    expect(t.isConcurrencySafe({ questions: [] })).toBe(false);
  });
});

// ─── host 直连(tool.call) ─────────────────────────────────────────────────────

describe('AskUserQuestion call', () => {
  test('forwards structured questions to host and reflows answers', async () => {
    const { fn, seen } = stubAskQuestion((qs) => qs.map((q) => ({ selected: [q.options[0].label] })));
    const t = askUserQuestionTool();
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: 'Which renderer?',
          header: 'Renderer',
          options: [
            { label: 'WebGL', description: 'broad support' },
            { label: 'WebGPU', description: 'modern' },
          ],
        },
      ],
    };
    const { data } = await t.call(input, ctxWith({ askQuestion: fn }));
    // host 收到的是结构化 questions(含 header/options),非裸字符串。
    expect(seen).toHaveLength(1);
    expect(seen[0][0].question).toBe('Which renderer?');
    expect(seen[0][0].header).toBe('Renderer');
    expect(seen[0][0].options.map((o) => o.label)).toEqual(['WebGL', 'WebGPU']);
    // 回灌:answers 与 questions 同序,选中 label 落回。
    expect(data.answers).toHaveLength(1);
    expect(data.answers[0].selected).toEqual(['WebGL']);
    expect(data.unsupported).toBeUndefined();
  });

  test('multiSelect path: multiple labels reflow', async () => {
    const { fn } = stubAskQuestion((qs) => qs.map((q) => ({ selected: q.options.map((o) => o.label) })));
    const t = askUserQuestionTool();
    const { data } = await t.call(
      {
        questions: [
          {
            question: 'Which features?',
            header: 'Features',
            options: [{ label: 'audio' }, { label: 'physics' }, { label: 'networking' }],
            multiSelect: true,
          },
        ],
      },
      ctxWith({ askQuestion: fn }),
    );
    expect(data.answers[0].selected).toEqual(['audio', 'physics', 'networking']);
  });

  test('coerces bare-string options to {label} (model often emits ["A","B"])', async () => {
    const { fn, seen } = stubAskQuestion((qs) => qs.map((q) => ({ selected: [q.options[0].label] })));
    const t = askUserQuestionTool();
    const { data } = await t.call(
      {
        // 模型常把选项写成裸字符串数组,而非 [{label}]。
        questions: [{ question: 'Pick one', header: 'Pick', options: ['light', 'dark'] }],
      } as unknown as AskUserQuestionInput,
      ctxWith({ askQuestion: fn }),
    );
    // 归一化:host 收到的是 {label} 对象。
    expect(seen[0][0].options).toEqual([{ label: 'light' }, { label: 'dark' }]);
    expect(data.answers[0].selected).toEqual(['light']);
  });

  test('Other path: free-text answer surfaces in selected + other', async () => {
    const { fn } = stubAskQuestion(() => [{ selected: ['Godot'], other: 'Godot' }]);
    const t = askUserQuestionTool();
    const { data } = await t.call(
      {
        questions: [
          { question: 'Engine?', header: 'Engine', options: [{ label: 'Unity' }, { label: 'Unreal' }] },
        ],
      },
      ctxWith({ askQuestion: fn }),
    );
    expect(data.answers[0].selected).toEqual(['Godot']);
    expect(data.answers[0].other).toBe('Godot');
  });

  test('multiSelect flag is forwarded to host', async () => {
    const { fn, seen } = stubAskQuestion((qs) => qs.map(() => ({ selected: [] })));
    const t = askUserQuestionTool();
    await t.call(
      {
        questions: [
          { question: 'a?', header: 'A', options: [{ label: 'x' }], multiSelect: true },
          { question: 'b?', header: 'B', options: [{ label: 'y' }] },
        ],
      },
      ctxWith({ askQuestion: fn }),
    );
    expect(seen[0][0].multiSelect).toBe(true);
    expect(seen[0][1].multiSelect).toBeUndefined();
  });

  test('graceful degradation when host has not wired askQuestion', async () => {
    const t = askUserQuestionTool();
    const { data } = await t.call(
      { questions: [{ question: 'q?', header: 'H', options: [{ label: 'a' }] }] },
      ctxWith({}), // 无 askQuestion 注入
    );
    expect(data.unsupported).toBe(true);
    expect(data.answers).toEqual([]);
    expect(data.message).toMatch(/not wired by the host/);
  });

  test('invalid input throws (caught by dispatch as validation)', async () => {
    const { fn } = stubAskQuestion(() => []);
    const t = askUserQuestionTool();
    await expect(t.call({ questions: [] } as AskUserQuestionInput, ctxWith({ askQuestion: fn }))).rejects.toThrow(
      /at least one question/,
    );
    await expect(
      t.call(
        { questions: [{ question: 'q', header: '', options: [{ label: 'a' }] }] } as AskUserQuestionInput,
        ctxWith({ askQuestion: fn }),
      ),
    ).rejects.toThrow(/header must be a non-empty string/);
    await expect(
      t.call(
        { questions: [{ question: 'q', header: 'H', options: [] }] } as AskUserQuestionInput,
        ctxWith({ askQuestion: fn }),
      ),
    ).rejects.toThrow(/options must be a non-empty array/);
  });
});

// ─── mapResult ────────────────────────────────────────────────────────────────

describe('AskUserQuestion mapResult', () => {
  test('non-error result carries answers', () => {
    const t = askUserQuestionTool();
    const ev = t.mapResult({ answers: [{ question: 'q', header: 'H', selected: ['a'] }] }, 'tu_1');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    const p = ev.payload as Record<string, unknown>;
    expect(p.toolUseId).toBe('tu_1');
    expect(p.isError).toBe(false);
    expect(p.answers).toEqual([{ question: 'q', header: 'H', selected: ['a'] }]);
  });

  test('unsupported degradation maps to isError result', () => {
    const t = askUserQuestionTool();
    const ev = t.mapResult({ answers: [], unsupported: true, message: 'need host' }, 'tu_2');
    const p = ev.payload as Record<string, unknown>;
    expect(p.isError).toBe(true);
    expect(p.unsupported).toBe(true);
    expect(p.message).toBe('need host');
  });
});

// ─── 全链路:经 dispatchTools(agent 派发路径) ──────────────────────────────────

describe('AskUserQuestion via dispatchTools', () => {
  test('agent dispatch → host receives structured questions → answers reflow into tool.result', async () => {
    const { fn, seen } = stubAskQuestion((qs) => qs.map((q) => ({ selected: [q.options[1].label] })));
    const tool = askUserQuestionTool();
    const results = await dispatchTools(
      [
        {
          id: 'tu_dispatch',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Pick a theme',
                header: 'Theme',
                options: [{ label: 'light' }, { label: 'dark' }],
              },
            ],
          },
        },
      ],
      {
        tools: [tool],
        toolContext: { askQuestion: fn },
        signal: new AbortController().signal,
        // trusted 绕过权限把闸,聚焦提问回灌链路。
        trusted: true,
      },
    );
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.isError).toBe(false);
    // host 经 dispatch 真收到结构化 questions。
    expect(seen[0][0].header).toBe('Theme');
    // answers 回灌进 tool.result payload。
    const payload = r.result.payload as Record<string, unknown>;
    const answers = payload.answers as Array<{ selected: string[] }>;
    expect(answers[0].selected).toEqual(['dark']);
  });

  test('missing question is repaired from header (regression: model collapses question into header)', async () => {
    // 复现用户报错:`input validation failed at $.questions[0].question: missing required property "question"`。
    // 模型偶尔只给 header、漏 question;dispatch 必须软兜(question=header)而非硬失败。
    const { fn, seen } = stubAskQuestion((qs) => qs.map((q) => ({ selected: [q.options[0].label] })));
    const tool = askUserQuestionTool();
    const results = await dispatchTools(
      [
        {
          id: 'tu_no_question',
          name: 'AskUserQuestion',
          // 注意:无 question 字段。
          input: { questions: [{ header: 'Which renderer?', options: ['WebGL', 'WebGPU'] }] },
        },
      ],
      { tools: [tool], toolContext: { askQuestion: fn }, signal: new AbortController().signal, trusted: true },
    );
    const r = results[0];
    expect(r.isError).toBe(false); // 不再是 validation 错
    expect(r.errorCategory).toBeUndefined();
    // header 兜进 question,host 拿到可用的结构化问题。
    expect(seen[0][0].question).toBe('Which renderer?');
    expect(seen[0][0].header).toBe('Which renderer?');
    const payload = r.result.payload as Record<string, unknown>;
    expect((payload.answers as Array<{ selected: string[] }>)[0].selected).toEqual(['WebGL']);
  });

  test('missing header is repaired from question (symmetric collapse)', async () => {
    const { fn, seen } = stubAskQuestion((qs) => qs.map((q) => ({ selected: [q.options[0].label] })));
    const tool = askUserQuestionTool();
    const results = await dispatchTools(
      [
        {
          id: 'tu_no_header',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Pick a color theme for the UI', options: ['light', 'dark'] }] },
        },
      ],
      { tools: [tool], toolContext: { askQuestion: fn }, signal: new AbortController().signal, trusted: true },
    );
    const r = results[0];
    expect(r.isError).toBe(false);
    expect(seen[0][0].question).toBe('Pick a color theme for the UI');
    // header 由 question 截断兜底(短标签语义,≤24 字)。
    expect(seen[0][0].header).toBe('Pick a color theme for t');
  });

  test('bare-string options pass dispatch schema validation (regression: anyOf string|object)', async () => {
    // 复现并钉死用户报错:`options[0]: expected type object, got string`。
    // dispatch 的 validateAgainstSchema 必须放行裸字符串选项(anyOf),不再误判 validation。
    const { fn } = stubAskQuestion((qs) => qs.map((q) => ({ selected: [q.options[0].label] })));
    const tool = askUserQuestionTool();
    const results = await dispatchTools(
      [
        {
          id: 'tu_str_opts',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Pick', header: 'Pick', options: ['light', 'dark'] }] },
        },
      ],
      { tools: [tool], toolContext: { askQuestion: fn }, signal: new AbortController().signal, trusted: true },
    );
    const r = results[0];
    expect(r.isError).toBe(false); // 不再是 validation 错
    expect(r.errorCategory).toBeUndefined();
    const payload = r.result.payload as Record<string, unknown>;
    expect((payload.answers as Array<{ selected: string[] }>)[0].selected).toEqual(['light']);
  });
});
