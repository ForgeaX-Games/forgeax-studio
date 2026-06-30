/**
 * SKILL pack —— skill 加载 + SkillTool 的 CapabilityPack 出口。
 *
 * `skillPack(dirs)` 扫给定 skills 根目录 (按序 first-wins 去重)，把所有默认激活
 * (非 conditional) 的 skill 与 commands(单 .md)合并成一个 name='Skill' 的 AgentTool。
 *
 * **热更新**:工具的指令来源是一个**动态解析器**(非快照)——指令文件的增/改/删在
 * 长会话里即时生效(下一轮请求,模型即看到最新 available 列表;下一次调用即用最新内容)。
 * 解析器自带 mtime+size 签名缓存,内容不变时不重复读盘/解析。
 *
 * **挂载门**:只要任一源目录**当前存在**就挂工具(即便此刻为空,以支持"新增第一条指令");
 * 一个源目录都不存在 → 不挂(干净项目不受扰)。
 *
 * Boundary: 仅 import C2 契约 + core-local skill 子模块 + node:fs。
 */
import { existsSync, statSync } from 'node:fs';
import type { CapabilityPack } from '../types';
import { loadSkillsDir } from './loader';
import { loadCommandDirs, collectMdFiles } from './command-files';
import { buildSkillTool } from './skill-tool';
import type { Command, SkillPromptVars } from './command';

export * from './frontmatter';
export * from './command';
export * from './loader';
export * from './command-files';
export * from './skill-tool';

/** skillPack 的可选项。 */
export interface SkillPackOptions {
  /** 单文件 markdown 指令根目录(目录下递归 `*.md`;按优先级序 first-wins)。 */
  commandDirs?: readonly string[];
}

/**
 * 合并 skill + command 指令为去重列表(name first-wins:skill 名遇同名 command 时 skill 胜)。
 * 现解析(不缓存);供 Skill 工具与 TUI slash 桥共用同一数据口径(SSOT)。
 */
export function loadAllCommands(skillDirs: readonly string[], commandDirs: readonly string[]): Command[] {
  const { skills } = loadSkillsDir(skillDirs);
  const fileCommands = commandDirs.length ? loadCommandDirs(commandDirs) : [];
  const byName = new Map<string, Command>();
  for (const c of [...skills.map((s) => s.command), ...fileCommands]) {
    if (!byName.has(c.name)) byName.set(c.name, c);
  }
  return [...byName.values()];
}

/** 源目录的廉价变更签名:所有 `.md` 的 `path:mtimeMs:size`(增/删/改均改变它)。 */
function sourceSignature(dirs: readonly string[]): string {
  const parts: string[] = [];
  for (const d of dirs) {
    for (const f of collectMdFiles(d)) {
      try {
        const st = statSync(f);
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        /* 文件刚被删/不可读 → 跳过(签名自然变化) */
      }
    }
  }
  return parts.sort().join('|');
}

/**
 * 造一个带 mtime 缓存的动态指令解析器:签名不变时复用上次解析结果。
 * 供 Skill 工具(模型侧)与 TUI slash 桥(用户侧)共用,确保两侧热更新口径一致。
 */
export function makeCommandSource(skillDirs: readonly string[], commandDirs: readonly string[]): () => Command[] {
  const all = [...skillDirs, ...commandDirs];
  let cache: { sig: string; cmds: Command[] } | null = null;
  return () => {
    const sig = sourceSignature(all);
    if (cache && cache.sig === sig) return cache.cmds;
    const cmds = loadAllCommands(skillDirs, commandDirs);
    cache = { sig, cmds };
    return cmds;
  };
}

/**
 * 由 skills 根目录列表(+ 可选 commands 目录)造一个 builtin 层 CapabilityPack。
 * skill 与 commands(单 .md)合并进同一 Skill 工具;指令来源为动态解析器(见文件头「热更新」)。
 *
 * @param dirs skills 根目录列表 (按优先级序，first-wins)
 * @param vars 可选 prompt 注入变量 (sessionId 等)
 * @param opts 可选:commands 目录
 */
export function skillPack(
  dirs: readonly string[],
  vars?: SkillPromptVars,
  opts?: SkillPackOptions,
): CapabilityPack {
  const skillDirs = dirs ?? [];
  const commandDirs = opts?.commandDirs ?? [];
  const all = [...skillDirs, ...commandDirs];

  // 挂载门:任一源目录当前存在才挂(空也挂,以支持热增第一条指令);一个都不存在 → 不挂。
  if (!all.some((d) => existsSync(d))) {
    return { name: 'skill', layer: 'builtin', tools: [] };
  }

  const tool = buildSkillTool(makeCommandSource(skillDirs, commandDirs), vars);
  return {
    name: 'skill',
    layer: 'builtin',
    tools: [tool],
  };
}
