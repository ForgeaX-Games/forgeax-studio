/**
 * L7 子 agent 可观测性单测(L4/L5 observability seam)。
 *
 * 覆盖:
 *   1. exploreAgent.allowedTools 过滤器:放行 Read/Glob/Grep,剥掉 Write/Edit/Task。
 *   2. emitSubagentStart/Turn/ToolCall 在真实 EventBus 上 publish(source=agentId)。
 *   3. runSubagent:注入 onSubagentEvent collector 时,派一个子 agent 产出有序的
 *      subagent.start → subagent.turn → subagent.tool_call → subagent.stop,
 *      字段(agentId/role/depth)正确。
 *   4. makeTaskTool:经 Task 工具 dispatch 子 agent,onSubagentEvent 同样收到全序列;
 *      registry 类型声明的 role 透传进事件。
 *
 * 与 test/subagent.test.ts / test/subagent-events.test.ts 同款 scripted provider。
 */
import { test, expect, describe } from 'bun:test';
import { runSubagent, makeTaskTool } from '../src/agent/subagent';
import { buildTool, type AgentTool } from '../src/capability/types';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import {
  emitSubagentStart,
  emitSubagentTurn,
  emitSubagentToolCall,
} from '../src/agent/subagent-events';
import { SubagentRegistry } from '../src/agent/subagent-registry';
import { exploreAgent } from '../src/capability/agent/builtin/explore';
import type { CoreEvent } from '../src/events/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ─── scripted provider(与 subagent.test.ts 同款)──────────────────────────────
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
function scripted(turns: ProviderStreamEvent[][]): LLMProvider {
  let n = 0;
  return {
    api: 'stub',
    async *stream() {
      const t = turns[Math.min(n, turns.length - 1)];
      n++;
      for (const e of t) yield e;
    },
  };
}

/** 极简工具(用于过滤器 / 子工具集断言)。 */
function tool(name: string): AgentTool {
  return buildTool({
    name,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async (i: unknown) => ({ data: i }),
    mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

const echo = tool('echo');

// ─── 1. exploreAgent.allowedTools 过滤器 ────────────────────────────────────────
describe('exploreAgent.allowedTools', () => {
  test('放行 Read/Glob/Grep,剥掉 Write/Edit/Task', () => {
    expect(exploreAgent.allowedTools).toBeDefined();
    const all = [
      tool('Read'),
      tool('Glob'),
      tool('Grep'),
      tool('Write'),
      tool('Edit'),
      tool('Task'),
    ];
    const kept = exploreAgent.allowedTools!(all).map((t) => t.name);
    // 只读/搜索类保留。
    expect(kept).toContain('Read');
    expect(kept).toContain('Glob');
    expect(kept).toContain('Grep');
    // 写类 + Task 必须被剥。
    expect(kept).not.toContain('Write');
    expect(kept).not.toContain('Edit');
    expect(kept).not.toContain('Task');
  });

  test('canonical(蛇形)名也命中只读集', () => {
    const all = [tool('read_file'), tool('glob'), tool('grep'), tool('write_file')];
    const kept = exploreAgent.allowedTools!(all).map((t) => t.name);
    expect(kept).toEqual(['read_file', 'glob', 'grep']);
  });
});

// ─── 2. emitSubagentStart/Turn/ToolCall publish 到 EventBus ──────────────────────
describe('emitSubagentStart/Turn/ToolCall → EventBus', () => {
  test('emitSubagentStart 发 subagent.start,source=agentId,payload 完整', () => {
    const bus = new EventBus();
    const seen: CoreEvent[] = [];
    bus.subscribe(CoreEventType.SubagentStart, (e) => { seen.push(e); });
    emitSubagentStart(bus, { agentId: 'iori-1', agentType: 'iori', role: 'planner', depth: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe(CoreEventType.SubagentStart);
    expect(seen[0]!.source).toBe('iori-1');
    expect(seen[0]!.payload).toEqual({ agentId: 'iori-1', agentType: 'iori', role: 'planner', depth: 1 });
  });

  test('emitSubagentTurn 发 subagent.turn', () => {
    const bus = new EventBus();
    let got: CoreEvent | undefined;
    bus.subscribe(CoreEventType.SubagentTurn, (e) => { got = e; });
    emitSubagentTurn(bus, { agentId: 'iori-1', turn: 2, depth: 1 });
    expect(got?.type).toBe(CoreEventType.SubagentTurn);
    expect(got?.source).toBe('iori-1');
    expect(got?.payload).toEqual({ agentId: 'iori-1', turn: 2, depth: 1 });
  });

  test('emitSubagentToolCall 发 subagent.tool_call', () => {
    const bus = new EventBus();
    let got: CoreEvent | undefined;
    bus.subscribe(CoreEventType.SubagentToolCall, (e) => { got = e; });
    emitSubagentToolCall(bus, { agentId: 'iori-1', toolName: 'Read', toolUseId: 'u1', turn: 2, depth: 1 });
    expect(got?.type).toBe(CoreEventType.SubagentToolCall);
    expect(got?.source).toBe('iori-1');
    expect(got?.payload).toEqual({ agentId: 'iori-1', toolName: 'Read', toolUseId: 'u1', turn: 2, depth: 1 });
  });
});

// ─── 3. runSubagent + onSubagentEvent collector ─────────────────────────────────
describe('runSubagent — onSubagentEvent 生命周期序列', () => {
  test('start → turn → tool_call → stop,字段(agentId/role/depth)正确', async () => {
    // 子先调一次 echo,再出最终文本。
    const provider = scripted([[asstToolUse('t1', 'echo', { v: 1 })], [asstText('child done')]]);
    const events: Array<{ type: string; agentId: string; role?: string; depth?: number; toolName?: string; reason?: string }> = [];
    const r = await runSubagent(
      {
        input: 'do task',
        agentId: 'sub-A',
        agentType: 'explorer',
        role: 'explorer',
        depth: 1,
        model: 'm',
        tools: [echo],
        leadingSystemText: 'You are a worker.',
      },
      { provider, onSubagentEvent: (ev) => events.push(ev) },
    );
    expect(r.terminalReason).toBe('completed');

    const types = events.map((e) => e.type);
    // 首 = start,尾 = stop。
    expect(types[0]).toBe('subagent.start');
    expect(types[types.length - 1]).toBe('subagent.stop');
    // 中间含至少一个 turn 与一个 tool_call。
    expect(types).toContain('subagent.turn');
    expect(types).toContain('subagent.tool_call');
    // 顺序:start 在 turn 前,turn 在 tool_call 前,tool_call 在 stop 前。
    expect(types.indexOf('subagent.start')).toBeLessThan(types.indexOf('subagent.turn'));
    expect(types.indexOf('subagent.turn')).toBeLessThan(types.indexOf('subagent.tool_call'));
    expect(types.indexOf('subagent.tool_call')).toBeLessThan(types.lastIndexOf('subagent.stop'));

    // 字段归因。
    const start = events.find((e) => e.type === 'subagent.start')!;
    expect(start.agentId).toBe('sub-A');
    expect(start.role).toBe('explorer');
    expect(start.depth).toBe(1);
    const toolEv = events.find((e) => e.type === 'subagent.tool_call')!;
    expect(toolEv.agentId).toBe('sub-A');
    expect(toolEv.toolName).toBe('echo');
    const stop = events.find((e) => e.type === 'subagent.stop')!;
    expect(stop.reason).toBe('completed');
  });

  test('emitSubagent* 同步发到 deps.bus(父侧 hook 可见)', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('*', (e) => { seen.push(e.type); });
    const provider = scripted([[asstToolUse('t1', 'echo', {})], [asstText('ok')]]);
    await runSubagent(
      { input: 'x', agentId: 'sub-B', model: 'm', tools: [echo] },
      { provider, bus },
    );
    // 父侧 bus 应见到 start / turn / tool_call / stop(子隔离 bus 与之并行)。
    expect(seen).toContain(CoreEventType.SubagentStart);
    expect(seen).toContain(CoreEventType.SubagentTurn);
    expect(seen).toContain(CoreEventType.SubagentToolCall);
    expect(seen).toContain(CoreEventType.SubagentStop);
  });

  test('缺省(无 onSubagentEvent / 无 bus)仍正常跑,零回归', async () => {
    const provider = scripted([[asstText('plain')]]);
    const r = await runSubagent({ input: 'x', model: 'm', tools: [echo] }, { provider });
    expect(r.text).toBe('plain');
    expect(r.terminalReason).toBe('completed');
  });
});

// ─── 4. makeTaskTool + onSubagentEvent collector ────────────────────────────────
describe('makeTaskTool — onSubagentEvent 透传 + registry role 归因', () => {
  test('Task dispatch 子 agent → collector 收到全序列', async () => {
    const provider = scripted([[asstToolUse('t1', 'echo', {})], [asstText('task answer')]]);
    const events: Array<{ type: string; agentId: string; role?: string; reason?: string }> = [];
    const task = makeTaskTool({
      provider,
      model: 'm',
      resolveTools: () => [echo],
      resolveSystem: (t) => `You are a ${t ?? 'general'} subagent.`,
      onSubagentEvent: (ev) => events.push(ev),
    });
    const out = await task.call({ prompt: 'go', subagent_type: 'math' }, { signal: new AbortController().signal });
    expect(out.data.text).toBe('task answer');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('subagent.start');
    expect(types).toContain('subagent.turn');
    expect(types).toContain('subagent.tool_call');
    expect(types[types.length - 1]).toBe('subagent.stop');
  });

  test('registry 类型声明的 role 透传进 start 事件', async () => {
    const provider = scripted([[asstText('done')]]);
    const registry = new SubagentRegistry();
    registry.register({
      name: 'planner',
      description: 'plans',
      systemPrompt: 'You plan.',
      role: 'planner-role',
    });
    const events: Array<{ type: string; role?: string }> = [];
    const task = makeTaskTool({
      provider,
      model: 'm',
      registry,
      allTools: [echo],
      onSubagentEvent: (ev) => events.push(ev),
    });
    await task.call({ prompt: 'plan it', subagent_type: 'planner' }, { signal: new AbortController().signal });
    const start = events.find((e) => e.type === 'subagent.start');
    expect(start?.role).toBe('planner-role');
  });

  test('缺省(无 onSubagentEvent)Task 仍正常 dispatch,零回归', async () => {
    const provider = scripted([[asstText('ok')]]);
    const task = makeTaskTool({ provider, model: 'm', resolveTools: () => [echo] });
    const out = await task.call({ prompt: 'x' }, { signal: new AbortController().signal });
    expect(out.data.terminalReason).toBe('completed');
  });
});
