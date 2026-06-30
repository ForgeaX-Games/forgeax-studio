/**
 * SubagentRegistry + 解析 helper 单测(S1)。
 *
 * 覆盖:register/resolve/list;unknown/undefined type → undefined;
 * resolveSubagentTools 应用 allowedTools 且**永远剥掉 'Task'**;
 * resolveSubagentSystem 回退 fallback;describeSubagentTypes 列出已注册名。
 */
import { test, expect, describe } from 'bun:test';
import {
  SubagentRegistry,
  resolveSubagentTools,
  resolveSubagentSystem,
  describeSubagentTypes,
  type SubagentType,
} from '../src/agent/subagent-registry';
import { buildTool, type AgentTool } from '../src/capability/types';

/** 造一个最小工具(只需 name 用于过滤断言)。 */
function tool(name: string): AgentTool {
  return buildTool({
    name,
    inputJSONSchema: { type: 'object' },
    call: async () => ({ data: null }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { toolUseId: id }, ts: 0 }),
    maxResultSizeChars: Infinity,
  });
}

describe('SubagentRegistry', () => {
  test('register / resolve / list', () => {
    const reg = new SubagentRegistry();
    const planner: SubagentType = { name: 'planner', description: '规划任务', systemPrompt: 'you plan' };
    const coder: SubagentType = { name: 'coder', description: '写代码', systemPrompt: 'you code' };
    reg.register(planner);
    reg.register(coder);

    expect(reg.resolve('planner')).toEqual(planner);
    expect(reg.resolve('coder')).toEqual(coder);
    expect(reg.list()).toHaveLength(2);
    expect(reg.list().map((t) => t.name).sort()).toEqual(['coder', 'planner']);
  });

  test('register overwrites by name', () => {
    const reg = new SubagentRegistry();
    reg.register({ name: 'x', description: 'old', systemPrompt: 'a' });
    reg.register({ name: 'x', description: 'new', systemPrompt: 'b' });
    expect(reg.list()).toHaveLength(1);
    expect(reg.resolve('x')?.description).toBe('new');
    expect(reg.resolve('x')?.systemPrompt).toBe('b');
  });

  test('resolve(undefined) and unknown type → undefined', () => {
    const reg = new SubagentRegistry();
    reg.register({ name: 'planner', description: '规划任务', systemPrompt: 'you plan' });
    expect(reg.resolve(undefined)).toBeUndefined();
    expect(reg.resolve('nope')).toBeUndefined();
  });
});

describe('resolveSubagentTools', () => {
  test('applies allowedTools filter', () => {
    const reg = new SubagentRegistry();
    reg.register({
      name: 'reader',
      description: '只读',
      systemPrompt: 's',
      allowedTools: (all) => all.filter((t) => t.name === 'Read'),
    });
    const all = [tool('Read'), tool('Write'), tool('Bash')];
    const got = resolveSubagentTools(reg, 'reader', all);
    expect(got.map((t) => t.name)).toEqual(['Read']);
  });

  test('falls back to all tools when type missing or no allowedTools', () => {
    const reg = new SubagentRegistry();
    reg.register({ name: 'plain', description: 'all', systemPrompt: 's' });
    const all = [tool('Read'), tool('Write')];
    expect(resolveSubagentTools(reg, 'plain', all).map((t) => t.name)).toEqual(['Read', 'Write']);
    // 未注册类型 → 也回退全量
    expect(resolveSubagentTools(reg, 'unknown', all).map((t) => t.name)).toEqual(['Read', 'Write']);
    // undefined 类型 → 回退全量
    expect(resolveSubagentTools(reg, undefined, all).map((t) => t.name)).toEqual(['Read', 'Write']);
  });

  test('ALWAYS strips Task — even when allowedTools tries to pass it through', () => {
    const reg = new SubagentRegistry();
    reg.register({
      name: 'sneaky',
      description: '想拿 Task',
      systemPrompt: 's',
      // 故意把 Task 放行
      allowedTools: (all) => all,
    });
    const all = [tool('Read'), tool('Task'), tool('Write')];
    const got = resolveSubagentTools(reg, 'sneaky', all);
    expect(got.map((t) => t.name)).toEqual(['Read', 'Write']);
    expect(got.some((t) => t.name === 'Task')).toBe(false);
  });

  test('strips Task on the fallback path too', () => {
    const reg = new SubagentRegistry();
    const all = [tool('Read'), tool('Task')];
    const got = resolveSubagentTools(reg, undefined, all);
    expect(got.map((t) => t.name)).toEqual(['Read']);
  });
});

describe('resolveSubagentSystem', () => {
  test('returns type systemPrompt when present', () => {
    const reg = new SubagentRegistry();
    reg.register({ name: 'planner', description: 'd', systemPrompt: 'you plan' });
    expect(resolveSubagentSystem(reg, 'planner', 'fb')).toBe('you plan');
  });

  test('falls back when type missing / undefined', () => {
    const reg = new SubagentRegistry();
    expect(resolveSubagentSystem(reg, 'nope', 'fallback')).toBe('fallback');
    expect(resolveSubagentSystem(reg, undefined, 'fallback')).toBe('fallback');
    // 既无类型也无 fallback → undefined
    expect(resolveSubagentSystem(reg, undefined)).toBeUndefined();
  });
});

describe('describeSubagentTypes', () => {
  test('lists registered names with descriptions', () => {
    const reg = new SubagentRegistry();
    reg.register({ name: 'planner', description: '规划任务', systemPrompt: 's' });
    reg.register({ name: 'coder', description: '写代码', systemPrompt: 's' });
    const desc = describeSubagentTypes(reg);
    expect(desc).toContain('- planner: 规划任务');
    expect(desc).toContain('- coder: 写代码');
  });

  test('empty registry → empty string', () => {
    expect(describeSubagentTypes(new SubagentRegistry())).toBe('');
  });
});
