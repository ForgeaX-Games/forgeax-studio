/**
 * WS3 单测:JSON-schema validation walker(03.E.2)+ same-file read tracker。
 * 覆盖 type/required/properties 递归(JSON Path)/enum/pattern/oneOf/anyOf + permissive 兜底。
 */
import { test, expect, describe } from 'bun:test';
import { validateAgainstSchema } from '../src/capability/validate';
import { ReadTracker, DEFAULT_SAME_FILE_READ_LIMIT } from '../src/capability/read-tracker';

describe('validateAgainstSchema — permissive 兜底', () => {
  test('空/缺失 schema → ok(无 false positive)', () => {
    expect(validateAgainstSchema({ anything: 1 }, {})).toEqual({ ok: true });
    expect(validateAgainstSchema(undefined, {} as Record<string, unknown>)).toEqual({ ok: true });
    expect(validateAgainstSchema('x', { description: 'no constraints' })).toEqual({ ok: true });
  });

  test('未识别关键字一律忽略', () => {
    expect(validateAgainstSchema(5, { minimum: 10 } as Record<string, unknown>)).toEqual({ ok: true });
  });
});

describe('validateAgainstSchema — type', () => {
  test('基础类型匹配', () => {
    expect(validateAgainstSchema('hi', { type: 'string' }).ok).toBe(true);
    expect(validateAgainstSchema(3.5, { type: 'number' }).ok).toBe(true);
    expect(validateAgainstSchema(true, { type: 'boolean' }).ok).toBe(true);
    expect(validateAgainstSchema([], { type: 'array' }).ok).toBe(true);
    expect(validateAgainstSchema({}, { type: 'object' }).ok).toBe(true);
  });

  test('integer 收紧 / number 容纳 integer', () => {
    expect(validateAgainstSchema(3, { type: 'integer' }).ok).toBe(true);
    expect(validateAgainstSchema(3.5, { type: 'integer' }).ok).toBe(false);
    expect(validateAgainstSchema(3, { type: 'number' }).ok).toBe(true);
  });

  test('类型失配 → path=$ + message', () => {
    const r = validateAgainstSchema(123, { type: 'string' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.path).toBe('$');
      expect(r.message).toContain('string');
    }
  });
});

describe('validateAgainstSchema — required + properties 递归(JSON Path)', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    properties: {
      a: {
        type: 'object',
        required: ['b'],
        properties: {
          b: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  };

  test('合法嵌套 → ok', () => {
    expect(validateAgainstSchema({ a: { b: [1, 2, 3] } }, schema)).toEqual({ ok: true });
  });

  test('缺顶层 required → $.a', () => {
    const r = validateAgainstSchema({}, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe('$.a');
  });

  test('缺嵌套 required → $.a.b', () => {
    const r = validateAgainstSchema({ a: {} }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe('$.a.b');
  });

  test('数组元素类型错 → $.a.b[1]', () => {
    const r = validateAgainstSchema({ a: { b: [1, 'x', 3] } }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe('$.a.b[1]');
  });

  test('非 required 的缺省属性不递归', () => {
    const s = { type: 'object', properties: { opt: { type: 'string' } } };
    expect(validateAgainstSchema({}, s)).toEqual({ ok: true });
  });
});

describe('validateAgainstSchema — enum / pattern', () => {
  test('enum 命中 / 未命中', () => {
    expect(validateAgainstSchema('b', { enum: ['a', 'b', 'c'] }).ok).toBe(true);
    const r = validateAgainstSchema('z', { enum: ['a', 'b'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe('$');
  });

  test('enum 支持对象成员(结构等值)', () => {
    expect(validateAgainstSchema({ x: 1 }, { enum: [{ x: 1 }, { y: 2 }] }).ok).toBe(true);
  });

  test('pattern 对 string 生效', () => {
    expect(validateAgainstSchema('abc123', { type: 'string', pattern: '^[a-z]+[0-9]+$' }).ok).toBe(true);
    expect(validateAgainstSchema('123', { type: 'string', pattern: '^[a-z]+$' }).ok).toBe(false);
  });

  test('pattern 对非 string 忽略;非法 pattern permissive 放过', () => {
    expect(validateAgainstSchema(5, { pattern: '^x$' }).ok).toBe(true);
    expect(validateAgainstSchema('anything', { type: 'string', pattern: '(' }).ok).toBe(true);
  });
});

describe('validateAgainstSchema — oneOf / anyOf', () => {
  test('oneOf 恰好 1 个', () => {
    const s = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(validateAgainstSchema('x', s).ok).toBe(true);
    expect(validateAgainstSchema(3, s).ok).toBe(true);
    expect(validateAgainstSchema(true, s).ok).toBe(false);
  });

  test('oneOf 多分支同时命中 → 失败', () => {
    // number 与 integer 对 3 同时成立 → matched=2 → fail。
    const s = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
    expect(validateAgainstSchema(3, s).ok).toBe(false);
  });

  test('anyOf 至少 1 个', () => {
    const s = { anyOf: [{ type: 'string' }, { type: 'boolean' }] };
    expect(validateAgainstSchema(true, s).ok).toBe(true);
    expect(validateAgainstSchema(5, s).ok).toBe(false);
  });
});

describe('ReadTracker', () => {
  test('record 返回累加后次数;count 读取', () => {
    const t = new ReadTracker();
    expect(t.count('/a')).toBe(0);
    expect(t.record('/a')).toBe(1);
    expect(t.record('/a')).toBe(2);
    expect(t.record('/b')).toBe(1);
    expect(t.count('/a')).toBe(2);
    expect(t.count('/b')).toBe(1);
  });

  test('over(K) 用 > 语义:读满 K 不算越线,K+1 才越线', () => {
    const t = new ReadTracker();
    const K = 3;
    for (let i = 0; i < K; i++) t.record('/f');
    expect(t.count('/f')).toBe(K);
    expect(t.over('/f', K)).toBe(false);
    t.record('/f'); // K+1
    expect(t.over('/f', K)).toBe(true);
  });

  test('默认 limit = 20', () => {
    const t = new ReadTracker();
    for (let i = 0; i < DEFAULT_SAME_FILE_READ_LIMIT; i++) t.record('/g');
    expect(t.over('/g')).toBe(false);
    t.record('/g');
    expect(t.over('/g')).toBe(true);
  });

  test('limit ≤ 0 / 非有限 → 永不越线(fail-open)', () => {
    const t = new ReadTracker();
    for (let i = 0; i < 100; i++) t.record('/h');
    expect(t.over('/h', 0)).toBe(false);
    expect(t.over('/h', -1)).toBe(false);
    expect(t.over('/h', Infinity)).toBe(false);
  });

  test('reset 清空', () => {
    const t = new ReadTracker();
    t.record('/x');
    t.reset();
    expect(t.count('/x')).toBe(0);
  });
});
