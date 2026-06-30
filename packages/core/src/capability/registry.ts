/**
 * CapabilityRegistry — host 的 tools/slots/plugins 索引 + 工具池装配。
 *
 * 设计稿: core-layer-spec §3.4 (capability host).
 *   - findToolByName (name+aliases 查找)
 *   - assembleToolPool (builtin 连续前缀单独排序后再拼 MCP/其他,
 *     uniqBy name builtin 胜 —— 保 prompt-cache 断点)
 *   - filterToolsByDenyRules (装配期剔除被 deny 的工具,含
 *     `mcp__server` 前缀)
 *
 * Boundary: 仅 import C2 契约。无 node:、无 IO —— 纯内存索引。registry 不发现
 * 包 (那是 loader 的事),只接收 loader 算好的 tools/slots/plugins 并索引。
 */
import type { AgentTool, Slot, Plugin } from './types';

// ─── name/alias 匹配 ────────────────

/** 工具是否匹配某个 name (主名或 alias)。 */
export function toolMatchesName(
  tool: Pick<AgentTool, 'name' | 'aliases'>,
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false);
}

// ─── deny 过滤 (装配期) ─────────────────────────

/**
 * 装配期 deny 规则的 core 形态。C2 不引入 PERM 的完整规则引擎 (那在 PERM 层),
 * 这里只表达「装配期就让模型看不到」的两类 blanket deny:
 *   - `tools`:  按工具名 (主名/alias) 的整工具 deny —— 无 ruleContent
 *               的 blanket deny。
 *   - `mcpServers`: 按 MCP server 名前缀的整服务 deny —— `mcp__server`
 *               前缀规则在模型看到前就剥掉该 server 全部工具。
 */
export interface DenyRules {
  tools?: readonly string[];
  mcpServers?: readonly string[];
}

/** 某工具是否被 deny 命中。 */
export function isToolDenied(
  tool: Pick<AgentTool, 'name' | 'aliases' | 'mcpInfo'>,
  deny: DenyRules | undefined,
): boolean {
  if (!deny) return false;
  for (const n of deny.tools ?? []) {
    if (toolMatchesName(tool, n)) return true;
  }
  if (tool.mcpInfo) {
    for (const s of deny.mcpServers ?? []) {
      if (tool.mcpInfo.serverName === s) return true;
    }
  }
  return false;
}

/**
 * 装配期剔除被 deny 的工具:
 * 用与运行期把闸同一套匹配,使 `mcp__server` 前缀规则在「模型看到前」就剥掉
 * 该 server 全部工具,而非只在 call 时拦。
 */
export function filterByDenyRules<
  T extends Pick<AgentTool, 'name' | 'aliases' | 'mcpInfo'>,
>(tools: readonly T[], deny: DenyRules | undefined): T[] {
  if (!deny || ((deny.tools?.length ?? 0) === 0 && (deny.mcpServers?.length ?? 0) === 0)) {
    return [...tools];
  }
  return tools.filter((t) => !isToolDenied(t, deny));
}

// ─── CapabilityRegistry ───────────────────────────────────────────────────────

/**
 * tools 装配选项 —— assembleToolPool 的 (builtin, mcp/其他) 二分。
 *
 * `builtin`: 连续前缀工具 (本地内置)。`extra`: MCP + 其他后注入工具。
 * 各自内部按 name 排序后拼接,builtin 整段在前 —— server 的 cache policy 在
 * 「最后一个前缀命中的 builtin 工具」后放全局 cache 断点,扁平排序会把 MCP
 * 工具插进 builtin 中间从而打穿断点。
 */
export interface AssembleOptions {
  /** builtin 连续前缀工具 (默认空)。 */
  builtin?: readonly AgentTool[];
  /** MCP / 其他后注入工具 (默认空)。 */
  extra?: readonly AgentTool[];
  /** 装配期 deny 过滤 (对 builtin + extra 都生效)。 */
  deny?: DenyRules;
  /** 是否丢弃 isEnabled()===false 的工具 (默认 true)。 */
  filterDisabled?: boolean;
}

/**
 * uniqBy(name) —— 保留首次出现,丢弃后续同名。对齐 lodash-es uniqBy 的「插入序
 * 保留,首胜」语义,使 builtin 在与 MCP 同名冲突时获胜 (builtin 先拼)。
 */
function uniqByName<T extends { name: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    out.push(it);
  }
  return out;
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name);

/**
 * 内存索引: tools (含 alias)、slots、plugins。loader 把加载好的能力灌进来,
 * LOOP/CTX/PERM 从这里取。不做发现/IO/condition —— 单一职责: 索引 + 装配。
 */
export class CapabilityRegistry {
  /** 主名 → tool。 */
  private readonly toolsByName = new Map<string, AgentTool>();
  /** alias → 主名 (alias 不覆盖已存在主名)。 */
  private readonly aliasIndex = new Map<string, string>();
  /** 注册序 (装配时 builtin/extra 二分前的稳定基序)。 */
  private readonly toolOrder: string[] = [];

  private readonly slotsByName = new Map<string, Slot>();
  private readonly slotOrder: string[] = [];

  private readonly pluginsByName = new Map<string, Plugin>();
  private readonly pluginOrder: string[] = [];

  // ── tools ──────────────────────────────────────────────────────────────────

  /** 注册工具 (整包替换语义由 loader 负责;registry 这里同名直接覆盖)。 */
  registerTool(tool: AgentTool): void {
    if (!this.toolsByName.has(tool.name)) this.toolOrder.push(tool.name);
    this.toolsByName.set(tool.name, tool);
    for (const a of tool.aliases ?? []) {
      // alias 不抢已存在的主名;也不互相覆盖 (首注册赢) —— 查找
      // 「按列表顺序首个命中」,避免改名别名误指。
      if (this.toolsByName.has(a)) continue;
      if (!this.aliasIndex.has(a)) this.aliasIndex.set(a, tool.name);
    }
  }

  /** 移除工具 (含其 alias 索引)。loader 整包替换/卸载时用。 */
  removeTool(name: string): void {
    const tool = this.toolsByName.get(name);
    if (!tool) return;
    this.toolsByName.delete(name);
    const i = this.toolOrder.indexOf(name);
    if (i >= 0) this.toolOrder.splice(i, 1);
    for (const [alias, primary] of this.aliasIndex) {
      if (primary === name) this.aliasIndex.delete(alias);
    }
  }

  /** 按 name 或 alias 查找。 */
  findTool(name: string): AgentTool | undefined {
    const direct = this.toolsByName.get(name);
    if (direct) return direct;
    const primary = this.aliasIndex.get(name);
    return primary ? this.toolsByName.get(primary) : undefined;
  }

  hasTool(name: string): boolean {
    return this.findTool(name) !== undefined;
  }

  /** 全部已注册工具 (注册序)。 */
  listTools(): AgentTool[] {
    return this.toolOrder.map((n) => this.toolsByName.get(n)!);
  }

  /**
   * 装配工具池:
   *   1. deny 过滤 builtin 与 extra (装配期就剔除,含 `mcp__server` 前缀)。
   *   2. builtin / extra 各自按 name 排序。
   *   3. builtin 整段在前拼 extra —— 保 builtin 连续前缀 (prompt-cache 断点)。
   *   4. uniqBy(name): 同名冲突 builtin 胜 (插入序首胜)。
   *   5. 可选丢弃 isEnabled()===false。
   *
   * 不给 builtin/extra 时,退化为「对全 registry 工具按 name 排序 + uniq」,
   * 视作一段 builtin 前缀 (无 MCP 切分需求场景)。
   */
  assembleToolPool(opts: AssembleOptions = {}): AgentTool[] {
    const filterDisabled = opts.filterDisabled ?? true;
    const builtinSrc = opts.builtin ?? (opts.extra ? [] : this.listTools());
    const extraSrc = opts.extra ?? [];

    const builtin = filterByDenyRules(builtinSrc, opts.deny).sort(byName);
    const extra = filterByDenyRules(extraSrc, opts.deny).sort(byName);

    let pool = uniqByName([...builtin, ...extra]);
    if (filterDisabled) {
      // 先快照 isEnabled() 再过滤 (map 后 filter,
      // 避免谓词带副作用时索引错位)。
      const enabled = pool.map((t) => {
        try {
          return t.isEnabled();
        } catch {
          return false; // fail-closed
        }
      });
      pool = pool.filter((_, i) => enabled[i]);
    }
    return pool;
  }

  // ── slots ────────────────────────────────────────────────────────────────────

  registerSlot(slot: Slot): void {
    if (!this.slotsByName.has(slot.name)) this.slotOrder.push(slot.name);
    this.slotsByName.set(slot.name, slot);
  }

  removeSlot(name: string): void {
    if (!this.slotsByName.delete(name)) return;
    const i = this.slotOrder.indexOf(name);
    if (i >= 0) this.slotOrder.splice(i, 1);
  }

  findSlot(name: string): Slot | undefined {
    return this.slotsByName.get(name);
  }

  /** 全部 slots (注册序)。 */
  listSlots(): Slot[] {
    return this.slotOrder.map((n) => this.slotsByName.get(n)!);
  }

  // ── plugins ──────────────────────────────────────────────────────────────────

  registerPlugin(plugin: Plugin): void {
    if (!this.pluginsByName.has(plugin.name)) this.pluginOrder.push(plugin.name);
    this.pluginsByName.set(plugin.name, plugin);
  }

  removePlugin(name: string): void {
    if (!this.pluginsByName.delete(name)) return;
    const i = this.pluginOrder.indexOf(name);
    if (i >= 0) this.pluginOrder.splice(i, 1);
  }

  findPlugin(name: string): Plugin | undefined {
    return this.pluginsByName.get(name);
  }

  /** 全部 plugins (注册序)。 */
  listPlugins(): Plugin[] {
    return this.pluginOrder.map((n) => this.pluginsByName.get(n)!);
  }
}
