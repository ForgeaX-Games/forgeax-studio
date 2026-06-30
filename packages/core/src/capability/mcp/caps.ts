/**
 * MCP 工具注入治理策略层（M1 —— port of 01.6-mcp-工具注入治理）。
 *
 * core 已有 defer ENGINE（`src/agent/agent.ts` + `src/capability/tool-search.ts`：
 * 声明 `shouldDefer()===true` 的工具首轮不上线，靠 ToolSearch 现取现用）。本文件
 * 只补 **POLICY 层**：根据每个 server 的 `defer_loading` 配置 + 全局默认模式 +
 * 工具数阈值，裁决每个 server 落到 `sync`（首轮上线）还是 `async`（延迟）。
 *
 * 关键默认（USER REQUIREMENT）：全局默认是 **DEFER**（除非 env 显式置 'auto'）。
 * 'auto' 模式下沿用 01.6 原味：仅当 server 的工具总数 >= 阈值才延迟，否则上线。
 *
 * 不读 `process.env`（core 不直接碰宿主环境）：所有 env 由 host 注入，函数默认
 * 取空对象 `{}`。
 *
 * Boundary: 仅 import core-local。
 */

/** auto 模式下，server 工具数 >= 该阈值才转 async（延迟）。01.6 默认 20。 */
export const DEFAULT_MCP_SYNC_THRESHOLD = 20;

/**
 * 从注入的 env 读 `FORGEAX_MCP_SYNC_THRESHOLD`（auto 模式阈值）。
 * 非数字 / <=0 / NaN 一律回落到 {@link DEFAULT_MCP_SYNC_THRESHOLD}。
 *
 * @param env host 注入的 env（默认 `{}` —— 不在模块顶层读 `process.env`）。
 */
export function readMcpSyncThreshold(env: Record<string, string | undefined> = {}): number {
  const raw = env.FORGEAX_MCP_SYNC_THRESHOLD;
  if (raw === undefined) return DEFAULT_MCP_SYNC_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MCP_SYNC_THRESHOLD;
  return n;
}

/** 单个 MCP server 的注入模式：`sync`=首轮上线 / `async`=延迟（ToolSearch 现取）。 */
export type McpDeferMode = 'sync' | 'async';

/**
 * 从注入的 env 读 `FORGEAX_MCP_DEFER_DEFAULT`（全局默认模式）。
 *   - 值为 `'auto'` → `'auto'`（按阈值裁决）。
 *   - 其余 / 缺省 → `'defer'`（USER REQUIREMENT：默认就是延迟）。
 *
 * @param env host 注入的 env（默认 `{}`）。
 */
export function readMcpDeferDefault(
  env: Record<string, string | undefined> = {},
): 'defer' | 'auto' {
  return env.FORGEAX_MCP_DEFER_DEFAULT === 'auto' ? 'auto' : 'defer';
}

/**
 * 逐 server 裁决注入模式。规则（per server）：
 *   - `defer_loading === false` → **sync**（强制首轮上线，覆盖一切）。
 *   - `defer_loading === true`  → **async**（强制延迟）。
 *   - `undefined`（auto，未显式配置）：
 *       - `defaultMode === 'defer'` → **async**（默认延迟）。
 *       - `defaultMode === 'auto'`  → 仅当「auto + 强制 sync 的工具总数」>= 阈值
 *         时才 **async**，否则 **sync**（01.6 原味：工具少就别折腾延迟）。
 *
 * @param serverConfigs   server 名 → config（只看 `defer_loading`）。
 * @param serverToolCounts server 名 → 该 server 工具数。
 * @param threshold        auto 模式阈值，默认 {@link readMcpSyncThreshold}()。
 * @param defaultMode      全局默认模式，默认 {@link readMcpDeferDefault}()。
 * @returns `perServer` 逐 server 模式 + `anyAsync`（是否存在任一延迟 server）。
 */
export function decideMcpDeferMode(
  serverConfigs: Record<string, { defer_loading?: boolean } | undefined>,
  serverToolCounts: Record<string, number>,
  threshold: number = readMcpSyncThreshold(),
  defaultMode: 'defer' | 'auto' = readMcpDeferDefault(),
): { perServer: Record<string, McpDeferMode>; anyAsync: boolean } {
  // auto 模式下用于和阈值比较的工具总数：把「显式 sync(false)」与「auto(undefined)」
  // 两类 server 的工具数累加（01.6 原味：被强制 async 的不计入这笔账）。
  let autoAndForcedSyncCount = 0;
  for (const [server, cfg] of Object.entries(serverConfigs)) {
    if (cfg?.defer_loading === true) continue;
    autoAndForcedSyncCount += serverToolCounts[server] ?? 0;
  }

  const perServer: Record<string, McpDeferMode> = {};
  let anyAsync = false;

  for (const [server, cfg] of Object.entries(serverConfigs)) {
    let mode: McpDeferMode;
    if (cfg?.defer_loading === false) {
      mode = 'sync';
    } else if (cfg?.defer_loading === true) {
      mode = 'async';
    } else if (defaultMode === 'defer') {
      mode = 'async';
    } else {
      // auto：工具总数达阈值才延迟。
      mode = autoAndForcedSyncCount >= threshold ? 'async' : 'sync';
    }
    perServer[server] = mode;
    if (mode === 'async') anyAsync = true;
  }

  return { perServer, anyAsync };
}
