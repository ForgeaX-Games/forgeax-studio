/**
 * env-based MCP TokenProvider — CLI host 侧（WS-A）。
 *
 * core 本体不存 token、不读 `process.env`：MCP bearer token 经注入的 `TokenProvider`
 * 回调取(见 `src/capability/mcp/auth.ts`)。本文件是 CLI host 提供的那一份——按
 * server 名从环境变量解析 token,**每次调用都 lazy 读 `process.env`**,故 401 后
 * `{refresh:true}` 重读能拿到外部刚刷新的值。
 *
 * 解析优先级(对某个 server):
 *   1. `map[server]` 指定的 env 变量名(经 `--mcp-token <server=ENVVAR>` 来)→ 读它;
 *   2. `map['*']` 通配指定的 env 变量名(经裸 `--mcp-token <ENVVAR>` 来);
 *   3. `FORGEAX_MCP_TOKEN_<SERVER_UPPER>`(server 名大写 + 非字母数字→`_`);
 *   4. `FORGEAX_MCP_TOKEN`(全局兜底)。
 * 第一个非空命中即返回;都没有 → `undefined`(fail-open,不组装 Authorization)。
 *
 * Boundary: host 层(src/cli/),只 import core-local type + 读 process.env。
 */
import type { TokenProvider } from '../capability/mcp/auth';

/** server 名 → env 变量名片段(大写,非字母数字替 `_`)。 */
function serverUpper(server: string): string {
  return server.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

/**
 * 造一份从 env 解析 MCP token 的 `TokenProvider`。
 *
 * @param map 可选的 server→ENVVAR 名映射(来自 `--mcp-token server=ENVVAR`)。
 *   命中则优先用 map 指定的 env 名;未命中走 `FORGEAX_MCP_TOKEN_<SERVER>` → `FORGEAX_MCP_TOKEN`。
 */
export function makeEnvTokenProvider(map?: Record<string, string>): TokenProvider {
  return (server: string): string | undefined => {
    // lazy 读 process.env:每次调用(含 {refresh:true})都重读,拿到最新值。
    const env = process.env;
    const candidates: Array<string | undefined> = [
      map?.[server], // 1. 显式 server 映射的 env 名
      map?.['*'], // 2. 裸 --mcp-token 设的通配 env 名
      `FORGEAX_MCP_TOKEN_${serverUpper(server)}`, // 3. per-server 约定名
      'FORGEAX_MCP_TOKEN', // 4. 全局兜底
    ];
    for (const envName of candidates) {
      if (!envName) continue;
      const v = env[envName];
      if (v !== undefined && v.length > 0) return v;
    }
    return undefined;
  };
}
