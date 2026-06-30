/**
 * ISSUE-4a — CoreAgent.setModel() mid-turn(轮中改活)确定性覆盖。
 *
 * facade.test.ts 的 P0.1 已覆盖「kernel 持久 → 下一轮生效」;此处补上更底层的
 * **同一 run() 内、provider 调用之间** 切模型的确定性断言(对标 agent-mode.test.ts
 * 的 setMode 写法):用脚本化 provider 记录每次 req.model,第一次 stream 后调
 * agent.setModel('model-B'),验证下一次 provider 请求即用新模型。
 */
import { test, expect, describe } from 'bun:test';
import { CoreAgent } from '../src/agent/agent';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const noopTool = buildTool({
  name: 'ping',
  isDestructive: () => false,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { toolUseId: id, isError: false, result: o }, ts: 0 }),
  maxResultSizeChars: 1000,
});

function asstToolUse(id: string, name: string, input: unknown): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'tool_use',
  };
}
function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}
function ctx(tools: AgentTool[], provider: LLMProvider, maxTurns = 16): AgentContext {
  return {
    agentId: 'a1',
    provider,
    config: { systemPromptSlots: [], model: 'model-A', tools, maxTurns },
    toolContext: {},
  };
}
async function drain(agent: CoreAgent, input: Parameters<CoreAgent['run']>[0]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run(input)) out.push(e);
  return out;
}

describe('CoreAgent.setModel — mid-turn(同一 run 内 provider 调用间切模型)', () => {
  test('第一次 stream 后 setModel("model-B") → 下一次 provider 请求即用 model-B', async () => {
    const seenModels: string[] = [];
    let agentRef: CoreAgent;
    let call = 0;
    // turn0: tool_use(继续);turn1: text(收尾)。
    const scripts: ProviderStreamEvent[][] = [
      [asstToolUse('p1', 'ping', { x: 1 })],
      [asstText('done')],
    ];
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: ProviderRequest) {
        seenModels.push(req.model);
        const i = call;
        call++;
        if (i === 0) agentRef.setModel('model-B'); // 轮中改活,生效于下一次 provider 调用
        for (const ev of scripts[Math.min(i, scripts.length - 1)]) yield ev;
      },
    };
    agentRef = new CoreAgent({ context: ctx([noopTool], provider) });
    await drain(agentRef, { input: { type: 'user', payload: 'go', ts: 0 } });

    // 初值 = context.config.model;切换后下一次请求即新模型(mid-turn live)。
    expect(seenModels).toEqual(['model-A', 'model-B']);
  });

  test('不调 setModel → 全程用初始模型(零行为变化回归)', async () => {
    const seenModels: string[] = [];
    let call = 0;
    const scripts: ProviderStreamEvent[][] = [
      [asstToolUse('p1', 'ping', { x: 1 })],
      [asstText('done')],
    ];
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: ProviderRequest) {
        seenModels.push(req.model);
        const i = call;
        call++;
        for (const ev of scripts[Math.min(i, scripts.length - 1)]) yield ev;
      },
    };
    const agent = new CoreAgent({ context: ctx([noopTool], provider) });
    await drain(agent, { input: { type: 'user', payload: 'go', ts: 0 } });

    expect(seenModels).toEqual(['model-A', 'model-A']);
  });
});
