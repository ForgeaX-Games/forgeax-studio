/**
 * JSON-schema validation walker (C7 extra) — 工具输入的 provider-neutral schema 校验。
 *
 * 工具输入校验的「validation」错误类:
 * 当工具声明 JSON Schema(`AgentTool.inputJSONSchema`)而无 zod parser 时,dispatch
 * 在执行前用本 walker 把模型给的 `input` 对着 schema 走一遍。命中失配 → integrator
 * 归类为 'validation' errorCategory + 把 `path`(JSON Path)塞进 validationPath,
 * 让诊断能定位到「哪个字段错了」,而不进 LLM-visible 文案(工程只分类,模型自决)。
 *
 * 上游工具用 zod,schema parse 失败即 validation 错;本 walker 是
 * 对「只有 JSON Schema 没有 zod」(MCP / 外部声明式工具)的等价兜底。
 *
 * fail-OPEN(permissive)取舍 —— 见 03.E.2「不做严格 draft-07 全集」:
 *   - 缺失 / 空 schema → ok:true(不凭空造 false positive,宁可放过也不误杀)。
 *   - 只覆盖被工具实际用到的子集:type / required / properties(递归)/ enum /
 *     pattern / oneOf / anyOf;未识别的关键字一律忽略(不当作错误)。
 *   - `value === undefined` 仅由父层 required 判定;walker 内不把 undefined 当类型错。
 *
 * 纯函数,无副作用、无 IO、无 import —— 便于单测,Boundary 自然满足。
 */

/** 校验结果:成功只回 ok;失败回首个失配的 JSON Path + 人读 message。 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; path: string; message: string };

/** JSON Schema 支持的基础类型(子集)。 */
type JsonSchemaType = 'string' | 'number' | 'boolean' | 'integer' | 'object' | 'array';

const OK: ValidationResult = { ok: true };

function fail(path: string, message: string): ValidationResult {
  return { ok: false, path, message };
}

/** 判断 schema 是否「空/无意义」—— 非对象、或没有任何被支持的约束关键字。空 → permissive 放过。 */
function isEmptySchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return true;
  const s = schema as Record<string, unknown>;
  return (
    s.type === undefined &&
    s.required === undefined &&
    s.properties === undefined &&
    s.enum === undefined &&
    s.pattern === undefined &&
    s.oneOf === undefined &&
    s.anyOf === undefined
  );
}

/** JSON 实际类型 → schema 类型名(integer 单独识别:number 的子集)。 */
function actualType(value: unknown): JsonSchemaType | 'null' | 'undefined' {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  // function / symbol / bigint 等 —— 当作不匹配任何 JSON 类型。
  return 'object';
}

/** 给定 expected schema 类型,value 是否满足(integer 收紧;number 容纳 integer)。 */
function typeMatches(expected: JsonSchemaType, value: unknown): boolean {
  const a = actualType(value);
  switch (expected) {
    case 'integer':
      return a === 'integer';
    case 'number':
      // integer 是 number 的子集,二者皆 OK。
      return a === 'number' || a === 'integer';
    case 'string':
      return a === 'string';
    case 'boolean':
      return a === 'boolean';
    case 'array':
      return a === 'array';
    case 'object':
      return a === 'object';
    default:
      return true;
  }
}

/** 拼子路径:对象属性用 `.key`,数组下标用 `[i]`(对齐 `$.a.b[0]` 形态)。 */
function childPath(base: string, key: string): string {
  return `${base}.${key}`;
}
function indexPath(base: string, i: number): string {
  return `${base}[${i}]`;
}

/**
 * 递归校验 `value` 是否符合 `schema`,`path` 为当前节点的 JSON Path(根传 `$`)。
 * permissive:空 schema、未识别关键字一律放过;只在明确约束被违反时 fail。
 */
function walk(value: unknown, schema: Record<string, unknown>, path: string): ValidationResult {
  // type
  if (typeof schema.type === 'string') {
    const expected = schema.type as JsonSchemaType;
    if (!typeMatches(expected, value)) {
      return fail(path, `expected type ${expected}, got ${actualType(value)}`);
    }
  }

  // enum:value 必须恰为枚举之一(用稳定 JSON 等值,容纳对象/数组成员)。
  if (Array.isArray(schema.enum)) {
    const ok = (schema.enum as unknown[]).some((e) => deepEqual(e, value));
    if (!ok) {
      return fail(path, `value not in enum [${(schema.enum as unknown[]).map((e) => JSON.stringify(e)).join(', ')}]`);
    }
  }

  // pattern:仅对 string 生效(对齐 JSON Schema:pattern 只约束 string,其余类型忽略)。
  if (typeof schema.pattern === 'string' && typeof value === 'string') {
    let re: RegExp;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      // 非法 pattern → permissive 放过(不因 schema 自身坏掉而误杀输入)。
      re = /[\s\S]*/;
    }
    if (!re.test(value)) {
      return fail(path, `value does not match pattern /${schema.pattern}/`);
    }
  }

  // object:required + properties 递归。
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as unknown[]) {
        if (typeof key !== 'string') continue;
        if (!(key in obj) || obj[key] === undefined) {
          return fail(childPath(path, key), `missing required property "${key}"`);
        }
      }
    }

    if (schema.properties && typeof schema.properties === 'object') {
      const props = schema.properties as Record<string, unknown>;
      for (const key of Object.keys(props)) {
        const childSchema = props[key];
        if (!childSchema || typeof childSchema !== 'object') continue;
        // 缺省属性(非 required)不递归校验 —— required 已在上面单独判。
        if (!(key in obj) || obj[key] === undefined) continue;
        const r = walk(obj[key], childSchema as Record<string, unknown>, childPath(path, key));
        if (!r.ok) return r;
      }
    }
  }

  // array:items 递归(支持单一 items schema;tuple 形式的 items 数组也按位递归)。
  if (Array.isArray(value) && schema.items) {
    if (Array.isArray(schema.items)) {
      const itemSchemas = schema.items as unknown[];
      for (let i = 0; i < value.length; i++) {
        const itemSchema = itemSchemas[i];
        if (!itemSchema || typeof itemSchema !== 'object') continue;
        const r = walk(value[i], itemSchema as Record<string, unknown>, indexPath(path, i));
        if (!r.ok) return r;
      }
    } else if (typeof schema.items === 'object') {
      const itemSchema = schema.items as Record<string, unknown>;
      for (let i = 0; i < value.length; i++) {
        const r = walk(value[i], itemSchema, indexPath(path, i));
        if (!r.ok) return r;
      }
    }
  }

  // oneOf:必须恰好满足 1 个分支。
  if (Array.isArray(schema.oneOf)) {
    const branches = (schema.oneOf as unknown[]).filter((b) => b && typeof b === 'object') as Record<string, unknown>[];
    if (branches.length > 0) {
      let matched = 0;
      for (const b of branches) {
        if (walk(value, b, path).ok) matched++;
      }
      if (matched !== 1) {
        return fail(path, `value must match exactly one schema in oneOf (matched ${matched})`);
      }
    }
  }

  // anyOf:至少满足 1 个分支。
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as unknown[]).filter((b) => b && typeof b === 'object') as Record<string, unknown>[];
    if (branches.length > 0) {
      const ok = branches.some((b) => walk(value, b, path).ok);
      if (!ok) {
        return fail(path, `value does not match any schema in anyOf`);
      }
    }
  }

  return OK;
}

/** 结构化等值(用于 enum 成员比较):标量 === ,对象/数组按稳定 JSON 比。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

/** 稳定 JSON(键排序)—— 与 agent.ts 同款,用作结构等值的归一化。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * 对 `value` 跑 `schema` 校验(根路径 `$`)。空/无约束 schema → ok:true(permissive)。
 * 失配回首个错误的 JSON Path(如 `$.a.b[0]`)+ 人读 message,供 integrator 归类
 * 'validation' errorCategory 并填 validationPath。
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): ValidationResult {
  if (isEmptySchema(schema)) return OK;
  return walk(value, schema, '$');
}
