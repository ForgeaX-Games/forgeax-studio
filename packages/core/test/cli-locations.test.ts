/**
 * CLI `.forgeax` 目录发现 + 单文件 markdown 指令加载测试。
 *
 * 覆盖:
 *   - locations.ts:发现函数排序(项目优先)、FORGEAX_CONFIG_DIR 生效、
 *     loadMergedMcpConfig(合并/项目覆盖用户/无文件→undefined/flag 只用 flag)。
 *   - command-files.ts:*.md 加载、子目录 `:` 命名、first-wins 去重、畸形跳过。
 *   - skillPack({commandDirs}):commands 进 Skill 工具且可被 validateInput 命中;
 *     零指令→不挂工具。
 *
 * 用临时目录(mkdtempSync)造 `.forgeax/...` 与 configHome。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkillDirs,
  discoverCommandDirs,
  discoverAgentDirs,
  discoverPluginDirs,
  discoverMcpConfigFiles,
  loadMergedMcpConfig,
} from '../src/cli/locations';
import { loadCommandDirs } from '../src/capability/skill/command-files';
import { skillPack } from '../src/capability/skill';
import type { ToolContext } from '../src/capability/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

const ctx = (): ToolContext => ({ signal: new AbortController().signal });

/** 临时 cwd + configHome 对;返回路径并在测试后清理。 */
const tmpRoots: string[] = [];
function makeRoots(): { cwd: string; configHome: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'loc-cwd-'));
  const configHome = mkdtempSync(join(tmpdir(), 'loc-cfg-'));
  tmpRoots.push(cwd, configHome);
  process.env.FORGEAX_CONFIG_DIR = configHome;
  return { cwd, configHome };
}

afterEach(() => {
  delete process.env.FORGEAX_CONFIG_DIR;
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function writeCommand(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

// ─── discovery ordering ────────────────────────────────────────────────────────

describe('locations — 发现函数排序(项目优先)+ FORGEAX_CONFIG_DIR', () => {
  test('skill/command/agent/plugin 都是 [项目, 用户]', () => {
    const { cwd, configHome } = makeRoots();
    expect(discoverSkillDirs(cwd)).toEqual([join(cwd, '.forgeax/skills'), join(configHome, 'skills')]);
    expect(discoverCommandDirs(cwd)).toEqual([join(cwd, '.forgeax/commands'), join(configHome, 'commands')]);
    expect(discoverAgentDirs(cwd)).toEqual([join(cwd, '.forgeax/agents'), join(configHome, 'agents')]);
    expect(discoverPluginDirs(cwd)).toEqual([join(cwd, '.forgeax/plugins'), join(configHome, 'plugins')]);
  });
});

// ─── mcp merge ─────────────────────────────────────────────────────────────────

describe('loadMergedMcpConfig', () => {
  test('无文件 → undefined', () => {
    const { cwd } = makeRoots();
    expect(loadMergedMcpConfig(undefined, cwd)).toBeUndefined();
    expect(discoverMcpConfigFiles(cwd)).toEqual([]);
  });

  test('合并两层,项目键覆盖用户键', () => {
    const { cwd, configHome } = makeRoots();
    mkdirSync(join(cwd, '.forgeax'), { recursive: true });
    writeFileSync(
      join(configHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { u: { type: 'http', url: 'U' }, shared: { type: 'http', url: 'user' } } }),
    );
    writeFileSync(
      join(cwd, '.forgeax/mcp.json'),
      JSON.stringify({ mcpServers: { p: { type: 'http', url: 'P' }, shared: { type: 'http', url: 'proj' } } }),
    );
    const cfg = loadMergedMcpConfig(undefined, cwd) as { mcpServers: Record<string, { url: string }> };
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['p', 'shared', 'u']);
    expect(cfg.mcpServers.shared.url).toBe('proj'); // 项目覆盖用户
  });

  test('给了 flag 就只读该文件(忽略发现)', () => {
    const { cwd } = makeRoots();
    mkdirSync(join(cwd, '.forgeax'), { recursive: true });
    writeFileSync(join(cwd, '.forgeax/mcp.json'), JSON.stringify({ mcpServers: { p: { type: 'http', url: 'P' } } }));
    const flag = join(cwd, 'custom.json');
    writeFileSync(flag, JSON.stringify({ mcpServers: { only: { type: 'http', url: 'F' } } }));
    const cfg = loadMergedMcpConfig(flag, cwd) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cfg.mcpServers)).toEqual(['only']);
  });
});

// ─── command-files loader ──────────────────────────────────────────────────────

describe('loadCommandDirs — 单文件 markdown *.md', () => {
  test('加载 *.md、子目录 `:` 命名、跳过非 .md', () => {
    const { cwd } = makeRoots();
    const dir = join(cwd, '.forgeax/commands');
    writeCommand(dir, 'greet.md', '---\ndescription: hi\n---\nHello $ARGUMENTS');
    writeCommand(dir, 'git/commit.md', '---\ndescription: commit\n---\ncommit body');
    writeCommand(dir, 'README.txt', 'not a command');
    const cmds = loadCommandDirs([dir]);
    const names = cmds.map((c) => c.name).sort();
    expect(names).toEqual(['git:commit', 'greet']);
    const greet = cmds.find((c) => c.name === 'greet')!;
    expect(greet.getPrompt('world')).toContain('Hello world');
    // markdown 指令默认:user-invocable + 非 disable-model-invocation。
    expect(greet.userInvocable).toBe(true);
    expect(greet.disableModelInvocation).toBe(false);
  });

  test('多目录 first-wins(项目排前则项目胜)', () => {
    const { cwd, configHome } = makeRoots();
    const proj = join(cwd, '.forgeax/commands');
    const user = join(configHome, 'commands');
    writeCommand(proj, 'dup.md', '---\ndescription: from-project\n---\nP');
    writeCommand(user, 'dup.md', '---\ndescription: from-user\n---\nU');
    const cmds = loadCommandDirs(discoverCommandDirs(cwd));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.description).toBe('from-project');
  });
});

// ─── skillPack integration ─────────────────────────────────────────────────────

describe('skillPack — commands 并入 Skill 工具', () => {
  test('command 可被 Skill 工具 validateInput 命中', async () => {
    const { cwd } = makeRoots();
    const dir = join(cwd, '.forgeax/commands');
    writeCommand(dir, 'greet.md', '---\ndescription: hi\n---\nHello');
    const pack = skillPack([], undefined, { commandDirs: [dir] });
    expect(pack.tools).toHaveLength(1);
    const tool = pack.tools![0]!;
    expect(tool.name).toBe('Skill');
    const ok = await tool.validateInput!({ skill: 'greet' }, ctx());
    expect(ok.result).toBe(true);
    const miss = await tool.validateInput!({ skill: 'nope' }, ctx());
    expect(miss.result).toBe(false);
  });

  test('无源目录(都不存在)→ 不挂 Skill 工具', () => {
    const { cwd } = makeRoots();
    const pack = skillPack(discoverSkillDirs(cwd), undefined, { commandDirs: discoverCommandDirs(cwd) });
    expect(pack.tools).toHaveLength(0);
  });

  test('源目录存在但当前为空 → 仍挂工具(以支持热增第一条指令)', () => {
    const { cwd } = makeRoots();
    const dir = join(cwd, '.forgeax/commands');
    mkdirSync(dir, { recursive: true }); // 空目录
    const pack = skillPack([], undefined, { commandDirs: [dir] });
    expect(pack.tools).toHaveLength(1);
    // available 列表此刻为空。
    const schema = pack.tools![0]!.inputJSONSchema as { properties: { skill: { description: string } } };
    expect(schema.properties.skill.description).not.toContain('available:');
  });
});

// ─── 动态热更新 ──────────────────────────────────────────────────────────────

describe('skillPack — 指令热更新(增/改即时生效)', () => {
  test('运行中新增指令:dispatch 与 schema available 列表都即时可见', async () => {
    const { cwd } = makeRoots();
    const dir = join(cwd, '.forgeax/commands');
    writeCommand(dir, 'first.md', '---\ndescription: f\n---\nFirst');
    const tool = skillPack([], undefined, { commandDirs: [dir] }).tools![0]!;

    // 初始:仅 first 可见。
    expect((await tool.validateInput!({ skill: 'second' }, ctx())).result).toBe(false);
    let desc = (tool.inputJSONSchema as { properties: { skill: { description: string } } }).properties.skill.description;
    expect(desc).toContain('first');
    expect(desc).not.toContain('second');

    // 运行中新增 second.md(改变源签名)→ 同一 tool 对象无需重建即看到。
    writeCommand(dir, 'second.md', '---\ndescription: s\n---\nSecond');
    expect((await tool.validateInput!({ skill: 'second' }, ctx())).result).toBe(true);
    desc = (tool.inputJSONSchema as { properties: { skill: { description: string } } }).properties.skill.description;
    expect(desc).toContain('second'); // schema available 列表已更新(buildRequest 每轮现读)
  });

  test('运行中编辑指令内容:下次 call 用最新 prompt', async () => {
    const { cwd } = makeRoots();
    const dir = join(cwd, '.forgeax/commands');
    writeCommand(dir, 'g.md', '---\ndescription: g\n---\nOLD body');
    const tool = skillPack([], undefined, { commandDirs: [dir] }).tools![0]!;

    const r1 = await tool.call!({ skill: 'g' }, ctx());
    expect((r1.data as { prompt: string }).prompt).toContain('OLD body');

    // 改内容(长度不同 → size 变 → 签名变,稳健避开 mtime 秒级粒度)。
    writeCommand(dir, 'g.md', '---\ndescription: g\n---\nNEW longer body here');
    const r2 = await tool.call!({ skill: 'g' }, ctx());
    expect((r2.data as { prompt: string }).prompt).toContain('NEW longer body here');
    expect((r2.data as { prompt: string }).prompt).not.toContain('OLD body');
  });
});
