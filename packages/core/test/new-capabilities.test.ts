/**
 * 新增基础能力单测:web/todo/notebook 工具 · settings-hook 加载器 · 交互式权限(askUser) ·
 * 装配层 assembleCapabilities · 云网关 provider(vertex body / bedrock SigV4 + event-stream
 * decoder) · mid-turn steering。不打真网络(fake fetch / fake provider / 内存 fs)。
 */
import { test, expect, describe } from 'bun:test';
import type { SandboxFs, DirEnt, StatResult } from '../src/inject/types';
import type { ToolContext } from '../src/capability/types';
import {
  webFetchTool,
  webSearchTool,
  htmlToText,
  todoWriteTool,
  notebookEditTool,
} from '../src/capability/builtin-tools/index';
import { loadHooksFromSettings } from '../src/capability/hooks/from-settings';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import { dispatchTools } from '../src/agent/dispatch';
import { buildTool } from '../src/capability/types';
import { assembleCapabilities } from '../src/runtime/assemble';
import { buildVertexBody, buildVertexUrl } from '../src/provider/vertex';
import { signV4, decodeBedrockEventStream, buildBedrockBody } from '../src/provider/bedrock';
import { CoreAgent } from '../src/agent/agent';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage, ProviderMessage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const ac = () => new AbortController().signal;
const ctx = (extra: Record<string, unknown> = {}): ToolContext => ({ signal: ac(), ...extra });

// 最小内存 SandboxFs(只实现新工具用到的方法)。
class MiniFs implements SandboxFs {
  files = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }
  async readText(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeText(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  readTextSync(p: string): string {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  writeTextSync(p: string, c: string): void {
    this.files.set(p, c);
  }
  mkdirSync(): void {}
  existsSync(p: string): boolean {
    return this.files.has(p);
  }
  unlinkSync(p: string): void {
    this.files.delete(p);
  }
  renameSync(): void {}
  statSync(): StatResult {
    return { isFile: true, isDir: false, size: 0, mtime: 0 };
  }
  readdirSync(): string[] | DirEnt[] {
    return [];
  }
  async readBytes(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async writeBytes(): Promise<void> {}
  readStream(): ReadableStream<Uint8Array> {
    throw new Error('n/a');
  }
  writeStream(): WritableStream<Uint8Array> {
    throw new Error('n/a');
  }
}

// ─── web-tools ──────────────────────────────────────────────────────────────

describe('web-tools', () => {
  test('htmlToText strips tags/scripts and decodes entities', () => {
    const t = htmlToText('<html><body><script>x()</script><p>Hello&amp;World</p></body></html>');
    expect(t).toContain('Hello&World');
    expect(t).not.toContain('x()');
    expect(t).not.toContain('<p>');
  });

  test('web_fetch returns extracted text via injected fetch', async () => {
    const fakeFetch = (async () =>
      new Response('<p>WEBFETCH_OK</p>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const tool = webFetchTool({ fetchImpl: fakeFetch });
    const out = await tool.call({ url: 'http://example.com' }, ctx());
    expect(out.data.text).toContain('WEBFETCH_OK');
    expect(out.data.status).toBe(200);
  });

  test('web_search uses injected backend', async () => {
    const tool = webSearchTool({ searchBackend: async (q) => [{ title: `R:${q}`, url: 'http://x' }] });
    const out = await tool.call({ query: 'cats' }, ctx());
    expect(out.data.results[0].title).toBe('R:cats');
  });

  test('web_search throws when backend unconfigured', async () => {
    const tool = webSearchTool();
    await expect(tool.call({ query: 'x' }, ctx())).rejects.toThrow(/not configured/);
  });
});

// ─── todo-tools ───────────────────────────────────────────────────────────────

describe('todo-tools', () => {
  test('todo_write replaces store + reports counts', async () => {
    const store = { items: [] as { content: string; status: 'pending' | 'in_progress' | 'completed' }[] };
    const tool = todoWriteTool({ store });
    const out = await tool.call(
      { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] },
      ctx(),
    );
    expect(out.data.counts).toEqual({ pending: 1, in_progress: 0, completed: 1 });
    expect(store.items.length).toBe(2);
  });
});

// ─── notebook-tools ─────────────────────────────────────────────────────────

describe('notebook-tools', () => {
  const NB = (cells: unknown[]) => JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
  test('replace updates a cell source by id', async () => {
    const fs = new MiniFs({ '/n.ipynb': NB([{ cell_type: 'code', source: 'old', id: 'c1' }]) });
    const tool = notebookEditTool();
    await tool.call({ notebook_path: '/n.ipynb', cell_id: 'c1', new_source: 'NEW_SRC', edit_mode: 'replace' }, ctx({ sandboxFs: fs }));
    expect(fs.files.get('/n.ipynb')).toContain('NEW_SRC');
  });
  test('insert adds a new cell at start', async () => {
    const fs = new MiniFs({ '/n.ipynb': NB([{ cell_type: 'code', source: 'a', id: 'c1' }]) });
    await notebookEditTool().call({ notebook_path: '/n.ipynb', new_source: 'INSERTED', edit_mode: 'insert' }, ctx({ sandboxFs: fs }));
    const nb = JSON.parse(fs.files.get('/n.ipynb')!) as { cells: { source: string }[] };
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[0].source).toBe('INSERTED');
  });
  test('delete removes a cell by id', async () => {
    const fs = new MiniFs({ '/n.ipynb': NB([{ cell_type: 'code', source: 'a', id: 'c1' }, { cell_type: 'code', source: 'b', id: 'c2' }]) });
    await notebookEditTool().call({ notebook_path: '/n.ipynb', cell_id: 'c1', edit_mode: 'delete' }, ctx({ sandboxFs: fs }));
    const nb = JSON.parse(fs.files.get('/n.ipynb')!) as { cells: { id: string }[] };
    expect(nb.cells.length).toBe(1);
    expect(nb.cells[0].id).toBe('c2');
  });
});

// ─── settings hook loader ─────────────────────────────────────────────────────

describe('loadHooksFromSettings', () => {
  test('PreToolUse hook can block a matching tool', () => {
    const bus = new EventBus();
    loadHooksFromSettings(
      bus,
      { PreToolUse: [{ matcher: 'bash', command: 'x' }] },
      () => ({ block: true, reason: 'nope' }),
    );
    const e = bus.publish({ type: CoreEventType.ToolCallRequested, payload: { toolName: 'bash', toolUseId: '1', input: {} }, ts: 0 });
    expect((e as { blocked?: boolean }).blocked).toBe(true);
    const e2 = bus.publish({ type: CoreEventType.ToolCallRequested, payload: { toolName: 'read_file', toolUseId: '2', input: {} }, ts: 0 });
    expect((e2 as { blocked?: boolean }).blocked).not.toBe(true); // matcher 'bash' 不命中 read_file
  });
  test('hook can modify event payload', () => {
    const bus = new EventBus();
    loadHooksFromSettings(bus, { PreToolUse: [{ command: 'x' }] }, () => ({ modify: { payload: { tagged: true } } }));
    const e = bus.publish({ type: CoreEventType.ToolCallRequested, payload: { toolName: 't', toolUseId: '1', input: {} }, ts: 0 });
    expect((e.payload as { tagged?: boolean }).tagged).toBe(true);
  });
});

// ─── 交互式权限 askUser ────────────────────────────────────────────────────────

describe('dispatch askUser', () => {
  const askTool = buildTool<{ x?: number }, string>({
    name: 'ask_tool',
    inputJSONSchema: { type: 'object' },
    checkPermissions: async () => ({ behavior: 'ask', message: 'need approval' }),
    call: async () => ({ data: 'done' }),
    mapResult: (d, id) => ({ type: 'tool.result', payload: { toolUseId: id, result: d }, ts: 0 }),
    maxResultSizeChars: Infinity,
  });

  test("'ask' is denied when no askUser callback", async () => {
    const [r] = await dispatchTools([{ id: '1', name: 'ask_tool', input: {} }], {
      tools: [askTool],
      toolContext: {},
      signal: ac(),
    });
    expect(r.isError).toBe(true);
  });
  test("'ask' is granted when askUser returns true", async () => {
    const [r] = await dispatchTools([{ id: '1', name: 'ask_tool', input: {} }], {
      tools: [askTool],
      toolContext: {},
      signal: ac(),
      askUser: async () => true,
    });
    expect(r.isError).toBe(false);
  });
});

// ─── assembleCapabilities ─────────────────────────────────────────────────────

describe('assembleCapabilities', () => {
  test('flattens builtin+web+todo+notebook+memory tools and appends Task', async () => {
    const bus = new EventBus();
    const fs = new MiniFs();
    const provider: LLMProvider = { api: 'demo', async *stream() {} };
    const out = await assembleCapabilities({
      bus,
      memory: { dir: '/mem', sandboxFs: fs },
      task: { provider, model: 'm' },
    });
    const names = out.tools.map((t) => t.name);
    for (const n of ['read_file', 'bash', 'web_fetch', 'web_search', 'todo_write', 'notebook_edit', 'memory_search', 'remember', 'Task']) {
      expect(names).toContain(n);
    }
    // memory slot 进 slots。
    expect(out.slots.length).toBeGreaterThan(0);
  });
});

// ─── 云网关 provider ──────────────────────────────────────────────────────────

describe('vertex provider request shaping', () => {
  const req: ProviderRequest = {
    model: 'claude-3-5-sonnet@20240620',
    system: [],
    tools: [],
    messages: [{ role: 'user', content: 'hi' }],
  };
  test('buildVertexBody drops model + adds anthropic_version', () => {
    const b = buildVertexBody(req);
    expect(b.model).toBeUndefined();
    expect(b.anthropic_version).toBe('vertex-2023-10-16');
  });
  test('buildVertexUrl appends streamRawPredict', () => {
    expect(buildVertexUrl('https://x/models', 'm')).toBe('https://x/models/m:streamRawPredict');
  });
});

describe('bedrock SigV4 + event-stream', () => {
  test('signV4 is deterministic and well-formed', () => {
    const input = {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'SECRET',
      region: 'us-east-1',
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke-with-response-stream',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      amzDate: '20240101T000000Z',
    };
    const a = signV4(input);
    const b = signV4(input);
    expect(a.authorization).toBe(b.authorization); // 确定性
    expect(a.authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20240101/us-east-1/bedrock/aws4_request');
    expect(a.authorization).toMatch(/Signature=[0-9a-f]{64}/);
    expect(a['x-amz-date']).toBe('20240101T000000Z');
  });

  test('buildBedrockBody drops model + adds anthropic_version', () => {
    const b = buildBedrockBody({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'x' }] });
    expect(b.model).toBeUndefined();
    expect(b.anthropic_version).toBe('bedrock-2023-05-31');
  });

  test('decodeBedrockEventStream extracts anthropic events from frames', async () => {
    // 造一个 chunk 帧:headers(:event-type=chunk,:message-type=event) + payload {"bytes":base64(inner)}
    const inner = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Z' } });
    const payload = Buffer.from(JSON.stringify({ bytes: Buffer.from(inner).toString('base64') }));
    const enc = new TextEncoder();
    const headerOf = (name: string, val: string) => {
      const n = enc.encode(name);
      const v = enc.encode(val);
      const buf = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
      let o = 0;
      buf.writeUInt8(n.length, o); o += 1;
      Buffer.from(n).copy(buf, o); o += n.length;
      buf.writeUInt8(7, o); o += 1; // string type
      buf.writeUInt16BE(v.length, o); o += 2;
      Buffer.from(v).copy(buf, o);
      return buf;
    };
    const headers = Buffer.concat([headerOf(':event-type', 'chunk'), headerOf(':message-type', 'event')]);
    const totalLen = 12 + headers.length + payload.length + 4;
    const frame = Buffer.alloc(totalLen);
    frame.writeUInt32BE(totalLen, 0);
    frame.writeUInt32BE(headers.length, 4);
    frame.writeUInt32BE(0, 8); // prelude crc(decoder 不校验)
    headers.copy(frame, 12);
    payload.copy(frame, 12 + headers.length);
    frame.writeUInt32BE(0, totalLen - 4); // message crc

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(frame));
        controller.close();
      },
    });
    const events: Array<{ event?: string; data: string }> = [];
    for await (const e of decodeBedrockEventStream(stream)) events.push(e);
    expect(events.length).toBe(1);
    expect(events[0].event).toBe('content_block_delta');
    expect(JSON.parse(events[0].data).delta.text).toBe('Z');
  });
});

// ─── mid-turn steering ────────────────────────────────────────────────────────

describe('mid-turn steering', () => {
  test('steeringSource messages are injected into the loop context', async () => {
    let captured: ProviderMessage[] = [];
    const provider: LLMProvider = {
      api: 'demo',
      async *stream(req): AsyncIterable<ProviderStreamEvent> {
        captured = req.messages;
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          usage: EMPTY_USAGE as Usage,
          stopReason: 'end_turn',
        };
      },
    };
    let fired = false;
    const agent = new CoreAgent({
      context: { agentId: 'a', provider, config: { systemPromptSlots: [], model: 'm', tools: [] }, toolContext: {} },
      steeringSource: () => {
        if (fired) return [];
        fired = true;
        return [{ role: 'user', content: 'STEER_MSG' }];
      },
    });
    for await (const _ev of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) void _ev;
    const joined = JSON.stringify(captured);
    expect(joined).toContain('STEER_MSG');
  });
});
