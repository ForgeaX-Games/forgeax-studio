/**
 * StructuredOutput 工具(010,subagent-only)测试。
 *
 * 两层:
 *   ① 工具单元:最小 JSON Schema 校验器 + tool.call/mapResult 形状
 *      (非法对象→valid:false+逐条错误+isError;合法对象→valid:true+payload+onValid 回调)。
 *   ② subagent 集成:给子 agent 一个 schema,子用 StructuredOutput 提交——
 *      非法→校验失败+重试提示;合法→成为该子 agent 的结构化返回值(SubagentResult.structured)。
 *
 * 用内存 stub provider 跑子 loop,不打真 IO / 不调真模型。
 */
import { test, expect, describe } from 'bun:test';
import {
  makeStructuredOutputTool,
  validateAgainstSchema,
} from '../src/capability/builtin-tools/structured-output';
import { runSubagent } from '../src/agent/subagent';
import type { ToolContext, JSONSchema } from '../src/capability/types';
import { CoreEventType } from '../src/events/events';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── helpers(对齐 subagent.test.ts)──────────────────────────────────────────

function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}
function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}
function scripted(turns: ProviderStreamEvent[][]): LLMProvider {
  let n = 0;
  return {
    api: 'stub',
    async *stream() {
      const t = turns[Math.min(n, turns.length - 1)];
      n++;
      for (const e of t) yield e;
    },
  };
}

function ctx(): ToolContext {
  return { signal: new AbortController().signal };
}

// 目标 schema:{ answer: number(required), label: 'a'|'b'(enum,可选) },禁额外键。
const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    answer: { type: 'number' },
    label: { type: 'string', enum: ['a', 'b'] },
  },
  required: ['answer'],
  additionalProperties: false,
};

// ─── ① 最小 JSON Schema 校验器 ───────────────────────────────────────────────

describe('validateAgainstSchema — 最小自写校验器', () => {
  test('合法对象 → 无错误', () => {
    expect(validateAgainstSchema({ answer: 42 }, SCHEMA)).toEqual([]);
    expect(validateAgainstSchema({ answer: 1, label: 'a' }, SCHEMA)).toEqual([]);
  });

  test('缺 required → 报错', () => {
    const errs = validateAgainstSchema({ label: 'a' }, SCHEMA);
    expect(errs.some((e) => /answer.*required/.test(e))).toBe(true);
  });

  test('类型不符 → 报错', () => {
    const errs = validateAgainstSchema({ answer: 'not-a-number' }, SCHEMA);
    expect(errs.some((e) => /answer.*expected type number/.test(e))).toBe(true);
  });

  test('enum 不命中 → 报错', () => {
    const errs = validateAgainstSchema({ answer: 1, label: 'z' }, SCHEMA);
    expect(errs.some((e) => /label.*enum/.test(e))).toBe(true);
  });

  test('additionalProperties:false → 拒未声明键', () => {
    const errs = validateAgainstSchema({ answer: 1, extra: true }, SCHEMA);
    expect(errs.some((e) => /extra.*additional property/.test(e))).toBe(true);
  });

  test('integer 类型容纳整数、拒小数', () => {
    const intSchema: JSONSchema = { type: 'object', properties: { n: { type: 'integer' } } };
    expect(validateAgainstSchema({ n: 3 }, intSchema)).toEqual([]);
    expect(validateAgainstSchema({ n: 3.5 }, intSchema).length).toBeGreaterThan(0);
  });

  test('array items 递归校验每个元素', () => {
    const arrSchema: JSONSchema = { type: 'array', items: { type: 'number' } };
    expect(validateAgainstSchema([1, 2, 3], arrSchema)).toEqual([]);
    expect(validateAgainstSchema([1, 'x', 3], arrSchema).length).toBeGreaterThan(0);
  });
});

// ─── ① 工具行为 ──────────────────────────────────────────────────────────────

describe('makeStructuredOutputTool — 工具单元', () => {
  test('subagent-only 标识:read-only,有 inputJSONSchema(= 预置 schema)', () => {
    const t = makeStructuredOutputTool({ schema: SCHEMA });
    expect(t.name).toBe('StructuredOutput');
    expect(t.isReadOnly({})).toBe(true);
    expect(t.inputJSONSchema).toBe(SCHEMA);
  });

  test('非法对象 → valid:false + errors;onValid 不触发;mapResult isError 带重试提示', async () => {
    let captured: unknown = 'untouched';
    const t = makeStructuredOutputTool({ schema: SCHEMA, onValid: (p) => (captured = p) });
    const { data } = await t.call({ label: 'a' }, ctx()); // 缺 required answer
    expect(data.valid).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
    expect(captured).toBe('untouched'); // onValid 未触发

    const ev = t.mapResult(data, 'tu_1');
    expect(ev.type).toBe(CoreEventType.ToolCallResult);
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.isError).toBe(true);
    expect(String(payload.result)).toMatch(/StructuredOutput again/);
  });

  test('合法对象 → valid:true + payload;onValid 触发;mapResult 非 error', async () => {
    let captured: unknown;
    const t = makeStructuredOutputTool({ schema: SCHEMA, onValid: (p) => (captured = p) });
    const { data } = await t.call({ answer: 7, label: 'b' }, ctx());
    expect(data.valid).toBe(true);
    expect(data.payload).toEqual({ answer: 7, label: 'b' });
    expect(captured).toEqual({ answer: 7, label: 'b' }); // onValid 记录了

    const ev = t.mapResult(data, 'tu_2');
    expect((ev.payload as Record<string, unknown>).isError).toBe(false);
  });
});

// ─── ② subagent 集成 ─────────────────────────────────────────────────────────

describe('runSubagent + schema — 强制结构化返回', () => {
  test('子提交非法对象→校验失败重试→提交合法对象→成为 structured 返回值', async () => {
    // 轮1:子提交非法对象(缺 answer)→ 工具回灌错误;
    // 轮2:子据错误重试,提交合法对象 → 记为结构化返回值;
    // 轮3:子收尾文本。
    const provider = scripted([
      [asstToolUse('s1', 'StructuredOutput', { label: 'a' })],
      [asstToolUse('s2', 'StructuredOutput', { answer: 99, label: 'b' })],
      [asstText('done')],
    ]);
    const r = await runSubagent(
      { input: 'compute then return structured', model: 'm', tools: [], schema: SCHEMA },
      { provider },
    );
    expect(r.terminalReason).toBe('completed');
    // 最后一次合法 payload 绑定为子的结构化返回值。
    expect(r.structured).toEqual({ answer: 99, label: 'b' });
    expect(r.toolCalls).toBe(2); // 两次 StructuredOutput 调用(一次非法、一次合法)
  });

  test('子从未提交合法对象 → structured 为 undefined(零回归)', async () => {
    // 子只提交非法对象一次后收尾;无合法 payload。
    const provider = scripted([
      [asstToolUse('s1', 'StructuredOutput', { answer: 'bad' })],
      [asstText('giving up')],
    ]);
    const r = await runSubagent(
      { input: 'x', model: 'm', tools: [], schema: SCHEMA },
      { provider },
    );
    expect(r.structured).toBeUndefined();
  });

  test('未给 schema → 不挂 StructuredOutput,structured 恒 undefined(零回归)', async () => {
    const provider = scripted([[asstText('plain text answer')]]);
    const r = await runSubagent({ input: 'x', model: 'm', tools: [] }, { provider });
    expect(r.text).toBe('plain text answer');
    expect(r.structured).toBeUndefined();
  });
});
