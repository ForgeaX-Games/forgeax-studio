import {
  parseTransportMessage,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
  type TransportResponse,
} from '@forgeax/editor/product';

type Permission = 'read' | 'write' | 'execute';

export interface EditorTransportClientOptions {
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly fetcher?: typeof globalThis.fetch;
  readonly scope: string;
  readonly actor: Readonly<{ id: string; kind: string }>;
  readonly sessionId: string;
  readonly permission?: Permission;
  readonly idFactory?: () => string;
  readonly correlationIdFactory?: () => string;
}

export interface EditorTransportRequestOptions {
  readonly idempotencyKey?: string;
  readonly permission?: Permission;
  readonly signal?: AbortSignal;
}

export interface EditorDispatchOptions extends EditorTransportRequestOptions {
  readonly idempotencyKey: string;
}

export interface EditorTransportClient {
  readonly request: (
    method: string,
    params?: unknown,
    options?: EditorTransportRequestOptions,
  ) => Promise<TransportResponse>;
  readonly discover: () => Promise<TransportResponse>;
  readonly preflight: (input: unknown) => Promise<TransportResponse>;
  readonly dispatch: (
    operationId: string,
    input: unknown,
    options: string | EditorDispatchOptions,
  ) => Promise<TransportResponse>;
  readonly getRun: (runId: string) => Promise<TransportResponse>;
  readonly assetSnapshot: () => Promise<TransportResponse>;
  readonly listRuns: () => Promise<TransportResponse>;
  readonly query: (input?: unknown) => Promise<TransportResponse>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function makeId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function paramsRecord(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function responseError(
  id: string,
  correlationId: string,
  code: string,
  recoveryActions: readonly string[],
  hint: string,
): TransportResponse {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId,
    error: { code, hint, retryable: true, recoveryActions },
  };
}

function parseResponse(
  value: unknown,
  id: string,
  correlationId: string,
): TransportResponse {
  const parsed = parseTransportMessage(value);
  if (!parsed.ok) {
    return responseError(id, correlationId, parsed.error.code, parsed.error.recoveryActions, parsed.error.hint);
  }
  if ('method' in parsed.value) {
    return responseError(id, correlationId, 'protocol-invalid-message', ['request.retry'], 'The transport returned a request instead of a response.');
  }
  return parsed.value;
}

function dispatchOptions(options: string | EditorDispatchOptions): EditorDispatchOptions {
  return typeof options === 'string' ? { idempotencyKey: options } : options;
}

/**
 * Thin browser client for the public Editor transport contract.
 *
 * This object owns request metadata only. Capability discovery, product facts,
 * run history, and runtime lifecycle remain owned by the Editor product and
 * the Studio carrier supervisor respectively.
 */
export function createEditorTransportClient(
  options: EditorTransportClientOptions,
): EditorTransportClient {
  const endpoint = options.endpoint ?? '/api/editor/transport';
  const fetcher = options.fetch ?? options.fetcher ?? globalThis.fetch.bind(globalThis);
  const idFactory = options.idFactory ?? (() => makeId('editor-request'));
  const correlationIdFactory = options.correlationIdFactory ?? (() => makeId('editor-correlation'));
  const scope = options.scope.trim();
  if (scope === '') throw new Error('Editor transport client scope must not be empty.');
  if (options.sessionId.trim() === '') throw new Error('Editor transport client sessionId must not be empty.');

  const request = async (
    method: string,
    params: unknown = {},
    requestOptions: EditorTransportRequestOptions = {},
  ): Promise<TransportResponse> => {
    const id = idFactory();
    const correlationId = correlationIdFactory();
    const idempotencyKey = requestOptions.idempotencyKey ?? `${scope}:${method}:${id}`;
    const body: TransportRequest = {
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id,
      correlationId,
      method,
      params: {
        ...paramsRecord(params),
        scope,
        actor: options.actor,
        sessionId: options.sessionId,
        permission: requestOptions.permission ?? options.permission ?? 'read',
        idempotencyKey,
      },
    };

    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestOptions.signal,
      });
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return responseError(id, correlationId, 'protocol-invalid-message', ['request.retry'], 'The transport response was not valid JSON.');
      }
      return parseResponse(value, id, correlationId);
    } catch {
      return responseError(id, correlationId, 'transport-unavailable', ['request.retry', 'editor.discover'], 'The Editor transport endpoint is unavailable.');
    }
  };

  return Object.freeze({
    request,
    discover: () => request('discover', {}, { permission: 'read' }),
    preflight: (input: unknown) => request('asset.preflight', input, { permission: 'read' }),
    dispatch: (operationId: string, input: unknown, value: string | EditorDispatchOptions) => {
      const dispatch = dispatchOptions(value);
      return request('run.dispatch', {
        operationId,
        input,
      }, { ...dispatch, permission: dispatch.permission ?? 'execute' });
    },
    getRun: (runId: string) => request('run.get', { runId }, { permission: 'read' }),
    assetSnapshot: () => request('asset.snapshot', {}, { permission: 'read' }),
    listRuns: () => request('run.list', { limit: 20 }, { permission: 'read' }),
    query: (input?: unknown) => request('query', { input }, { permission: 'read' }),
  });
}
