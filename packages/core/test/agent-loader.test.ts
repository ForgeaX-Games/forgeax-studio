/**
 * loadAgentDefs + buildSubagentRegistry 单测 (L1 AGENT pack)。
 *
 * 覆盖:
 *   - 正常解析 frontmatter → SubagentType(name/description/role/systemPrompt)。
 *   - 缺 name 或 description → 跳过该文件。
 *   - model: inherit / 空 → undefined。
 *   - max-turns / maxTurns 整数;非整数 → undefined。
 *   - omit-heavy-context 布尔。
 *   - tools 缺省 / 含 '*' → 无过滤器(全部);否则按名过滤(不剥 Task)。
 *   - 目录不存在 → 跳过、不抛。
 *   - buildSubagentRegistry: disk 同名覆盖 builtin(last-wins)。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentDefs } from '../src/capability/agent/loader';
import { buildSubagentRegistry } from '../src/capability/agent/registry-build';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { SubagentType } from '../src/agent/subagent-registry';

function tool(name: string): AgentTool {
  return buildTool({
    name,
    inputJSONSchema: { type: 'object' },
    call: async () => ({ data: null }),
    mapResult: () => ({ kind: 'tool.result', toolUseId: '', output: null }) as never,
    maxResultSizeChars: Infinity,
  });
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-loader-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadAgentDefs', () => {
  test('解析完整 frontmatter + 正文 → SubagentType', () => {
    writeFileSync(
      join(dir, 'iori.md'),
      `---
name: iori
description: 立柱规划
role: planner
model: claude-3-5-sonnet
max-turns: 7
omit-heavy-context: true
---
你是 Iori,负责立柱。`,
    );
    const defs = loadAgentDefs([dir]);
    const iori = defs.find((d) => d.name === 'iori');
    expect(iori).toBeDefined();
    expect(iori!.description).toBe('立柱规划');
    expect(iori!.role).toBe('planner');
    expect(iori!.model).toBe('claude-3-5-sonnet');
    expect(iori!.maxTurns).toBe(7);
    expect(iori!.omitHeavyContext).toBe(true);
    expect(iori!.systemPrompt.trim()).toBe('你是 Iori,负责立柱。');
    expect(iori!.allowedTools).toBeUndefined();
  });

  test('缺 name → 跳过', () => {
    const d = mkdtempSync(join(tmpdir(), 'agent-noname-'));
    writeFileSync(join(d, 'x.md'), `---\ndescription: 无名\n---\nbody`);
    expect(loadAgentDefs([d])).toHaveLength(0);
    rmSync(d, { recursive: true, force: true });
  });

  test('缺 description → 跳过', () => {
    const d = mkdtempSync(join(tmpdir(), 'agent-nodesc-'));
    writeFileSync(join(d, 'x.md'), `---\nname: x\n---\nbody`);
    expect(loadAgentDefs([d])).toHaveLength(0);
    rmSync(d, { recursive: true, force: true });
  });

  test('model: inherit → undefined;maxTurns 非整数 → undefined', () => {
    const d = mkdtempSync(join(tmpdir(), 'agent-inherit-'));
    writeFileSync(
      join(d, 'a.md'),
      `---\nname: a\ndescription: d\nmodel: inherit\nmax-turns: abc\n---\nb`,
    );
    const [def] = loadAgentDefs([d]);
    expect(def.model).toBeUndefined();
    expect(def.maxTurns).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });

  test('tools 含 * → 无过滤器;否则按名过滤(不剥 Task)', () => {
    const d = mkdtempSync(join(tmpdir(), 'agent-tools-'));
    writeFileSync(join(d, 'star.md'), `---\nname: star\ndescription: d\ntools: "*"\n---\nb`);
    writeFileSync(
      join(d, 'pick.md'),
      `---\nname: pick\ndescription: d\ntools: [Read, Task]\n---\nb`,
    );
    const defs = loadAgentDefs([d]);
    const star = defs.find((x) => x.name === 'star')!;
    const pick = defs.find((x) => x.name === 'pick')!;
    expect(star.allowedTools).toBeUndefined();
    expect(pick.allowedTools).toBeDefined();
    const all = [tool('Read'), tool('Write'), tool('Task')];
    const picked = pick.allowedTools!(all).map((t) => t.name);
    // loader 不剥 Task(由 resolveSubagentTools 强制剥);此处过滤器原样按名留 Read+Task。
    expect(picked).toEqual(['Read', 'Task']);
    rmSync(d, { recursive: true, force: true });
  });

  test('目录不存在 → 跳过、不抛', () => {
    expect(loadAgentDefs([join(dir, 'nope-does-not-exist')])).toHaveLength(0);
  });

  test('忽略非 .md 与点开头文件', () => {
    const d = mkdtempSync(join(tmpdir(), 'agent-ignore-'));
    writeFileSync(join(d, 'note.txt'), `---\nname: t\ndescription: d\n---\nb`);
    writeFileSync(join(d, '.hidden.md'), `---\nname: h\ndescription: d\n---\nb`);
    mkdirSync(join(d, 'sub.md')); // 同名目录也忽略
    expect(loadAgentDefs([d])).toHaveLength(0);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('buildSubagentRegistry', () => {
  const builtin = (name: string, sp: string): SubagentType => ({
    name,
    description: `builtin ${name}`,
    systemPrompt: sp,
  });
  const disk = (name: string, sp: string): SubagentType => ({
    name,
    description: `disk ${name}`,
    systemPrompt: sp,
  });

  test('disk 同名覆盖 builtin(last-wins)', () => {
    const reg = buildSubagentRegistry(
      [builtin('planner', 'B'), builtin('coder', 'B')],
      [disk('planner', 'D')],
    );
    expect(reg.resolve('planner')!.systemPrompt).toBe('D');
    expect(reg.resolve('coder')!.systemPrompt).toBe('B');
    expect(reg.list()).toHaveLength(2);
  });

  test('无 disk → 与纯 builtin 一致', () => {
    const reg = buildSubagentRegistry([builtin('planner', 'B')], []);
    expect(reg.resolve('planner')!.systemPrompt).toBe('B');
    expect(reg.list()).toHaveLength(1);
  });
});
