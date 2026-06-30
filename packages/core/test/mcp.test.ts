/**
 * MCP bridge tests — in-process linked transport (queueMicrotask 异步双向投递 +
 * close), buildMcpToolName/normalize, mapMcpToolToAgentTool (名/inputJSONSchema/
 * passthrough/谓词来自 annotation), call 往返 (用假 MCPClient + mcpMeta).
 */
import { test, expect, describe } from 'bun:test';
import {
  createLinkedTransportPair,
  type Transport,
  type TransportMessage,
} from '../src/capability/mcp/transport';
import {
  buildMcpToolName,
  normalizeNameForMCP,
  mapMcpToolToAgentTool,
  mapMcpResult,
  getMcpTools,
} from '../src/capability/mcp/bridge';
import { mcpPack } from '../src/capability/mcp/index';
import type {
  MCPClient,
  MCPTool,
  MCPToolResult,
  MCPCallOptions,
} from '../src/capability/mcp/client';
import type { ToolContext } from '../src/capability/types';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, ...over };
}

/** 假 MCPClient —— 记录 callTool 入参,返回脚本化结果。 */
class FakeMCPClient implements MCPClient {
  readonly serverName: string;
  readonly tools: MCPTool[];
  calls: { name: string; args: Record<string, unknown>; opts?: MCPCallOptions }[] = [];
  result: MCPToolResult;

  constructor(serverName: string, tools: MCPTool[], result: MCPToolResult) {
    this.serverName = serverName;
    this.tools = tools;
    this.result = result;
  }

  async listTools(): Promise<MCPTool[]> {
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: MCPCallOptions,
  ): Promise<MCPToolResult> {
    this.calls.push({ name, args, opts });
    return this.result;
  }
}

// ─── transport ────────────────────────────────────────────────────────────────

describe('createLinkedTransportPair', () => {
  test('send on one side delivers to other side onmessage (async via queueMicrotask)', async () => {
    const [a, b] = createLinkedTransportPair();
    const got: TransportMessage[] = [];
    b.onmessage = (m) => got.push(m);

    const p = a.send({ hello: 'world' });
    // queueMicrotask: 投递是异步的 —— send 同步返回时尚未到达 onmessage。
    expect(got).toHaveLength(0);
    await p;
    await new Promise<void>((r) => queueMicrotask(r));
    expect(got).toEqual([{ hello: 'world' }]);
  });

  test('delivery is bidirectional', async () => {
    const [a, b] = createLinkedTransportPair();
    const onA: TransportMessage[] = [];
    const onB: TransportMessage[] = [];
    a.onmessage = (m) => onA.push(m);
    b.onmessage = (m) => onB.push(m);

    await a.send('to-b');
    await b.send('to-a');
    await new Promise<void>((r) => queueMicrotask(r));

    expect(onB).toEqual(['to-b']);
    expect(onA).toEqual(['to-a']);
  });

  test('close is bidirectional and idempotent; send after close throws', async () => {
    const [a, b] = createLinkedTransportPair();
    let aClosed = 0;
    let bClosed = 0;
    a.onclose = () => aClosed++;
    b.onclose = () => bClosed++;

    await a.close();
    expect(aClosed).toBe(1);
    expect(bClosed).toBe(1);

    // 幂等: 再 close 不重复触发。
    await a.close();
    await b.close();
    expect(aClosed).toBe(1);
    expect(bClosed).toBe(1);

    await expect(a.send('x')).rejects.toThrow('Transport is closed');
  });
});

// ─── buildMcpToolName / normalize ───────────────────────────────────────────────

describe('buildMcpToolName', () => {
  test('produces mcp__server__tool', () => {
    expect(buildMcpToolName('weather', 'get_forecast')).toBe(
      'mcp__weather__get_forecast',
    );
  });

  test('normalizes illegal chars to underscore', () => {
    expect(normalizeNameForMCP('my server.v2')).toBe('my_server_v2');
    expect(buildMcpToolName('a.b c', 'do/it')).toBe('mcp__a_b_c__do_it');
  });
});

// ─── mapMcpToolToAgentTool ──────────────────────────────────────────────────────

describe('mapMcpToolToAgentTool', () => {
  const client = new FakeMCPClient('srv', [], { content: 'ok' });

  test('name / isMcp / mcpInfo / inputJSONSchema verbatim', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    const t = mapMcpToolToAgentTool(client, 'srv', {
      name: 'search',
      description: 'do a search',
      inputSchema: schema,
    });
    expect(t.name).toBe('mcp__srv__search');
    expect(t.isMcp).toBe(true);
    expect(t.mcpInfo).toEqual({ serverName: 'srv', toolName: 'search' });
    // 原样(同一引用形状)塞进 inputJSONSchema。
    expect(t.inputJSONSchema).toEqual(schema);
  });

  test('missing inputSchema defaults to {type:object}', () => {
    const t = mapMcpToolToAgentTool(client, 'srv', { name: 'noschema' });
    expect(t.inputJSONSchema).toEqual({ type: 'object' });
  });

  test('predicates derive from annotations (fail-closed defaults)', () => {
    const ro = mapMcpToolToAgentTool(client, 'srv', {
      name: 'ro',
      annotations: { readOnlyHint: true },
    });
    expect(ro.isReadOnly({})).toBe(true);
    expect(ro.isConcurrencySafe({})).toBe(true); // 与 readOnly 同源
    expect(ro.isDestructive?.({})).toBe(false);

    const destr = mapMcpToolToAgentTool(client, 'srv', {
      name: 'rm',
      annotations: { destructiveHint: true },
    });
    expect(destr.isReadOnly({})).toBe(false);
    expect(destr.isConcurrencySafe({})).toBe(false);
    expect(destr.isDestructive?.({})).toBe(true);

    // 无 annotation: 全 fail-closed false。
    const bare = mapMcpToolToAgentTool(client, 'srv', { name: 'bare' });
    expect(bare.isReadOnly({})).toBe(false);
    expect(bare.isConcurrencySafe({})).toBe(false);
    expect(bare.isDestructive?.({})).toBe(false);
    expect(bare.isEnabled()).toBe(true);
  });

  test('searchHint / alwaysLoad read from _meta (whitespace collapsed)', () => {
    const t = mapMcpToolToAgentTool(client, 'srv', {
      name: 'm',
      _meta: {
        'anthropic/searchHint': '  find\n  things  ',
        'anthropic/alwaysLoad': true,
      },
    });
    expect(t.searchHint).toBe('find things');
    expect(t.alwaysLoad).toBe(true);
  });

  test('checkPermissions returns passthrough', async () => {
    const t = mapMcpToolToAgentTool(client, 'srv', { name: 'p' });
    const res = await t.checkPermissions({}, makeCtx());
    expect(res.behavior).toBe('passthrough');
    expect(res.decisionReason).toEqual({
      type: 'mcp',
      serverName: 'srv',
      toolName: 'p',
    });
  });
});

// ─── call round-trip ────────────────────────────────────────────────────────────

describe('call round-trip', () => {
  test('call forwards args + toolUseId meta to client and maps result', async () => {
    const client = new FakeMCPClient('srv', [], {
      content: [{ type: 'text', text: 'hi' }],
    });
    const t = mapMcpToolToAgentTool(client, 'srv', { name: 'echo' });

    const out = await t.call({ msg: 'yo' }, makeCtx({ toolUseId: 'tu-1' }));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].name).toBe('echo'); // 原始名,非全限定
    expect(client.calls[0].args).toEqual({ msg: 'yo' });
    expect(client.calls[0].opts?.meta).toEqual({ 'bc/toolUseId': 'tu-1' });
    expect(out.data).toEqual([{ type: 'text', text: 'hi' }]);
    expect(out.mcpMeta).toBeUndefined();
  });

  test('mcpMeta attached when _meta / structuredContent present', () => {
    const r = mapMcpResult({
      content: 'c',
      _meta: { a: 1 },
      structuredContent: { ok: true },
    });
    expect(r.data).toBe('c');
    expect(r.mcpMeta).toEqual({
      _meta: { a: 1 },
      structuredContent: { ok: true },
    });
  });

  test('mapResult emits a tool_result CoreEvent', () => {
    const client = new FakeMCPClient('srv', [], { content: 'x' });
    const t = mapMcpToolToAgentTool(client, 'srv', { name: 'e' });
    const ev = t.mapResult('payload', 'tu-9');
    expect(ev.type).toBe('tool_result');
    expect(ev.source).toBe('mcp__srv__e');
    expect(ev.payload).toMatchObject({
      toolUseId: 'tu-9',
      isMcp: true,
      serverName: 'srv',
      toolName: 'e',
      content: 'payload',
    });
  });
});

// ─── getMcpTools / mcpPack ──────────────────────────────────────────────────────

describe('getMcpTools / mcpPack', () => {
  const tools: MCPTool[] = [
    { name: 'a', annotations: { readOnlyHint: true } },
    { name: 'b' },
  ];

  test('getMcpTools maps all tools from listTools', async () => {
    const client = new FakeMCPClient('srv', tools, { content: 'ok' });
    const mapped = await getMcpTools(client, 'srv');
    expect(mapped.map((t) => t.name)).toEqual(['mcp__srv__a', 'mcp__srv__b']);
    expect(mapped[0].isReadOnly({})).toBe(true);
  });

  test('mcpPack wraps server tools into a builtin CapabilityPack', async () => {
    const client = new FakeMCPClient('srv', tools, { content: 'ok' });
    const pack = await mcpPack(client, 'srv');
    expect(pack.name).toBe('mcp:srv');
    expect(pack.layer).toBe('builtin');
    expect(pack.tools?.map((t) => t.name)).toEqual([
      'mcp__srv__a',
      'mcp__srv__b',
    ]);
  });
});
