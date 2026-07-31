import { expect, test } from 'bun:test';

import { TRANSPORT_PROTOCOL_VERSION } from '@forgeax/editor/product';
import {
  createEditorTransportClient,
  type EditorTransportClient,
} from './client';

function response(value: unknown, id: string, correlationId: string) {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId,
    result: value,
  };
}

test('carries the public typed envelope through discover, preflight, dispatch, and run.get', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const params = body.params as Record<string, unknown>;
    const result = body.method === 'discover'
      ? { capabilityManifest: { capabilities: [] }, runtime: { capabilities: {} } }
      : body.method === 'asset.preflight'
        ? { ok: true, confirmation: { required: false } }
        : body.method === 'run.dispatch'
          ? { status: 'succeeded', operationId: params.operationId }
          : { runId: params.runId, status: 'succeeded' };
    return new Response(JSON.stringify(response(result, String(body.id), String(body.correlationId))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client: EditorTransportClient = createEditorTransportClient({
    fetch: fetchImpl,
    scope: 'game:demo',
    actor: { id: 'studio-ui', kind: 'human' },
    sessionId: 'studio-session',
    idFactory: (() => {
      let count = 0;
      return () => `request-${++count}`;
    })(),
    correlationIdFactory: (() => {
      let count = 0;
      return () => `correlation-${++count}`;
    })(),
  });

  await client.discover();
  await client.preflight({ operation: 'delete', subjectId: 'asset:hero' });
  await client.dispatch('document.edit', { documentId: 'scene:main', content: 'canonical' }, 'edit-once');
  await client.getRun('run-1');

  expect(requests).toHaveLength(4);
  expect(requests.map((request) => request.method)).toEqual([
    'discover',
    'asset.preflight',
    'run.dispatch',
    'run.get',
  ]);
  for (const request of requests) {
    expect(request).toMatchObject({
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      correlationId: expect.stringMatching(/^correlation-/),
      params: {
        scope: 'game:demo',
        actor: { id: 'studio-ui', kind: 'human' },
        sessionId: 'studio-session',
        idempotencyKey: expect.any(String),
      },
    });
  }
  expect(requests[2]).toMatchObject({
    params: {
      permission: 'execute',
      idempotencyKey: 'edit-once',
      operationId: 'document.edit',
    },
  });
  expect(requests[3]).toMatchObject({
    params: { permission: 'read', runId: 'run-1' },
  });
  expect(JSON.stringify(requests)).not.toContain('editor_gateway_eval');
  expect(JSON.stringify(requests)).not.toContain('/eval');
});

test('returns structured transport errors without parsing their message text', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id: body.id,
      correlationId: body.correlationId,
      error: {
        code: 'runtime-stale',
        hint: 'human-readable detail can change',
        retryable: true,
        subjectRef: { kind: 'carrier', id: 'carrier:old' },
        expected: { runtime: 'runtime:new' },
        current: { runtime: 'runtime:old' },
        recoveryActions: ['runtime.acquire', 'request.retry'],
      },
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  };
  const client = createEditorTransportClient({
    fetch: fetchImpl,
    scope: 'game:demo',
    actor: { id: 'studio-ui', kind: 'human' },
    sessionId: 'studio-session',
  });

  const result = await client.dispatch('runtime.play', {}, 'play-once');

  expect(result).toMatchObject({
    error: {
      code: 'runtime-stale',
      subjectRef: { kind: 'carrier', id: 'carrier:old' },
      expected: { runtime: 'runtime:new' },
      current: { runtime: 'runtime:old' },
      recoveryActions: ['runtime.acquire', 'request.retry'],
    },
  });
});
