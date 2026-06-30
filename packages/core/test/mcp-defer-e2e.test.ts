/**
 * MCP defer 注入治理 —— loop 级 e2e(INTEGRATE-MCP)。
 *
 * 证明 M1 策略层(`mapMcpToolToAgentTool(..., { deferMode })`)与 agent.ts 的 defer
 * ENGINE + ToolSearch 端到端打通,默认延迟生效:
 *   - 一个 server 的工具用 `deferMode:'async'` 映射 → 每个 `shouldDefer()===true`,
 *     首轮**不**进 provider 的 `tools`;另一个 server 用 `deferMode:'sync'`
 *     (defer_loading:false 类比) → 首轮就在 wire 上。
 *   - 首轮 provider 请求:async MCP 工具缺席、ToolSearch 与 sync 工具在场、且 system
 *     里带「未加载工具清单」的 system-reminder manifest。
 *   - 模型调 `ToolSearch({ query:'select:mcp__x__y' })` → 次轮该工具进入 `tools`。
 *
 * fake-provider 取自 test/loop-recovery-e2e.test.ts 的 idiom;fakeClient 只需
 * listTools/callTool/serverName(`MCPClient` 最小子集)。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { mapMcpToolToAgentTool } from '../src/capability/mcp/bridge';
import { TOOL_SEARCH_NAME } from '../src/capability/tool-search';
import type { MCPClient, MCPTool, MCPToolResult } from '../src/capability/mcp/client';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { AgentTool } from '../src/capability/types';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderStreamEvent,
  Usage,
  StopReason,
} from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── fake provider(同 loop-recovery-e2e idiom,但额外捕获每轮 req.tools / req.system)──
type Block = { type: string; [k: string]: unknown };
function asst(content: Block[], stopReason: StopReason): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content },
    usage: { ...EMPTY_USAGE } as Usage,
    stopReason,
  };
}
const txt = (t: string): Block[] => [{ type: 'text', text: t }];
const tu = (id: string, name: string, input: unknown): Block[] => [{ type: 'tool_use', id, name, input }];

interface Captured {
  toolNames: string[][];
  systemText: string[];
}
type Handler = () => ProviderStreamEvent[];
function mkProvider(handlers: Handler[]): { provider: LLMProvider; cap: Captured } {
  const cap: Captured = { toolNames: [], systemText: [] };
  let call = 0;
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(req: ProviderRequest) {
      cap.toolNames.push(req.tools.map((t) => t.name));
      cap.systemText.push(req.system.map((b) => b.text).join('\n'));
      const h = handlers[Math.min(call, handlers.length - 1)];
      call++;
      for (const ev of h()) yield ev;
    },
  };
  return { provider, cap };
}

// ─── fakeClient:MCPClient 最小子集(listTools/callTool/serverName)──────────────
function fakeClient(serverName: string, tools: MCPTool[]): MCPClient {
  return {
    serverName,
    async listTools(): Promise<MCPTool[]> {
      return tools;
    },
    async callTool(): Promise<MCPToolResult> {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

function mkMcpTool(name: string): MCPTool {
  return { name, description: `tool ${name}`, inputSchema: { type: 'object' } };
}

function ctx(tools: AgentTool[], prov: LLMProvider): AgentContext {
  return {
    agentId: 'a',
    provider: prov,
    config: { systemPromptSlots: [], model: 'm', tools, maxTurns: 8 },
    toolContext: {},
  };
}
async function run(agent: CoreAgent): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) out.push(e);
  return out;
}

describe('MCP defer 注入治理 — loop e2e', () => {
  test('async server 首轮缺席 + sync server 在场 + manifest → ToolSearch select 激活', async () => {
    // server x:两个 async 工具(默认延迟);server y:一个 sync 工具(defer_loading:false 类比)。
    const xClient = fakeClient('x', [mkMcpTool('alpha'), mkMcpTool('beta')]);
    const yClient = fakeClient('y', [mkMcpTool('gamma')]);

    const xAlpha = mapMcpToolToAgentTool(xClient, 'x', mkMcpTool('alpha'), { deferMode: 'async' });
    const xBeta = mapMcpToolToAgentTool(xClient, 'x', mkMcpTool('beta'), { deferMode: 'async' });
    const yGamma = mapMcpToolToAgentTool(yClient, 'y', mkMcpTool('gamma'), { deferMode: 'sync' });

    // 自检:M1 策略把 async 工具标成 shouldDefer、sync 工具不标。
    expect(xAlpha.shouldDefer?.()).toBe(true);
    expect(xBeta.shouldDefer?.()).toBe(true);
    expect(yGamma.shouldDefer?.()).toBeUndefined();

    const alphaName = xAlpha.name; // mcp__x__alpha
    const betaName = xBeta.name;
    const gammaName = yGamma.name; // mcp__y__gamma

    const { provider, cap } = mkProvider([
      // 首轮:模型用 ToolSearch 精确选 alpha(select: 全名)。
      () => [asst(tu('s1', TOOL_SEARCH_NAME, { query: `select:${alphaName}` }), 'tool_use')],
      // 次轮:alpha 已激活,模型收尾。
      () => [asst(txt('done'), 'end_turn')],
    ]);

    const agent = new CoreAgent({ context: ctx([xAlpha, xBeta, yGamma], provider) });
    const evs = await run(agent);

    // ── 首轮 provider 请求:async MCP 工具缺席、ToolSearch + sync 工具在场。
    const turn1Tools = cap.toolNames[0];
    expect(turn1Tools).toContain(TOOL_SEARCH_NAME);
    expect(turn1Tools).toContain(gammaName); // sync server 首轮上线
    expect(turn1Tools).not.toContain(alphaName); // async 延迟
    expect(turn1Tools).not.toContain(betaName);

    // ── 首轮 system 含「未加载工具」manifest(system-reminder)且列出延迟工具名。
    const turn1System = cap.systemText[0];
    expect(turn1System).toContain('system-reminder');
    expect(turn1System).toContain(alphaName);
    expect(turn1System).toContain(betaName);
    expect(turn1System).not.toContain(gammaName); // sync 工具不在「未加载」清单里

    // ── 模型 ToolSearch select alpha → 次轮 alpha 进入 provider tools(beta 仍延迟)。
    const turn2Tools = cap.toolNames[1];
    expect(turn2Tools).toContain(alphaName);
    expect(turn2Tools).toContain(TOOL_SEARCH_NAME);
    expect(turn2Tools).toContain(gammaName);
    expect(turn2Tools).not.toContain(betaName); // 未被选中 → 仍延迟

    // ── 收尾正常。
    const last = evs.at(-1);
    expect(last?.type === 'done' && last.terminal.reason).toBe('completed');
  });

  test('alwaysLoad 工具豁免延迟:即便 async server 也首轮上线', async () => {
    const client = fakeClient('z', []);
    const always: MCPTool = {
      name: 'pin',
      description: 'pinned',
      inputSchema: { type: 'object' },
      _meta: { 'anthropic/alwaysLoad': true },
    };
    const pin = mapMcpToolToAgentTool(client, 'z', always, { deferMode: 'async' });
    const deferredOne = mapMcpToolToAgentTool(client, 'z', mkMcpTool('lazy'), { deferMode: 'async' });
    // alwaysLoad → 不设 shouldDefer(豁免);普通 async → 延迟。
    expect(pin.shouldDefer).toBeUndefined();
    expect(deferredOne.shouldDefer?.()).toBe(true);

    const { provider, cap } = mkProvider([() => [asst(txt('done'), 'end_turn')]]);
    const agent = new CoreAgent({ context: ctx([pin, deferredOne], provider) });
    await run(agent);
    const turn1Tools = cap.toolNames[0];
    expect(turn1Tools).toContain(pin.name); // alwaysLoad 首轮上线
    expect(turn1Tools).toContain(TOOL_SEARCH_NAME);
    expect(turn1Tools).not.toContain(deferredOne.name); // 普通 async 延迟
  });
});
