/**
 * MCP server config parser — settings 兼容 (C2 / MCP bridge).
 *
 * 解析 `{ "mcpServers": { "<name>": <config> } }` 形状，config 是一个
 * union：
 *   - stdio: `{ type?:"stdio", command, args?, env? }`（`type` 可省 —— 向后兼容）
 *   - sse:   `{ type:"sse",  url, headers? }`
 *   - http:  `{ type:"http", url, headers? }`
 *   - ws:    `{ type:"ws",   url }`
 *   - sdk:   `{ type:"sdk",  name }`
 *
 * 本文件**不引外部依赖**（不 import zod / MCP SDK）：纯手写校验，只 import
 * core-local 相对路径与 `node:`。env 变量展开 `${VAR}` / `${VAR:-default}` 可选,
 * 通过注入 env source 完成，core 不直接读
 * `process.env`（host 可注入）。
 *
 * Boundary: 仅 import core-local。
 */

// ─── config union ────────────────────────────────────────────────

/**
 * MCP server 鉴权配置（中立数据形状）。
 *
 * 在 config 层定义这个数据 shape，是为了让 M3（真正消费 auth 去建连/取 token）
 * 不必反向依赖鉴权实现 —— 解析期只认这份纯数据契约，避免循环依赖。
 *   - `type`: `'bearer'`（静态 / env token）或 `'oauth'`（OAuth 流程）。
 *   - `token`: 直接给定的静态 token（bearer）。
 *   - `tokenEnv`: token 所在的 env 变量名（由 host 在建连期读取展开）。
 *   - 其余键透传（`[k:string]:unknown`），给 M3 扩展 oauth 字段留口。
 */
export interface McpAuthConfig {
  type: 'bearer' | 'oauth';
  token?: string;
  tokenEnv?: string;
  [k: string]: unknown;
}

/**
 * 各 server config 共享的可选治理字段（defer 注入策略 + 鉴权）。
 *
 *   - `defer_loading`: 是否延迟加载该 server 的工具（M1 注入治理策略 / ToolSearch
 *     先发现再上线）。缺省（undefined）= 交由全局默认策略（auto / defer）裁决。
 *   - `auth`: 见 {@link McpAuthConfig}（M3 消费）。
 *
 * 各具体 server config interface 都 extends 它,保持 union 形状不变。
 */
export interface McpServerConfigCommon {
  defer_loading?: boolean;
  auth?: McpAuthConfig;
}

/** stdio server：spawn 一个子进程（command + args + env）。`type` 可省。 */
export interface McpStdioServerConfig extends McpServerConfigCommon {
  type?: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** SSE server：HTTP + Server-Sent-Events 流式（url + 可选 headers）。 */
export interface McpSSEServerConfig extends McpServerConfigCommon {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

/** Streamable-HTTP server：JSON-RPC over HTTP POST（url + 可选 headers）。 */
export interface McpHTTPServerConfig extends McpServerConfigCommon {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

/** WebSocket server（url）。 */
export interface McpWebSocketServerConfig extends McpServerConfigCommon {
  type: 'ws';
  url: string;
}

/** SDK server：进程内 SDK 注册（name）。 */
export interface McpSdkServerConfig extends McpServerConfigCommon {
  type: 'sdk';
  name: string;
}

/** MCP server config union。 */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHTTPServerConfig
  | McpWebSocketServerConfig
  | McpSdkServerConfig;

/** 解析出的单个 server 条目。 */
export interface ParsedMcpServer {
  name: string;
  config: McpServerConfig;
}

/** 解析结果：成功的 server 列表 + 逐条错误（fail-soft，单条坏不连累其它）。 */
export interface ParseMcpConfigResult {
  servers: ParsedMcpServer[];
  errors: string[];
}

/** parseMcpConfig 选项。 */
export interface ParseMcpConfigOptions {
  /**
   * env 源，用于 stdio `env` 与所有 `url`/`headers`/`args` 里的 `${VAR}` 展开。
   * 不传则**不做**展开（原样保留 `${VAR}`）。host 想展开就注入 `process.env`。
   */
  env?: Record<string, string | undefined>;
}

// ─── env 展开 ────────────────────────────────────────

/**
 * 展开字符串里的 `${VAR}` / `${VAR:-default}`。
 *   - 命中 env → 用其值。
 *   - 未命中但有 `:-default` → 用 default。
 *   - 未命中且无 default → 原样保留 `${VAR}`，并记入 missing。
 */
export function expandEnvVarsInString(
  value: string,
  env: Record<string, string | undefined>,
): { expanded: string; missingVars: string[] } {
  const missingVars: string[] = [];
  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent: string) => {
    const sepIdx = varContent.indexOf(':-');
    const varName = sepIdx >= 0 ? varContent.slice(0, sepIdx) : varContent;
    const defaultValue = sepIdx >= 0 ? varContent.slice(sepIdx + 2) : undefined;
    const envValue = env[varName];
    if (envValue !== undefined) return envValue;
    if (defaultValue !== undefined) return defaultValue;
    missingVars.push(varName);
    return match;
  });
  return { expanded, missingVars };
}

// ─── 小工具 ────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

function expandString(
  value: string,
  env: Record<string, string | undefined> | undefined,
): string {
  if (!env) return value;
  return expandEnvVarsInString(value, env).expanded;
}

function expandStringRecord(
  rec: Record<string, string>,
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (!env) return rec;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandString(v, env);
  return out;
}

// ─── 单条 server 校验 ──────────────────────────────────────────────────────────

/**
 * 校验并提取共享治理字段（`defer_loading` / `auth`），把它们 fail-soft 地拼到
 * 已归一化的 config 上。校验规则：
 *   - `defer_loading` 若存在必须是 boolean，否则抛 Error（进 errors[]）。
 *   - `auth` 若存在必须是对象且带 string `type`，否则抛 Error（进 errors[]）。
 * 校验通过则原样挂上（round-trip），缺省则不挂（保持 union 干净）。
 *
 * `auth.tokenEnv`(M3):若设了 `tokenEnv` 且**未**显式给 `token`,则在建连期(此处)
 * 从注入的 `env` 把 `token = env[tokenEnv]` 解析出来。显式 `token` 优先,tokenEnv
 * 不覆盖它。无 env 注入则不解析(原样保留 tokenEnv,运行时由 host 自处理)。
 */
function applyCommonFields<C extends McpServerConfig>(
  name: string,
  raw: Record<string, unknown>,
  cfg: C,
  env: Record<string, string | undefined> | undefined,
): C {
  if (raw.defer_loading !== undefined) {
    if (typeof raw.defer_loading !== 'boolean') {
      throw new Error(`server "${name}": "defer_loading" must be a boolean`);
    }
    (cfg as McpServerConfigCommon).defer_loading = raw.defer_loading;
  }
  if (raw.auth !== undefined) {
    if (!isPlainObject(raw.auth) || typeof raw.auth.type !== 'string') {
      throw new Error(`server "${name}": "auth" must be an object with a string "type"`);
    }
    const auth = { ...(raw.auth as McpAuthConfig) };
    // 显式 token 里的 `${VAR}` 展开(对齐 url/headers 的 env 展开)。
    if (typeof auth.token === 'string') {
      auth.token = expandString(auth.token, env);
    }
    // tokenEnv → token 解析:仅当未显式给 token 且有 env 注入时。显式 token 必胜。
    if (auth.token === undefined && typeof auth.tokenEnv === 'string' && env) {
      const resolved = env[auth.tokenEnv];
      if (resolved !== undefined) auth.token = resolved;
    }
    (cfg as McpServerConfigCommon).auth = auth;
  }
  return cfg;
}

/**
 * 校验并归一化单个 server config。返回归一化后的 config，或抛 Error（被
 * parseMcpConfig 收成 errors 条目）。`type` 省略 → 视为 stdio（向后兼容）。
 */
function parseOneServer(
  name: string,
  raw: unknown,
  env: Record<string, string | undefined> | undefined,
): McpServerConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`server "${name}": config must be an object`);
  }
  const type = raw.type ?? 'stdio';

  switch (type) {
    case 'stdio': {
      if (typeof raw.command !== 'string' || raw.command.length === 0) {
        throw new Error(`server "${name}": stdio config requires non-empty "command"`);
      }
      if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string'))) {
        throw new Error(`server "${name}": "args" must be a string array`);
      }
      if (raw.env !== undefined && !isStringRecord(raw.env)) {
        throw new Error(`server "${name}": "env" must be a string→string record`);
      }
      const args = (raw.args as string[] | undefined) ?? [];
      const cfg: McpStdioServerConfig = {
        type: 'stdio',
        command: expandString(raw.command, env),
        args: args.map((a) => expandString(a, env)),
      };
      if (raw.env !== undefined) {
        cfg.env = expandStringRecord(raw.env, env);
      }
      return applyCommonFields(name, raw, cfg, env);
    }
    case 'sse':
    case 'http': {
      if (typeof raw.url !== 'string' || raw.url.length === 0) {
        throw new Error(`server "${name}": ${type} config requires non-empty "url"`);
      }
      if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
        throw new Error(`server "${name}": "headers" must be a string→string record`);
      }
      const cfg: McpSSEServerConfig | McpHTTPServerConfig = {
        type: type as 'sse' | 'http',
        url: expandString(raw.url, env),
      };
      if (raw.headers !== undefined) {
        cfg.headers = expandStringRecord(raw.headers, env);
      }
      return applyCommonFields(name, raw, cfg, env);
    }
    case 'ws': {
      if (typeof raw.url !== 'string' || raw.url.length === 0) {
        throw new Error(`server "${name}": ws config requires non-empty "url"`);
      }
      return applyCommonFields(name, raw, { type: 'ws', url: expandString(raw.url, env) }, env);
    }
    case 'sdk': {
      if (typeof raw.name !== 'string' || raw.name.length === 0) {
        throw new Error(`server "${name}": sdk config requires non-empty "name"`);
      }
      return applyCommonFields(name, raw, { type: 'sdk', name: raw.name }, env);
    }
    default:
      throw new Error(`server "${name}": unknown type "${String(type)}"`);
  }
}

// ─── 顶层解析 ──────────────────────────────────────────────────────────────────

/**
 * 解析 MCP 配置：`{ "mcpServers": { "<name>": <config> } }`。
 *
 * `raw` 可以是 JSON 字符串或已 parse 的对象。逐 server fail-soft：单条校验失败
 * 进 `errors`，其余继续，便于一份配置里坏一条不全崩。
 *
 * @param raw   `.mcp.json` 内容（string 或 object）。
 * @param opts  注入 env source（启用 `${VAR}` 展开）。
 */
export function parseMcpConfig(
  raw: unknown,
  opts: ParseMcpConfigOptions = {},
): ParseMcpConfigResult {
  const errors: string[] = [];
  const servers: ParsedMcpServer[] = [];

  let root: unknown = raw;
  if (typeof raw === 'string') {
    try {
      root = JSON.parse(raw);
    } catch (e) {
      return { servers, errors: [`invalid JSON: ${(e as Error).message}`] };
    }
  }

  if (!isPlainObject(root)) {
    return { servers, errors: ['config root must be an object'] };
  }

  const mcpServers = root.mcpServers;
  if (!isPlainObject(mcpServers)) {
    return { servers, errors: ['missing or invalid "mcpServers" object'] };
  }

  for (const [name, cfgRaw] of Object.entries(mcpServers)) {
    try {
      const config = parseOneServer(name, cfgRaw, opts.env);
      servers.push({ name, config });
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  return { servers, errors };
}
