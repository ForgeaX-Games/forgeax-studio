/**
 * inspectAgents 单测(AGENT pack · /agents A 层底层能力,见 todo 020)。
 *
 * 覆盖:
 *   - builtin / disk 两组摊平为 { name, role, description, tools, source };
 *   - disk 同名 last-wins 覆盖 builtin,且来源记为 'custom'(对齐 registry-build);
 *   - 提供 allTools → tools 走真实 resolveSubagentTools(应用过滤 + 强制剥 'Task');
 *   - 不提供 allTools → 无过滤器记 ['*'],有过滤器记 [];
 *   - 结果按 name 字典序稳定排序;
 *   - 真接内置 builtinSubagents,字段与定义一致(Explore/general-purpose)。
 */
import { test, expect, describe } from 'bun:test';
import { inspectAgents } from '../src/capability/agent/inspect';
import { builtinSubagents } from '../src/capability/agent/builtin';
import type { SubagentType } from '../src/agent/subagent-registry';
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

describe('inspectAgents', () => {
  test('builtin 组摊平为 AgentInfo(无 allTools:无过滤器记 *,有过滤器记 [])', () => {
    const builtins: SubagentType[] = [
      { name: 'general', description: '通用', systemPrompt: 'g' }, // 无过滤器
      {
        name: 'reader',
        role: 'r',
        description: '只读',
        systemPrompt: 'r',
        allowedTools: (all) => all.filter((t) => t.name === 'Read'),
      },
    ];
    const got = inspectAgents({ builtins, disk: [] });
    expect(got.map((a) => a.name)).toEqual(['general', 'reader']); // 字典序
    expect(got.find((a) => a.name === 'general')).toMatchObject({
      role: undefined,
      description: '通用',
      tools: ['*'],
      source: 'builtin',
    });
    expect(got.find((a) => a.name === 'reader')).toMatchObject({
      role: 'r',
      tools: [],
      source: 'builtin',
    });
  });

  test('提供 allTools → tools 走真实解析(应用过滤 + 强制剥 Task)', () => {
    const builtins: SubagentType[] = [
      {
        name: 'reader',
        description: '只读',
        systemPrompt: 'r',
        // 过滤器疏忽放行 Task,inspect 仍须剥掉(对齐 resolveSubagentTools)。
        allowedTools: (all) => all.filter((t) => ['Read', 'Task'].includes(t.name)),
      },
      { name: 'plain', description: '全量', systemPrompt: 'p' }, // 无过滤器 → 全量(剥 Task)
    ];
    const allTools = [tool('Read'), tool('Write'), tool('Task')];
    const got = inspectAgents({ builtins, disk: [], allTools });
    expect(got.find((a) => a.name === 'reader')!.tools).toEqual(['Read']);
    // plain 无过滤器 = 全量,但 'Task' 永远剥掉。
    expect(got.find((a) => a.name === 'plain')!.tools).toEqual(['Read', 'Write']);
  });

  test('disk 同名 last-wins 覆盖 builtin,来源记 custom', () => {
    const builtins: SubagentType[] = [
      { name: 'shared', role: 'b', description: '内置版', systemPrompt: 'b' },
      { name: 'only-builtin', description: '仅内置', systemPrompt: 'ob' },
    ];
    const disk: SubagentType[] = [
      { name: 'shared', role: 'd', description: '磁盘版', systemPrompt: 'd' },
      { name: 'only-disk', description: '仅磁盘', systemPrompt: 'od' },
    ];
    const got = inspectAgents({ builtins, disk });
    expect(got.map((a) => a.name)).toEqual(['only-builtin', 'only-disk', 'shared']);

    const shared = got.find((a) => a.name === 'shared')!;
    expect(shared.description).toBe('磁盘版'); // disk 覆盖
    expect(shared.role).toBe('d');
    expect(shared.source).toBe('custom'); // 覆盖项记 custom

    expect(got.find((a) => a.name === 'only-builtin')!.source).toBe('builtin');
    expect(got.find((a) => a.name === 'only-disk')!.source).toBe('custom');
  });

  test('空输入 → 空清单', () => {
    expect(inspectAgents({ builtins: [], disk: [] })).toEqual([]);
  });

  test('真接内置 builtinSubagents:Explore/general-purpose 字段与定义一致', () => {
    const got = inspectAgents({ builtins: builtinSubagents, disk: [] });
    const names = got.map((a) => a.name);
    expect(names).toContain('Explore');
    expect(names).toContain('general-purpose');
    expect(got.every((a) => a.source === 'builtin')).toBe(true);

    const explore = got.find((a) => a.name === 'Explore')!;
    expect(explore.role).toBe('explorer');
    expect(explore.tools).toEqual([]); // 有 allowedTools,未给 allTools → []

    const gp = got.find((a) => a.name === 'general-purpose')!;
    expect(gp.role).toBeUndefined();
    expect(gp.tools).toEqual(['*']); // 无 allowedTools → 全量占位
  });
});
