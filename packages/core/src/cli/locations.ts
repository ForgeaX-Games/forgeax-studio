/**
 * `.forgeax` 能力目录发现 —— CLI host 的「项目级 + 用户级」配置布局 SSOT。
 *
 * 与分层 settings(`./settings`)同源同向:
 *   用户级 = `configHomeDir()` = `$FORGEAX_CONFIG_DIR || ~/.forgeax`
 *   项目级 = `<cwd>/.forgeax`
 * 方向 **project 覆盖 user**(对齐 settings 的 user<project)。skill/agent/command 这类
 * first-wins loader 因此把**项目目录排在用户目录前面**;mcp 这类 merge 语义则**用户先合、
 * 项目后盖**。
 *
 * 各目录类 loader 对缺失目录已优雅跳过(readdirSync catch),故目录类发现**不做 existsSync
 * 过滤**(原样返回有序两项);只有 mcp 配置是「读文件再合并」,需先 existsSync 过滤。
 *
 * Boundary(HOST 层):仅 core 相对 import + node:。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configHomeDir } from './settings';

/** 项目根(`<cwd>/.forgeax`)与用户根(configHome)。 */
export function capabilityRoots(cwd: string = process.cwd()): { project: string; user: string } {
  return { project: join(resolve(cwd), '.forgeax'), user: configHomeDir() };
}

/** 某能力子目录的有序发现:[项目, 用户](项目优先,first-wins loader 用)。 */
function discoverDirs(sub: string, cwd: string = process.cwd()): string[] {
  const { project, user } = capabilityRoots(cwd);
  return [join(project, sub), join(user, sub)];
}

/** skill 根目录:`<root>/skills`(项目优先)。 */
export function discoverSkillDirs(cwd: string = process.cwd()): string[] {
  return discoverDirs('skills', cwd);
}

/** 单文件 markdown 指令目录:`<root>/commands`(项目优先)。 */
export function discoverCommandDirs(cwd: string = process.cwd()): string[] {
  return discoverDirs('commands', cwd);
}

/** subagent 定义目录:`<root>/agents`(项目优先)。 */
export function discoverAgentDirs(cwd: string = process.cwd()): string[] {
  return discoverDirs('agents', cwd);
}

/** plugin 源目录:`<root>/plugins`(项目优先)。 */
export function discoverPluginDirs(cwd: string = process.cwd()): string[] {
  return discoverDirs('plugins', cwd);
}

/**
 * 生效的 skill / command 目录:**给了 flag 就只用 flag**(关闭自动发现),否则用发现到的两层。
 * host-context、TUI driver、TUI slash 桥共用这套口径(SSOT),保证模型侧与用户侧一致。
 */
export function effectiveSkillDirs(flag?: readonly string[], cwd: string = process.cwd()): string[] {
  return flag && flag.length > 0 ? [...flag] : discoverSkillDirs(cwd);
}
export function effectiveCommandDirs(flag?: readonly string[], cwd: string = process.cwd()): string[] {
  return flag && flag.length > 0 ? [...flag] : discoverCommandDirs(cwd);
}

/** MCP 配置文件:`<root>/mcp.json`,**仅返回存在的**(项目在前)。 */
export function discoverMcpConfigFiles(cwd: string = process.cwd()): string[] {
  const { project, user } = capabilityRoots(cwd);
  return [join(project, 'mcp.json'), join(user, 'mcp.json')].filter((f) => existsSync(f));
}

/** `{ mcpServers: {...} }` 形状的最小子集(其余键透传)。 */
interface McpConfigShape {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

/** 读单个 mcp.json;失败 → {}(永不抛,交由 parseMcpConfig 兜底报错)。 */
function readMcpFile(path: string): McpConfigShape {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as McpConfigShape) : {};
  } catch {
    return {};
  }
}

/**
 * 解析最终 MCP 配置:
 *   - `flagPath` 给了(`--mcp`)→ **只读该文件**(flag 给了即只用 flag)。
 *   - 否则合并发现到的 `<root>/mcp.json` —— **用户先合、项目后盖**(项目键覆盖用户键)。
 *   - 都没有 → `undefined`(不装配 MCP)。
 */
export function loadMergedMcpConfig(
  flagPath: string | undefined,
  cwd: string = process.cwd(),
): McpConfigShape | undefined {
  if (flagPath) return readMcpFile(flagPath);
  const files = discoverMcpConfigFiles(cwd); // [项目, 用户](existing)
  if (files.length === 0) return undefined;
  // 合并方向:用户(后给)先放底,项目(先给)覆盖在上 → 项目键覆盖用户键。
  const merged: McpConfigShape = { mcpServers: {} };
  for (const path of [...files].reverse()) {
    const cfg = readMcpFile(path);
    Object.assign(merged.mcpServers!, cfg.mcpServers ?? {});
    // 透传其它顶层键(项目最终覆盖)。
    for (const [k, v] of Object.entries(cfg)) if (k !== 'mcpServers') merged[k] = v;
  }
  return merged;
}
