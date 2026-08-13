import { expect, test } from 'bun:test';
import {
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
} from '@forgeax/editor/product';
import { registerSessionApplier } from '@forgeax/editor-core';
import {
  connectStudioEditorTransport,
  createStudioEditorTransportService,
  studioEditorTransportRole,
  type EditorTransportSocket,
} from './carrier';
import { createGameplayCarrierBridge, registerLiveGameplayBridge } from '@forgeax/editor/gameplay';

class FakeSocket implements EditorTransportSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  readyState = 1;

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }

  send(message: string): void { this.sent.push(message); }
  close(): void { this.readyState = 3; }

  async disconnect(): Promise<void> {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) await listener({});
  }

  async receive(message: unknown): Promise<void> {
    for (const listener of this.listeners.get('message') ?? []) await listener({ data: JSON.stringify(message) });
  }
}

function request(id: string, method: string, params: unknown): TransportRequest {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId: `carrier-${id}`,
    scope: 'game:spin-cube',
    method,
    params,
  };
}

test('Studio editor carrier answers typed requests on the registered socket', async () => {
  const socket = new FakeSocket();
  const carrier = connectStudioEditorTransport('spin-cube', {
    url: 'ws://studio.test/ws/editor/transport',
    socketFactory: () => socket,
    service: {
      async handle(request) {
        return {
          jsonrpc: '2.0',
          version: TRANSPORT_PROTOCOL_VERSION,
          id: request.id,
          correlationId: request.correlationId,
          result: { method: request.method },
        };
      },
    },
  });

  let ready = false;
  void carrier.ready.then(() => { ready = true; });
  await Promise.resolve();
  expect(ready).toBe(false);

  await socket.receive({ type: 'editor-transport/hello', version: TRANSPORT_PROTOCOL_VERSION });
  await carrier.ready;
  expect(ready).toBe(true);
  expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toMatchObject({
    type: 'editor-transport/ready',
    role: 'interactive',
    scope: 'game:spin-cube',
  });

  await socket.receive({
    type: 'editor-transport/request',
    request: {
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id: 'request-1',
      correlationId: 'correlation-1',
      scope: 'game:spin-cube',
      method: 'discover',
      params: {},
    },
  });
  expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toMatchObject({
    type: 'editor-transport/response',
    response: {
      id: 'request-1',
      correlationId: 'correlation-1',
      result: { method: 'discover' },
    },
  });

  carrier.dispose();
  expect(socket.readyState).toBe(3);
});

test('Studio editor carrier publishes gameplay bridge readiness transitions', async () => {
  const host = globalThis as typeof globalThis & { __forgeax_editor_gameplay?: unknown };
  const previousGameplay = host.__forgeax_editor_gameplay; host.__forgeax_editor_gameplay = undefined;
  const socket = new FakeSocket();
  const carrier = connectStudioEditorTransport('spin-cube', { url: 'ws://studio.test/ws/editor/transport', socketFactory: () => socket, service: { handle: async (value) => value as never } });
  try {
    await socket.receive({ type: 'editor-transport/hello', version: TRANSPORT_PROTOCOL_VERSION });
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toMatchObject({ type: 'editor-transport/ready', capabilities: { gameplay: false } });
    for (const gameplay of [true, false]) {
      host.__forgeax_editor_gameplay = gameplay ? {} : undefined;
      await Bun.sleep(110);
      expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toMatchObject({ type: 'editor-transport/presence', capabilities: { gameplay } });
    }
  } finally {
    carrier.dispose(); host.__forgeax_editor_gameplay = previousGameplay;
  }
});

test('Studio editor carrier reconnects after the server socket closes', async () => {
  const sockets: FakeSocket[] = [];
  const carrier = connectStudioEditorTransport('spin-cube', {
    url: 'ws://studio.test/ws/editor/transport',
    reconnectDelayMs: 0,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    service: { handle: async (value) => value as never },
  });

  expect(sockets).toHaveLength(1);
  await sockets[0]!.receive({ type: 'editor-transport/hello', version: TRANSPORT_PROTOCOL_VERSION });
  await carrier.ready;
  await sockets[0]!.disconnect();
  await Bun.sleep(5);
  expect(sockets).toHaveLength(2);
  await sockets[1]!.receive({ type: 'editor-transport/hello', version: TRANSPORT_PROTOCOL_VERSION });
  expect(JSON.parse(sockets[1]!.sent.at(-1) ?? '{}')).toMatchObject({
    type: 'editor-transport/ready', role: 'interactive', scope: 'game:spin-cube',
  });

  carrier.dispose();
  await Bun.sleep(5);
  expect(sockets).toHaveLength(2);
});

test('classifies visible and managed pages for deterministic carrier priority', () => {
  expect(studioEditorTransportRole('?runtimeId=runtime-1&ownershipChallenge=token&gameId=spin-cube')).toBe('managed');
  expect(studioEditorTransportRole('?gameId=spin-cube')).toBe('interactive');
  expect(studioEditorTransportRole('')).toBe('interactive');
});

test('Studio editor service publishes Gateway capabilities without runtime aliases', async () => {
  const service = createStudioEditorTransportService('game:spin-cube');
  const response = await service.handle(request('discover-runtime', 'discover', {}));

  expect(response.result).toMatchObject({
    capabilityManifest: { generatedFrom: 'capability-registry' },
    methods: expect.arrayContaining(['script.execute']),
  });
  expect(response.result).toMatchObject({ methods: expect.not.arrayContaining(['runtime.play', 'runtime.stop']) });
});

test('Studio editor service executes typed scripts with operation scope only', async () => {
  const service = createStudioEditorTransportService('game:spin-cube');
  const response = await service.handle(request('script', 'script.execute', {
    code: '({ ops: gateway.listOps().length, world: typeof world, renderer: typeof renderer })',
    actor: { id: 'carrier-test', kind: 'ai' },
    sessionId: 'carrier-test',
    permission: 'execute',
  }));
  expect(response).toMatchObject({
    result: {
      status: 'succeeded',
      result: { ok: true, value: { ops: expect.any(Number), world: 'undefined', renderer: 'undefined' } },
    },
  });
});

test('Studio editor service accepts runs in the carrier game scope', async () => {
  const service = createStudioEditorTransportService('game:spin-cube');
  const response = await service.handle(request('hover', 'run.dispatch', {
    operationId: 'editor.setHoverEntity',
    input: { id: null },
    scope: 'game:spin-cube',
    actor: { id: 'carrier-test', kind: 'ai' },
    sessionId: 'carrier-test',
    permission: 'execute',
  }));

  expect(response).toMatchObject({ result: { status: 'succeeded' } });
});

test('Studio editor service refreshes late viewport play and stop appliers', async () => {
  const service = createStudioEditorTransportService('game:spin-cube');
  const unregister: Array<() => void> = [];
  const dispatch = (id: string, operationId: string, input: unknown) => service.handle(request(id, 'run.dispatch', {
    operationId,
    input,
    scope: 'game:spin-cube',
    actor: { id: 'carrier-test', kind: 'ai' },
    sessionId: 'carrier-test',
    permission: 'execute',
  }));
  try {
    unregister.push(registerSessionApplier('play', () => ({ ok: true })));
    unregister.push(registerSessionApplier('stop', () => ({ ok: true })));

    expect(await dispatch('late-play', 'editor.play', { dirtyPolicy: 'last-saved' }))
      .toMatchObject({ result: { status: 'succeeded' } });
    expect(await dispatch('late-stop', 'editor.stop', {}))
      .toMatchObject({ result: { status: 'succeeded' } });
  } finally {
    for (const dispose of unregister.reverse()) dispose();
    service.dispose();
  }
});

test('Studio editor service projects the canonical document as serializable content', async () => {
  const service = createStudioEditorTransportService('game:spin-cube');
  const response = await service.handle(request('query-document', 'query', {}));
  const document = (response.result as { document: { content: unknown } }).document;

  expect(typeof document.content).toBe('string');
  expect(JSON.parse(document.content as string)).toHaveProperty('scenes');
});

test('Studio editor service exposes Gateway component and world read models', async () => {
  const service = createStudioEditorTransportService('game:spin-cube');
  const components = await service.handle(request('query-components', 'query', {
    input: { kind: 'components' },
  }));
  expect(components.result).toMatchObject({ ok: true, components: expect.arrayContaining(['Transform']) });

  const world = await service.handle(request('query-world', 'query', {
    input: { kind: 'world', with: ['Transform'] },
  }));
  expect(world.result).toMatchObject({ ok: true, rows: expect.any(Array) });
});

test('Studio editor service rejects unknown query kinds instead of returning an unrelated document', async () => {
  const service = createStudioEditorTransportService('game:spin-cube');
  const response = await service.handle(request('query-unknown', 'query', {
    input: { kind: 'assets' },
  }));
  expect(response.error).toMatchObject({ code: 'UNKNOWN_QUERY_KIND' });
});

test('Studio editor service delegates gameplay to the visible viewport bridge', async () => {
  const dispose = registerLiveGameplayBridge({
    version: 1,
    execute: async (input) => ({ version: 1, operation: 'query', ok: true, data: input }),
  });
  try {
    const service = createStudioEditorTransportService('game:spin-cube');
    const response = await service.handle(request('gameplay', 'gameplay', {
      version: 1, operation: 'query', query: '2048.snapshot',
    }));
    expect(response.result).toEqual({
      version: 1, operation: 'query', ok: true,
      data: { version: 1, operation: 'query', query: '2048.snapshot' },
    });
  } finally {
    dispose();
  }
});

test('Studio editor transport rejects lifecycle and reveal through raw gameplay requests', async () => {
  const identity = {
    runtimeId: 'runtime-1', scope: { projectId: 'studio', gameId: 'spin-cube' },
    pageIdentity: 'page-1', canvasIdentity: 'canvas-1', rendererGeneration: 1,
  } as const;
  let producerCalls = 0;
  const dispose = registerLiveGameplayBridge(createGameplayCarrierBridge({
    input: async () => { producerCalls += 1; return { ok: true }; },
    query: async () => { producerCalls += 1; return { ok: true, data: {} }; },
    capture: async () => { producerCalls += 1; return { ok: true, data: undefined }; },
  }, () => identity));
  try {
    const service = createStudioEditorTransportService('game:spin-cube');
    for (const operation of ['play', 'gameplayStop', 'reveal']) {
      const response = await service.handle(request(`gameplay-${operation}`, 'gameplay', { version: 1, operation }));
      expect(response.result).toMatchObject({
        version: 1, operation: null, ok: false,
        error: { code: 'invalid-request', phase: 'contract' },
      });
    }
    expect(producerCalls).toBe(0);
  } finally {
    dispose();
  }
});
