/**
 * Builtin StructuredOutput tool (subagent-only) —— 强制子 agent 以**校验过的 JSON**
 * 返回结果,而非自由文本再二次解析。
 *
 * 用法(由 subagent runner 预置):调用方给一个目标 JSON Schema 与一个 `onValid`
 * 回调。模型用 `StructuredOutput({...})` 提交一个对象;`call` 时用**最小自写**的
 * JSON Schema 校验器(包内无 ajv / zod,禁止加重依赖)校验:
 *   - 不符 → 把逐条校验错误回灌进结果(isError),让模型据此**重试**;
 *   - 符合 → 经 `onValid(payload)` 记为该子 agent 的结构化返回值。
 *
 * 该工具**不进** `builtinToolsPack()`(不该出现在主 agent 通用工具集),仅在
 * subagent runner 给了 schema 时拼进子 agent 工具集(见 `makeTaskTool` / `runSubagent`)。
 *
 * Boundary: 仅 import core-local 契约。
 */
import type { CoreEvent } from '../../events/types';
import { CoreEventType } from '../../events/events';
import { buildTool, type AgentTool, type JSONSchema } from '../types';

/** StructuredOutput 入参 = 任意对象(目标形状由调用方预置的 schema 约束)。 */
export interface StructuredOutputInput {
  [key: string]: unknown;
}

export interface StructuredOutputOutput {
  /** 本次提交是否通过 schema 校验。 */
  valid: boolean;
  /** 校验通过时:回写的结构化对象;否则 undefined。 */
  payload?: unknown;
  /** 校验失败时:逐条错误(供模型重试);否则空。 */
  errors: string[];
}

export interface StructuredOutputToolDeps {
  /** 目标 JSON Schema(由 subagent runner 预置)。 */
  schema: JSONSchema;
  /** 校验通过时回调,把合法 payload 绑定为该子 agent 的结构化返回值。 */
  onValid?: (payload: unknown) => void;
}

// ─── 最小 JSON Schema 校验器(无 ajv,够用即止)───────────────────────────────

/** JS typeof → JSON Schema 类型名(数组与 null 单独判)。 */
function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'object' | 'string' | 'number' | 'boolean' | 'undefined' | ...
}

/** 单个值是否匹配 schema 声明的 type(支持单 type 或 type 数组;number 容纳 integer)。 */
function matchesType(value: unknown, type: unknown): boolean {
  const actual = jsonTypeOf(value);
  const accept = (t: unknown): boolean => {
    if (t === 'integer') return actual === 'number' && Number.isInteger(value as number);
    if (t === 'number') return actual === 'number';
    return t === actual;
  };
  if (Array.isArray(type)) return type.some(accept);
  return accept(type);
}

/**
 * 递归校验 `value` 是否符合 `schema`,把人类可读的错误推进 `errors`(带 JSON 路径)。
 * 仅覆盖 LLM 结构化返回常用关键字:type / required / properties / items /
 * enum / additionalProperties(为 false 时拒未声明键)。其余关键字宽松放行。
 */
function validate(value: unknown, schema: JSONSchema, path: string, errors: string[]): void {
  // type
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const want = Array.isArray(schema.type) ? schema.type.join('|') : String(schema.type);
    errors.push(`${path || '<root>'}: expected type ${want}, got ${jsonTypeOf(value)}`);
    return; // 类型都不对,后续约束无意义
  }

  // enum
  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => e === value);
    if (!ok) {
      errors.push(`${path || '<root>'}: value not in enum ${JSON.stringify(schema.enum)}`);
    }
  }

  // object: required / properties / additionalProperties
  if (jsonTypeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, JSONSchema> | undefined) ?? undefined;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) errors.push(`${path ? path + '.' : ''}${key}: required property missing`);
      }
    }
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) validate(obj[key], sub, `${path ? path + '.' : ''}${key}`, errors);
      }
    }
    if (schema.additionalProperties === false && props) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path ? path + '.' : ''}${key}: additional property not allowed`);
      }
    }
  }

  // array: items(单一 schema 应用到每个元素)
  if (jsonTypeOf(value) === 'array' && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    const arr = value as unknown[];
    arr.forEach((el, i) => validate(el, schema.items as JSONSchema, `${path}[${i}]`, errors));
  }
}

/** 公开:对 value 跑最小 schema 校验,返回错误列表(空 = 通过)。供测试 & 工具复用。 */
export function validateAgainstSchema(value: unknown, schema: JSONSchema): string[] {
  const errors: string[] = [];
  validate(value, schema, '', errors);
  return errors;
}

// ─── 工具工厂 ────────────────────────────────────────────────────────────────

/**
 * 构造一个 StructuredOutput 工具,绑定预置 schema + onValid 回调。
 *
 * 校验失败时 `call` 仍正常返回(data.valid=false + errors),由 `mapResult` 标成
 * isError 把错误回灌给模型重试;不抛异常(抛会被 buildTool 兜成 tool error,
 * 但形状不带逐条错误,信息更弱)。校验通过时经 onValid 记录,父侧据此取最终值。
 */
export function makeStructuredOutputTool(
  deps: StructuredOutputToolDeps,
): AgentTool<StructuredOutputInput, StructuredOutputOutput> {
  return buildTool<StructuredOutputInput, StructuredOutputOutput>({
    name: 'StructuredOutput',
    aliases: ['structured_output'],
    searchHint: 'return a validated structured JSON result conforming to the required schema',
    // 子 agent 最终返回值的提交口;声明只读(无外部副作用,只回写内存)。
    inputJSONSchema: deps.schema,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    maxResultSizeChars: 8_000,
    async call(input): Promise<{ data: StructuredOutputOutput }> {
      const errors = validateAgainstSchema(input, deps.schema);
      if (errors.length > 0) {
        return { data: { valid: false, errors } };
      }
      deps.onValid?.(input);
      return { data: { valid: true, payload: input, errors: [] } };
    },
    // 校验失败 → isError,result 列出逐条错误让模型重试;成功 → 确认已记录。
    mapResult: (o, id): CoreEvent => ({
      type: CoreEventType.ToolCallResult,
      payload: {
        toolUseId: id,
        isError: !o.valid,
        result: o.valid
          ? 'Structured output accepted and recorded as the final result.'
          : `Structured output rejected — fix and call StructuredOutput again:\n- ${o.errors.join('\n- ')}`,
        valid: o.valid,
      },
      ts: Date.now(),
    }),
  });
}
