import {
  createAssetWorkspace,
  createGatewayCapabilityAdapter,
  RunJournal,
  createTransportSecurityPolicy,
  createTransportService,
  parseTransportMessage,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
  type TransportResponse,
  type TransportService,
} from '@forgeax/editor/product';
import { createEvalChannel, gateway } from '@forgeax/editor/bridge';
import { executeLiveGameplay } from '@forgeax/editor/gameplay';

export interface EditorTransportSocket {
  readonly readyState: number;
  addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => void;
  send: (message: string) => void;
  close: () => void;
}

export interface StudioEditorTransportCarrierOptions {
  readonly url?: string;
  readonly socketFactory?: (url: string) => EditorTransportSocket;
  readonly service?: Pick<TransportService, 'handle'>;
  readonly reconnectDelayMs?: number;
  readonly role?: 'interactive' | 'managed';
}

export interface StudioEditorTransportCarrier {
  /** Resolves after the server hello has been answered with carrier ready. */
  readonly ready: Promise<void>;
  readonly dispose: () => void;
}

function editorTransportUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/editor/transport`;
}

function transportErrorResponse(request: Partial<TransportRequest>, code: string, hint: string): TransportResponse {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id: typeof request.id === 'string' ? request.id : 'invalid',
    correlationId: typeof request.correlationId === 'string' ? request.correlationId : 'invalid',
    error: {
      code,
      hint,
      retryable: false,
      recoveryActions: ['editor.discover'],
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Project Gateway-owned read models through the product query method. */
export function queryStudioEditor(params: unknown): unknown {
  const input = record(record(params).input);
  if (input.kind === 'world') {
    const withComponents = Array.isArray(input.with)
      ? input.with.filter((name): name is string => typeof name === 'string')
      : [];
    return gateway.buildQueryFn()({ with: withComponents });
  }
  if (input.kind === 'components') return { ok: true, components: gateway.listComponents() };
  if (input.kind === 'component' && typeof input.name === 'string') {
    return gateway.describeComponent(input.name);
  }
  if (input.kind !== undefined) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_QUERY_KIND',
        hint: `Unknown editor query kind '${String(input.kind)}'. Use 'world', 'components', or 'component'; omit kind for the document read model.`,
        retryable: false,
        recoveryActions: ['transport.describe'],
      },
    };
  }
  const scene = gateway.sceneReadModel();
  return {
    document: {
      revision: `scene:${scene.currentScene?.id ?? 'none'}:${scene.scenes.length}`,
      content: JSON.stringify(scene) ?? '{}',
    },
    selection: gateway.selectionReadModel(),
    dirty: gateway.hasPendingDiskSave(),
  };
}

/** Delegate to the typed bridge installed by the currently visible Editor viewport. */
export function executeStudioGameplay(input: unknown): unknown | Promise<unknown> {
  return executeLiveGameplay(input);
}

export function createStudioEditorTransportService(
  scope: string,
): Pick<TransportService, 'handle'> {
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => gateway.listOps(),
    dispatch: (command, origin) => gateway.dispatch(command, origin),
    operationRuns: {
      get: (requestId) => gateway.getOperationRunResult(requestId),
      wait: (requestId) => gateway.waitOperationRun(requestId),
      subscribe: (requestId, listener) => gateway.subscribeOperationRun(requestId, listener),
      cancel: (requestId) => gateway.cancelOperationRun(requestId),
      retry: (requestId, retryRequestId, actor) => {
        const result = gateway.retryOperationRun(requestId, retryRequestId, actor.kind === 'human' ? 'human' : 'ai');
        if (!result.ok) return result as never;
        const value = result as unknown as Record<string, unknown>;
        const run = value.operationRun ?? (value.result as Record<string, unknown> | undefined)?.operationRun;
        return run && typeof run === 'object'
          ? { ok: true as const, runId: (run as { runId: string }).runId, reused: false, run: run as never }
          : { ok: false as const, error: { code: 'operation-run-missing', hint: 'The Gateway did not return the retried operation run.', retryable: true, recoveryActions: ['run.get'] } };
      },
    },
  });
  const workspace = createAssetWorkspace();
  const scriptChannel = createEvalChannel(gateway);
  const syncAssets = (): void => {
    const catalog = gateway.assetCatalog();
    workspace.reconcile({
      resourceRevision: `gateway:${catalog.map((asset) => `${asset.guid}:${asset.name ?? ''}:${asset.sourcePath ?? ''}`).join('|')}`,
      subjects: catalog.map((asset) => ({
        id: `asset:${asset.guid}`,
        kind: 'internal-asset' as const,
        provenance: { owner: 'editor' as const, source: 'gateway' },
        resourceId: asset.guid,
        path: asset.sourcePath ?? asset.guid,
        name: asset.name ?? asset.guid,
        capabilities: {
          canImport: false,
          canMove: true,
          canDelete: true,
          canPreflight: true,
        },
      })),
      relations: [],
      issues: [],
    });
  };
  const service = createTransportService({
    product: adapter.product(),
    journal: new RunJournal({ scope }),
    operationRuns: adapter.saveOperationRuns,
    assetWorkspace: workspace,
    security: createTransportSecurityPolicy({
      version: TRANSPORT_PROTOCOL_VERSION,
      scopes: [scope],
      permissions: { 'script.execute': 'execute' },
    }),
    evaluate: async (code) => {
      const result = scriptChannel.eval(code);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            ...result.error,
            retryable: false,
            recoveryActions: ['transport.describe'],
          },
        };
      }
      return { ok: true, value: await result.value };
    },
    query: queryStudioEditor,
    gameplay: executeStudioGameplay,
  });
  return {
    handle: async (request) => {
      syncAssets();
      return service.handle(request);
    },
  };
}

/**
 * Register the current Studio page as the Editor transport carrier.
 *
 * The page remains the only owner of the live Gateway and editor realm. This
 * socket carries versioned requests/responses, including operation-scope scripts
 * backed by the same Gateway. It does not expose raw world scope or create a
 * second document/world store.
 */
export function connectStudioEditorTransport(
  slug: string,
  options: StudioEditorTransportCarrierOptions = {},
): StudioEditorTransportCarrier {
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const socketUrl = options.url ?? editorTransportUrl();
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;
  let currentService = options.service;
  const serviceForRequest = (): Pick<TransportService, 'handle'> => {
    if (options.service !== undefined) return options.service;
    currentService ??= createStudioEditorTransportService(`game:${slug}`);
    return currentService;
  };
  let disposed = false;
  let socket: EditorTransportSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let registered = false;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });

  const send = (target: EditorTransportSocket, value: unknown): void => {
    if (target.readyState === 1) target.send(JSON.stringify(value));
  };

  const presence = () => ({
    visibility: typeof document === 'undefined' || document.visibilityState === 'visible' ? 'visible' as const : 'hidden' as const,
    focused: typeof document === 'undefined' || document.hasFocus(),
    engaged: typeof navigator === 'undefined'
      || (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation?.hasBeenActive === true,
  });

  const publishPresence = (): void => {
    if (socket === null || !registered) return;
    send(socket, { type: 'editor-transport/presence', ...presence() });
  };

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', publishPresence);
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', publishPresence);
    window.addEventListener('blur', publishPresence);
    window.addEventListener('pointerdown', publishPresence, true);
    window.addEventListener('keydown', publishPresence, true);
  }

  const connect = (): void => {
    if (disposed) return;
    let next: EditorTransportSocket;
    try { next = socketFactory(socketUrl); } catch {
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
      return;
    }
    socket = next;
    next.addEventListener('close', () => {
      if (disposed || socket !== next) return;
      registered = false;
      socket = null;
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    });
    next.addEventListener('message', (event) => {
      if (disposed || socket !== next || typeof event.data !== 'string') return;
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.type === 'editor-transport/hello') {
        send(next, {
          type: 'editor-transport/ready',
          version: TRANSPORT_PROTOCOL_VERSION,
          role: options.role ?? 'interactive',
          scope: `game:${slug}`,
          ...presence(),
        });
        registered = true;
        markReady();
        return;
      }
      if (message.type !== 'editor-transport/request' || !message.request) return;
      const parsed = parseTransportMessage(message.request);
      if (!parsed.ok || !('method' in parsed.value)) {
        send(next, {
          type: 'editor-transport/response',
          response: transportErrorResponse(
            parsed.ok ? {} : (message.request as Partial<TransportRequest>),
            parsed.ok ? 'protocol-invalid-message' : parsed.error.code,
            parsed.ok ? 'The Editor carrier received a response instead of a request.' : parsed.error.hint,
          ),
        });
        return;
      }
      void serviceForRequest().handle(parsed.value).then((response) => {
        send(next, { type: 'editor-transport/response', response });
      }).catch((error: unknown) => {
        send(next, {
          type: 'editor-transport/response',
          response: transportErrorResponse(parsed.value, 'editor-carrier-exception', error instanceof Error ? error.message : 'The Editor carrier failed to handle the request.'),
        });
      });
    });
  };

  connect();

  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', publishPresence);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', publishPresence);
        window.removeEventListener('blur', publishPresence);
        window.removeEventListener('pointerdown', publishPresence, true);
        window.removeEventListener('keydown', publishPresence, true);
      }
      socket?.close();
      socket = null;
    },
  };
}

/** Classify the page so the server can prefer a user-visible Studio page while
 * retaining a managed renderer as the UI-free fallback. */
export function studioEditorTransportRole(search: string): 'interactive' | 'managed' {
  const params = new URLSearchParams(search);
  return params.has('runtimeId') && params.has('ownershipChallenge') ? 'managed' : 'interactive';
}
