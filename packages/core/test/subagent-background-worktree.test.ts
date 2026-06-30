/**
 * L6 / P2 测试:run_in_background(后台登记)+ isolation='worktree'(隔离工作区,优雅降级)。
 *
 * 两特性均**加性 + 默认关**:
 *   - 不注入 deps.background ⇒ run_in_background 被忽略,照常同步跑(零回归)。
 *   - isolation 未设 ⇒ worktree 接缝完全不触碰。
 *   - 非 git cwd ⇒ worktree 建失败,优雅降级回原 cwd(子照常跑)。
 */
import { test, expect, describe } from 'bun:test';
import { makeTaskTool, type SubagentResult } from '../src/agent/subagent';
import { BackgroundTasks, createBackgroundTasks } from '../src/agent/background';
import { buildTool } from '../src/capability/types';
import type { LLMProvider, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

function asstText(text: string): ProviderStreamEvent {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, usage: EMPTY_USAGE as Usage, stopReason: 'end_turn' };
}
function scripted(turns: ProviderStreamEvent[][]): LLMProvider {
  let n = 0;
  return { api: 'stub', async *stream() { const t = turns[Math.min(n, turns.length - 1)]; n++; for (const e of t) yield e; } };
}
const echo = buildTool({
  name: 'echo', isConcurrencySafe: () => true, isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }), maxResultSizeChars: 1000,
});

// ─── BackgroundTasks 单元 ───────────────────────────────────────────────────

describe('BackgroundTasks — 单调 id + settle 回调', () => {
  test('start 立即返回单调 id;promise settle 后回调 onDone 并摘除', async () => {
    const dones: Array<{ id: string; result?: number; error?: unknown }> = [];
    const bg = createBackgroundTasks<number>({ onDone: (d) => dones.push(d) });
    let resolve1!: (v: number) => void;
    const p1 = new Promise<number>((r) => { resolve1 = r; });
    const id1 = bg.start('first', p1);
    const id2 = bg.start('second', Promise.resolve(99));
    expect(id1).toBe('bg#1');
    expect(id2).toBe('bg#2'); // 单调,不依赖时间/随机
    expect(bg.size).toBe(2);
    resolve1(7);
    await Promise.resolve(); await Promise.resolve();
    // p2 已 resolve、p1 刚 resolve → 两者都回调并摘除
    expect(bg.size).toBe(0);
    expect(dones.find((d) => d.id === 'bg#1')?.result).toBe(7);
    expect(dones.find((d) => d.id === 'bg#2')?.result).toBe(99);
  });

  test('reject 走 error 分支;onDone 抛错被吞,不外溢', async () => {
    const errs: unknown[] = [];
    const bg = new BackgroundTasks<number>({ onDone: (d) => { errs.push(d.error); throw new Error('onDone boom'); } });
    bg.start('x', Promise.reject(new Error('child failed')));
    await Promise.resolve(); await Promise.resolve();
    expect((errs[0] as Error).message).toBe('child failed');
    expect(bg.size).toBe(0); // 即便 onDone 抛错也摘除了
  });

  test('idPrefix 可覆盖', () => {
    const bg = new BackgroundTasks({ idPrefix: 'job' });
    expect(bg.start('a', Promise.resolve(1))).toBe('job#1');
  });
});

// ─── Task 工具 run_in_background ────────────────────────────────────────────

describe('makeTaskTool — run_in_background', () => {
  test('注入 background + flag ⇒ 不 await,返回占位结果(id=...),子跑完回调 onDone', async () => {
    const provider = scripted([[asstText('bg child answer')]]);
    const dones: Array<{ id: string; result?: SubagentResult }> = [];
    const bg = new BackgroundTasks<SubagentResult>();
    const task = makeTaskTool({
      provider, model: 'm',
      resolveTools: () => [echo],
      background: bg,
      onBackgroundDone: (d) => dones.push(d),
    });
    const out = await task.call(
      { prompt: 'run in bg', run_in_background: true, description: 'bgjob' },
      { signal: new AbortController().signal },
    );
    // 立即占位:turns/toolCalls 为 0,text 含 id
    expect(out.data.turns).toBe(0);
    expect(out.data.toolCalls).toBe(0);
    expect(out.data.terminalReason).toBe('completed');
    expect(out.data.text).toContain('id=bg#1');
    // 等后台子 loop settle(它内部跑 async generator,需多个 microtask)→ 轮询到摘除为止。
    for (let i = 0; i < 200 && bg.size > 0; i++) await new Promise((r) => setImmediate(r));
    expect(dones.length).toBe(1);
    expect(dones[0].id).toBe('bg#1');
    expect(dones[0].result?.text).toBe('bg child answer');
  });

  test('未注入 background ⇒ run_in_background 被忽略,照常同步跑(零回归)', async () => {
    const provider = scripted([[asstText('sync answer')]]);
    const task = makeTaskTool({ provider, model: 'm', resolveTools: () => [echo] });
    const out = await task.call(
      { prompt: 'x', run_in_background: true },
      { signal: new AbortController().signal },
    );
    // 同步路径:拿到真实结果,不是占位
    expect(out.data.text).toBe('sync answer');
    expect(out.data.turns).toBeGreaterThanOrEqual(1);
  });
});

// ─── Task 工具 isolation='worktree'(优雅降级)────────────────────────────────

describe('makeTaskTool — isolation worktree 优雅降级', () => {
  test('非 git cwd ⇒ worktree 建失败,降级回原 cwd,子照常跑出结果', async () => {
    const provider = scripted([[asstText('wt-degraded answer')]]);
    const task = makeTaskTool({
      provider, model: 'm',
      resolveTools: () => [echo],
      // 给一个绝不是 git 仓的 cwd → createChildWorktree 返回 null,降级。
      toolContext: { cwd: '/nonexistent-not-a-git-repo-xyz' },
    });
    const out = await task.call(
      { prompt: 'x', isolation: 'worktree' },
      { signal: new AbortController().signal },
    );
    expect(out.data.text).toBe('wt-degraded answer');
    expect(out.data.terminalReason).toBe('completed');
  });

  test('isolation 未设 ⇒ 接缝不触碰,与从前一致', async () => {
    const provider = scripted([[asstText('normal')]]);
    const task = makeTaskTool({ provider, model: 'm', resolveTools: () => [echo] });
    const out = await task.call({ prompt: 'x' }, { signal: new AbortController().signal });
    expect(out.data.text).toBe('normal');
  });
});
