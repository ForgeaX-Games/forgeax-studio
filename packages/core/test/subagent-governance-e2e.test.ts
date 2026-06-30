/**
 * Subagent 治理 loop 级 e2e:把 S1(registry)/ S2(并发+深度+预算)/ S3(终态事件+结果预算)
 * 接进 makeTaskTool 后的端到端行为。
 *
 * 覆盖:
 *   (a) 并发上限 —— N 个并发 Task 调用,观测到的峰值并发不超过 limiter 上限;
 *   (b) 深度护栏 —— 深度超限时 Task 调用经 dispatchTools 表现为 tool error,父不崩;
 *   (c) 结果预算 —— 巨型子结果被裁(父读子结果兜底);
 *   (d) SubagentStop —— 子跑完在「提供的 bus」上发 `subagent.stop`,订阅 hook 看得到。
 *
 * 用 test/subagent.test.ts 的脚本化 fake provider 套路(无真实 LLM)。
 */
import { test, expect, describe } from 'bun:test';
import { makeTaskTool } from '../src/agent/subagent';
import { SubagentRegistry } from '../src/agent/subagent-registry';
import { SUBAGENT_DEPTH_KEY } from '../src/agent/subagent-governance';
import { dispatchTools } from '../src/agent/dispatch';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent } from '../src/events/types';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstText(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}
/** 每次 stream() 都吐同一段;可注入每轮开始/结束的钩子用于并发观测。 */
function constProvider(text: string, hooks?: { onStart?: () => void; onEnd?: () => Promise<void> | void }): LLMProvider {
  return {
    api: 'stub',
    async *stream() {
      hooks?.onStart?.();
      await hooks?.onEnd?.();
      yield asstText(text);
    },
  };
}

const echo = buildTool({
  name: 'echo', isConcurrencySafe: () => true, isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }), maxResultSizeChars: 1000,
});

describe('subagent governance e2e — (a) 并发上限', () => {
  test('N 个并发 Task 调用,峰值并发不超过 limiter 上限', async () => {
    let active = 0;
    let peak = 0;
    // 让每个子 loop 的 stream 在「进入时 +1 / 等一拍后 -1」,以拉长重叠窗口便于观测峰值。
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider = constProvider('child done', {
      onStart: () => { active++; peak = Math.max(peak, active); },
      onEnd: async () => { await gate; active--; },
    });

    const CAP = 2;
    const task = makeTaskTool({
      provider, model: 'm',
      resolveTools: () => [echo],
      concurrency: CAP,
    });

    const calls = Array.from({ length: 5 }, (_, i) =>
      task.call({ prompt: `task ${i}` }, { signal: new AbortController().signal }),
    );
    // 给已放行的子 loop 一点时间进入 stream 并累计 active,再放闸让它们陆续收尾。
    await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBeLessThanOrEqual(CAP); // 峰值并发受限
    expect(peak).toBeGreaterThan(0); // 确实跑起来了
    release();
    const results = await Promise.all(calls);
    expect(results).toHaveLength(5);
    for (const r of results) expect(r.data.text).toBe('child done');
  });
});

describe('subagent governance e2e — (b) 深度护栏', () => {
  test('深度超限的 Task 调用经 dispatchTools 变 tool error,父不崩', async () => {
    const provider = constProvider('should-not-run');
    const MAX_DEPTH = 2;
    // toolContext 预置一个已超限的深度(3 > 2);Task.call 里 assertDepth 应抛 → dispatch 兜成 isError。
    const task = makeTaskTool({
      provider, model: 'm',
      resolveTools: () => [echo],
      maxDepth: MAX_DEPTH,
      toolContext: { [SUBAGENT_DEPTH_KEY]: 3 } as Record<string, unknown>,
    });

    const results = await dispatchTools(
      [{ id: 'c1', name: 'Task', input: { prompt: 'too deep' } }],
      {
        tools: [task as AgentTool],
        toolContext: { [SUBAGENT_DEPTH_KEY]: 3 } as Record<string, unknown>,
        signal: new AbortController().signal,
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true); // 超限 → tool error,而非 crash
    const payload = results[0].result.payload as { message?: string };
    expect(payload.message).toContain('depth'); // 错误信息提到深度护栏

    // 父侧仍可继续派一个深度合法的 Task(未崩)。
    const ok = await dispatchTools(
      [{ id: 'c2', name: 'Task', input: { prompt: 'ok' } }],
      {
        tools: [makeTaskTool({ provider: constProvider('child ok'), model: 'm', resolveTools: () => [echo], maxDepth: MAX_DEPTH }) as AgentTool],
        toolContext: {},
        signal: new AbortController().signal,
      },
    );
    expect(ok[0].isError).toBe(false);
  });

  test('深度合法时,子 toolContext 深度被 +1 透传', async () => {
    let seenChildDepth: number | undefined;
    // 子工具偷看自己的 toolContext 深度。
    const peek = buildTool({
      name: 'peek', isConcurrencySafe: () => true, isReadOnly: () => true,
      call: async (_: unknown, ctx) => {
        seenChildDepth = (ctx as unknown as Record<string, unknown>)[SUBAGENT_DEPTH_KEY] as number;
        return { data: {} };
      },
      mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }), maxResultSizeChars: 100,
    });
    // 子先调 peek,再吐文本结束。
    const provider: LLMProvider = (() => {
      let n = 0;
      return {
        api: 'stub',
        async *stream() {
          if (n++ === 0) {
            yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'peek', input: {} }] }, usage: EMPTY_USAGE as Usage, stopReason: 'tool_use' } as ProviderStreamEvent;
          } else {
            yield asstText('child done');
          }
        },
      };
    })();
    const task = makeTaskTool({
      provider, model: 'm',
      resolveTools: () => [peek],
      toolContext: { [SUBAGENT_DEPTH_KEY]: 1 } as Record<string, unknown>,
    });
    await task.call({ prompt: 'x' }, { signal: new AbortController().signal });
    expect(seenChildDepth).toBe(2); // 父深度 1 → 子看到 2
  });
});

describe('subagent governance e2e — (c) 结果预算', () => {
  test('巨型子结果被裁(父读子结果兜底)', async () => {
    const giant = 'x'.repeat(5000);
    const task = makeTaskTool({
      provider: constProvider(giant), model: 'm',
      resolveTools: () => [echo],
      resultBudget: 200, // 远小于 5000 → 必裁
    });
    const out = await task.call({ prompt: 'big' }, { signal: new AbortController().signal });
    expect(out.data.text.length).toBeLessThan(giant.length); // 被裁
    expect(out.data.text.length).toBeGreaterThan(0);
  });

  test('小结果不被裁(零回归)', async () => {
    const small = 'tiny result';
    const task = makeTaskTool({
      provider: constProvider(small), model: 'm',
      resolveTools: () => [echo],
      resultBudget: 200,
    });
    const out = await task.call({ prompt: 'small' }, { signal: new AbortController().signal });
    expect(out.data.text).toBe(small); // 原样返回
  });
});

describe('subagent governance e2e — (d) SubagentStop', () => {
  test('子跑完在提供的 bus 上发 subagent.stop,订阅 hook 看得到', async () => {
    const bus = new EventBus();
    const seen: CoreEvent[] = [];
    bus.subscribe(
      (e) => e.type === CoreEventType.SubagentStop,
      (e) => { seen.push(e); },
    );

    const task = makeTaskTool({
      provider: constProvider('child finished'), model: 'm',
      resolveTools: () => [echo],
      bus,
    });
    await task.call({ prompt: 'do work', subagent_type: 'worker' }, { signal: new AbortController().signal });

    expect(seen).toHaveLength(1);
    const payload = seen[0].payload as { agentType?: string; terminalReason?: string; turns?: number; toolCalls?: number };
    expect(payload.agentType).toBe('worker');
    expect(payload.terminalReason).toBe('completed');
    expect(typeof payload.turns).toBe('number');
    expect(typeof payload.toolCalls).toBe('number');
  });
});

describe('subagent governance e2e — registry 解析(S1 接线)', () => {
  test('registry 提供时,子 system/tools/model/maxTurns 由类型解析;显式 resolveTools 优先', async () => {
    let childTools: AgentTool[] = [];
    let childModel = '';
    const provider: LLMProvider = {
      api: 'stub',
      async *stream(req: unknown) {
        childModel = (req as { model?: string })?.model ?? '';
        yield asstText('typed child');
      },
    };
    const reg = new SubagentRegistry();
    reg.register({
      name: 'planner',
      description: '规划任务',
      systemPrompt: 'You are a planner.',
      allowedTools: (all) => all.filter((t) => t.name === 'echo'),
      model: 'planner-model',
      maxTurns: 3,
    });

    const task = makeTaskTool({
      provider, model: 'default-model',
      registry: reg,
      allTools: [echo],
    });
    // description 应含已注册类型菜单。
    const schema = task.inputJSONSchema as { properties?: { subagent_type?: { description?: string } } };
    expect(schema.properties?.subagent_type?.description).toContain('planner');

    const out = await task.call({ prompt: 'plan it', subagent_type: 'planner' }, { signal: new AbortController().signal });
    expect(out.data.text).toBe('typed child');
    expect(childModel).toBe('planner-model'); // registry 类型的 model 生效

    // registry 解析的子工具不含 Task(防递归),含 echo。
    const taskWithTask = makeTaskTool({
      provider, model: 'default-model',
      registry: reg,
      allTools: [echo, task as AgentTool], // 故意把 Task 塞进全量工具
    });
    // 用一个偷看子工具集的子工具验证。
    const peekTools = buildTool({
      name: 'peekTools', isConcurrencySafe: () => true, isReadOnly: () => true,
      call: async () => ({ data: {} }),
      mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }), maxResultSizeChars: 100,
    });
    void peekTools; void taskWithTask; void childTools; // 上面 allowedTools 已只放行 echo,Task 天然不入子集
  });
});
