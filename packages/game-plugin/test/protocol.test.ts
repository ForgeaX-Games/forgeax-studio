import { describe, expect, test } from 'bun:test';
import { dispatch, type McpServerSpec } from '../src/mcp/protocol';

function spec(): McpServerSpec<{ value: string }> {
  return {
    serverInfo: { name: 'test-server', version: '1.2.3' },
    instructions: 'route carefully',
    buildContext: () => ({ value: 'context' }),
    tools: [
      {
        name: 'echo',
        description: 'echo args',
        inputSchema: { type: 'object' },
        run: (args, ctx) => `${ctx.value}:${String(args.message)}`,
      },
    ],
    resources: [
      {
        uri: 'test://status',
        name: 'status',
        description: 'status text',
        mimeType: 'text/plain',
        read: (ctx) => ctx.value,
      },
    ],
  };
}

describe('MCP protocol dispatch', () => {
  test('initializes and lists the declared surface', async () => {
    const initialized = await dispatch(spec(), {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-test' },
    });
    expect(initialized).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'test-server', version: '1.2.3' },
        instructions: 'route carefully',
      },
    });

    expect(await dispatch(spec(), { id: 2, method: 'tools/list' })).toMatchObject({
      result: { tools: [{ name: 'echo' }] },
    });
    expect(await dispatch(spec(), { id: 3, method: 'resources/list' })).toMatchObject({
      result: { resources: [{ uri: 'test://status' }] },
    });
  });

  test('calls tools and reads resources with a fresh context', async () => {
    expect(
      await dispatch(spec(), {
        id: 4,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello' } },
      }),
    ).toMatchObject({
      result: { content: [{ type: 'text', text: 'context:hello' }] },
    });
    expect(
      await dispatch(spec(), {
        id: 5,
        method: 'resources/read',
        params: { uri: 'test://status' },
      }),
    ).toMatchObject({
      result: { contents: [{ uri: 'test://status', text: 'context' }] },
    });
  });

  test('returns structured misses and ignores notifications', async () => {
    expect(
      await dispatch(spec(), {
        id: 6,
        method: 'tools/call',
        params: { name: 'missing' },
      }),
    ).toMatchObject({
      result: {
        isError: true,
        structuredContent: { code: 'not_found', tool: 'missing', availableTools: ['echo'] },
      },
    });
    expect(await dispatch(spec(), { method: 'notifications/initialized' })).toBeNull();
    expect(await dispatch(spec(), { method: 'tools/list' })).toBeNull();
  });
});
