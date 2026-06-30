/**
 * MCP server→client requests (M4 / MCP bridge).
 *
 * 背景:MCP 是**双向** JSON-RPC —— 除了 client→server(tools/list、tools/call),
 * server 也可以反向向 client 发**请求**(带 id + method 的帧),典型三类:
 *   - `elicitation/create` —— server 想向用户索取额外输入(elicitation)。
 *   - `sampling/createMessage` —— server 想借 client 的 LLM 做一次采样(sampling)。
 *   - `roots/list` —— server 想知道 client 暴露的文件系统根(roots)。
 *
 * core 不实现这些能力的**业务**(没有 LLM、没有 UI、没有 fs)—— 它只做**纯编排**:
 * 按 method 把请求路由到 host 注入的 handler(`ServerRequestDeps`),把 handler 的
 * 返回包成 JSON-RPC `result`,异常 / 未知 method / 缺 handler 则回标准 JSON-RPC
 * 错误码。真实业务(弹窗征询、调 LLM、读 fs)由 host 在注入的 handler 里做。
 *
 * Boundary: 仅 core-local + node:,无任何 IO(IO 都在注入的 deps 里)。
 *
 * 形状对齐 MCP spec 的 client 能力反向请求:
 *   - elicitation/create → result 即 handler 返回的对象(ElicitResult)。
 *   - sampling/createMessage → result 即 handler 返回的对象(CreateMessageResult)。
 *   - roots/list → result 包成 `{ roots: <deps.roots()> }`(ListRootsResult)。
 */

/** JSON-RPC 标准错误码:方法未找到。 */
const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** JSON-RPC 标准错误码:内部错误(handler 抛异常时用)。 */
const JSON_RPC_INTERNAL_ERROR = -32603;

/** server→client 反向请求的 method 名(对齐 MCP spec)。 */
export const SERVER_REQUEST_ELICITATION_CREATE = 'elicitation/create';
export const SERVER_REQUEST_SAMPLING_CREATE_MESSAGE = 'sampling/createMessage';
export const SERVER_REQUEST_ROOTS_LIST = 'roots/list';

/**
 * host 注入的 server→client 请求处理器(全部可选)。core 只在收到对应 method 的
 * 反向请求时调用;未注入对应 handler → 该 method 回 method-not-found 错误。
 *
 *   - `elicit(params, signal?)`: 处理 `elicitation/create`(向用户索取输入)。返回
 *     值原样作为 JSON-RPC `result`。
 *   - `sampling(params, signal?)`: 处理 `sampling/createMessage`(借 client 的 LLM
 *     做一次采样)。返回值原样作为 `result`。
 *   - `roots()`: 处理 `roots/list`(列出 client 暴露的文件系统根)。返回值被包成
 *     `{ roots: <返回值> }` 作为 `result`(对齐 MCP `ListRootsResult` 形状)。
 */
export interface ServerRequestDeps {
  elicit?: (params: unknown, signal?: AbortSignal) => Promise<unknown> | unknown;
  sampling?: (params: unknown, signal?: AbortSignal) => Promise<unknown> | unknown;
  roots?: () => Promise<unknown> | unknown;
}

/** server→client 反向请求帧(带 id + method 的 JSON-RPC 请求)。 */
export interface ServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 错误对象(最小子集)。 */
interface JsonRpcError {
  code: number;
  message: string;
}

/** handleServerRequest 的返回:JSON-RPC 响应(result 与 error 二选一)。 */
export interface ServerRequestResponse {
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * 处理一条 server→client 反向请求,返回应发回 server 的 JSON-RPC 响应。
 *
 * 路由:
 *   - `elicitation/create`   → `deps.elicit(params, signal)`,返回值作 `result`。
 *   - `sampling/createMessage` → `deps.sampling(params, signal)`,返回值作 `result`。
 *   - `roots/list`           → `{ roots: await deps.roots() }`。
 *
 * 错误:
 *   - 未知 method 或对应 handler 未注入 → `{ code: -32601, message: 'method not
 *     found: <method>' }`。
 *   - handler 抛异常 → `{ code: -32603, message: <err.message> }`。
 *
 * 纯编排,无 IO —— 所有副作用都在注入的 deps handler 内。
 *
 * @param req  server 发来的反向请求(含 id / method / params)。
 * @param deps host 注入的 handler 集合。
 * @param signal 可选取消信号,透传给 elicit / sampling(roots 无需)。
 */
export async function handleServerRequest(
  req: ServerRequest,
  deps: ServerRequestDeps,
  signal?: AbortSignal,
): Promise<ServerRequestResponse> {
  const { id, method, params } = req;
  try {
    switch (method) {
      case SERVER_REQUEST_ELICITATION_CREATE: {
        if (!deps.elicit) return methodNotFound(id, method);
        const result = await deps.elicit(params, signal);
        return { id, result };
      }
      case SERVER_REQUEST_SAMPLING_CREATE_MESSAGE: {
        if (!deps.sampling) return methodNotFound(id, method);
        const result = await deps.sampling(params, signal);
        return { id, result };
      }
      case SERVER_REQUEST_ROOTS_LIST: {
        if (!deps.roots) return methodNotFound(id, method);
        const roots = await deps.roots();
        return { id, result: { roots } };
      }
      default:
        return methodNotFound(id, method);
    }
  } catch (e: unknown) {
    return {
      id,
      error: {
        code: JSON_RPC_INTERNAL_ERROR,
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

/** 构造 method-not-found(-32601)错误响应。 */
function methodNotFound(id: number | string, method: string): ServerRequestResponse {
  return {
    id,
    error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `method not found: ${method}` },
  };
}
