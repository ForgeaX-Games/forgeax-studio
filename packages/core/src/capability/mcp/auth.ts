/**
 * MCP auth — bearer header 组装 + OAuth 401 刷新接缝（C2 / MCP bridge · M3）。
 *
 * core **不存 token、不跑 OAuth 流程**：它只
 *   ① 把 `McpAuthConfig.token`（或 host 注入的 `tokenProvider`）组装成
 *      `Authorization: Bearer …` header；
 *   ② 暴露一个最小 OAuth discovery 接缝（`discoverOAuth`），让 host 自己去驱动
 *      真正的授权码 / token 交换流程。
 *
 * 401 刷新的「重试一次」逻辑由 `connect.ts` 的 `FetchMCPClient` 编排——本文件只提供
 * 纯函数 / 接缝，不持有任何运行时状态。
 *
 * Boundary: 仅 import core-local 相对路径 + `node:`（实际无 `node:` 依赖）；
 *   `McpAuthConfig` 仅作 type-only import（M1 在 config.ts 并发新增，运行时不触达）。
 */
import type { McpAuthConfig } from './config';

/**
 * host 注入的 token 提供方。core 不存 token，只在需要时回调拿。
 *
 * @param server   MCP server 名（host 可据此选对应账号 / scope 的 token）。
 * @param opts.refresh  true 表示「上一个 token 被 401 拒了，请强制刷新一个新的」。
 * @param opts.signal   取消信号（透传调用方的 abort）。
 * @returns token 字符串；返回 `undefined`（或解析为 undefined 的 Promise）表示
 *   「没有可用 token」——此时不组装 Authorization header（fail-open）。
 */
export type TokenProvider = (
  server: string,
  opts?: { refresh?: boolean; signal?: AbortSignal },
) => Promise<string | undefined> | string | undefined;

/**
 * 把 auth 配置 / token 提供方组装成请求 headers。
 *
 * 解析优先级（bearer 模式）：
 *   1. `cfg.token` 显式配置 → 直接用；
 *   2. 否则若有 `tokenProvider` → 回调拿（传 server 名）；
 *   3. 都没拿到 token → 返回 `{}`（fail-open，不阻断无鉴权场景）。
 *
 * 当前仅实现 `type: 'bearer'`（以及缺省视为 bearer）；其余 type（如纯 oauth 由
 * host 自驱）也走同样的 token→Bearer 组装路径——core 不区分 token 的来源语义。
 *
 * @param cfg            已解析的 auth 配置（M1 在 config.ts 提供；可缺省）。
 * @param tokenProvider  host 注入的 token 回调（可缺省）。
 * @param server         MCP server 名，回调 tokenProvider 时透传。
 * @returns 待 merge 进 POST headers 的对象（无 token → `{}`）。
 */
export async function resolveAuthHeaders(
  cfg: McpAuthConfig | undefined,
  tokenProvider?: TokenProvider,
  server?: string,
): Promise<Record<string, string>> {
  // 1. 配置里写死的 token 优先。
  let token: string | undefined = cfg?.token;

  // 2. 没有写死 → 回调 host 拿。
  if (token === undefined && tokenProvider) {
    token = await tokenProvider(server ?? '');
  }

  // 3. 仍无 token → 不组装 header（fail-open）。
  if (token === undefined || token.length === 0) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * OAuth discovery 文档（`.well-known/oauth-authorization-server` 等）的最小形状。
 *
 * core 只关心拿到 `authorizationServer` / `tokenEndpoint` 给 host 自驱流程用；
 * 其余字段原样透出（index signature），不做强校验。
 */
export interface OAuthDiscovery {
  /** 授权服务器 base（RFC 8414 `authorization_server` / `issuer` 之一）。 */
  authorizationServer?: string;
  /** token endpoint（RFC 8414 `token_endpoint`）。 */
  tokenEndpoint?: string;
  /** 其余 discovery 字段原样透出。 */
  [k: string]: unknown;
}

/**
 * OAuth discovery 接缝：探测 server 的 well-known metadata，供 host 驱动授权流程。
 *
 * 行为：对 `baseUrl` 的 origin 依次试
 *   `<origin>/.well-known/oauth-authorization-server` →
 *   `<origin>/.well-known/oauth-protected-resource`，
 * 第一个成功（2xx + 可 JSON parse）的即归一化返回；任何失败（非 2xx / 网络错 /
 * JSON 坏 / URL 非法）都**静默返回 `null`**（fail-open，不抛）。
 *
 * core 仅做「发现」，不发起 token 交换——真正的 OAuth 流程由 host 拿到这份 metadata
 * 后自己跑。
 *
 * @param baseUrl    MCP server 的 url（用其 origin 拼 well-known 路径）。
 * @param fetchImpl  注入的 fetch（测试用假 fetch）。
 * @returns 归一化 discovery，或 `null`（发现失败 / 不支持）。
 */
export async function discoverOAuth(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<OAuthDiscovery | null> {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }

  const wellKnownPaths = [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
  ];

  for (const path of wellKnownPaths) {
    try {
      const res = await fetchImpl(`${origin}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      if (json === null || typeof json !== 'object') continue;
      return normalizeDiscovery(json);
    } catch {
      // 网络错 / JSON 坏 → 试下一个 well-known，全失败则 null。
      continue;
    }
  }
  return null;
}

/**
 * 把原始 well-known JSON 归一化成 `OAuthDiscovery`。
 * 兼容 RFC 8414 的 snake_case（`authorization_server` / `token_endpoint`）与
 * 已是 camelCase 的字段；原始键一并保留在 index signature 里。
 */
function normalizeDiscovery(raw: Record<string, unknown>): OAuthDiscovery {
  const out: OAuthDiscovery = { ...raw };
  const authServer =
    raw.authorizationServer ?? raw.authorization_server ?? raw.issuer;
  if (typeof authServer === 'string') out.authorizationServer = authServer;
  const tokenEndpoint = raw.tokenEndpoint ?? raw.token_endpoint;
  if (typeof tokenEndpoint === 'string') out.tokenEndpoint = tokenEndpoint;
  return out;
}
