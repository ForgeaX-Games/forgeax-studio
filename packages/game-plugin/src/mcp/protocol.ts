/**
 * Minimal MCP server protocol — pure dispatch, no transport.
 *
 * Hand-written newline-framed JSON-RPC rather than the official SDK, matching the
 * three sibling implementations already in this monorepo (orchestrator's
 * `forgeax-tools-server.mjs` / `permission-server.mjs`, cli's `mcp-serve.ts`).
 * This module is the intended convergence point for all four (plan M5).
 *
 * `dispatch` is a pure async function over a spec, so the whole protocol surface is
 * testable without spawning a process or touching stdio.
 */

/** A content block in a tool result. Mirrors the MCP `Content` union we actually emit. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** What a tool's `run` may return. Plain values are wrapped as a single text block. */
export type ToolReturn = string | McpContent[] | Record<string, unknown> | undefined;

export interface McpTool<Ctx> {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool arguments. */
  readonly inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: Ctx): Promise<ToolReturn> | ToolReturn;
}

export interface McpResource<Ctx> {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  read(ctx: Ctx): Promise<string> | string;
}

export interface McpServerSpec<Ctx> {
  readonly serverInfo: { name: string; version: string };
  /**
   * Capability routing hint returned from `initialize`. Clients surface this to the
   * model before any tool call, so it is the cheapest place to teach tool selection.
   */
  readonly instructions?: string;
  readonly tools: readonly McpTool<Ctx>[];
  readonly resources: readonly McpResource<Ctx>[];
  /** Rebuilt per request so long-lived servers never serve stale project state. */
  buildContext(): Promise<Ctx> | Ctx;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse = Record<string, unknown>;

/** MCP version implemented by this dispatcher. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function textResult(text: string, isError = false): JsonRpcResponse {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] };
}

/** Normalize whatever a tool returned into an MCP `CallToolResult`. */
function toToolResult(out: ToolReturn): JsonRpcResponse {
  if (out === undefined) return textResult('');
  if (typeof out === 'string') return textResult(out);
  if (Array.isArray(out)) return { content: out };
  return textResult(JSON.stringify(out));
}

/**
 * Structured `not_found` for an unknown tool, returned as an `isError` result rather
 * than a JSON-RPC error so the model reads a clean miss instead of a protocol fault.
 * Listing the live tool names stops the model retrying a hallucinated name.
 */
function notFound(name: string, available: readonly string[]): JsonRpcResponse {
  const hint = available.length
    ? `Available tools: ${available.join(', ')}.`
    : 'This server exposes no tools right now.';
  return {
    isError: true,
    content: [{ type: 'text', text: `not_found: tool ${JSON.stringify(name)} is not exposed. ${hint}` }],
    structuredContent: { code: 'not_found', tool: name, availableTools: available },
  };
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns the response object to write back, or `null` for notifications (which must
 * not be answered) and for unknown notifications carrying no id.
 */
export async function dispatch<Ctx>(
  spec: McpServerSpec<Ctx>,
  msg: JsonRpcMessage,
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = msg;

  // Every JSON-RPC message without an id is a notification, regardless of its
  // method name. Notifications must never receive a response.
  if (id == null) return null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: spec.serverInfo,
        ...(spec.instructions ? { instructions: spec.instructions } : {}),
      },
    };
  }

  // Keep the explicit method check as documentation for the common MCP case.
  if (method?.startsWith('notifications/')) return null;

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: spec.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  if (method === 'resources/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resources: spec.resources.map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
      },
    };
  }

  if (method === 'resources/read') {
    const uri = typeof params?.uri === 'string' ? params.uri : '';
    const resource = spec.resources.find((r) => r.uri === uri);
    if (!resource) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: INTERNAL_ERROR, message: `unknown resource: ${uri}` },
      };
    }
    try {
      const ctx = await spec.buildContext();
      const text = await resource.read(ctx);
      return {
        jsonrpc: '2.0',
        id,
        result: { contents: [{ uri, mimeType: resource.mimeType, text }] },
      };
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: INTERNAL_ERROR, message: `resource read failed: ${errorMessage(e)}` },
      };
    }
  }

  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
    const tool = spec.tools.find((t) => t.name === name);
    if (!tool) {
      return { jsonrpc: '2.0', id, result: notFound(name, spec.tools.map((t) => t.name)) };
    }
    try {
      const ctx = await spec.buildContext();
      const out = await tool.run(args, ctx);
      return { jsonrpc: '2.0', id, result: toToolResult(out) };
    } catch (e) {
      // Business failures surface as isError results, not protocol errors, so the
      // model can read and recover from them instead of seeing a transport fault.
      return { jsonrpc: '2.0', id, result: textResult(`error: ${errorMessage(e)}`, true) };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
