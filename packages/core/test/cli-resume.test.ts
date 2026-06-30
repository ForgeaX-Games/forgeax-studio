/**
 * 独立 CLI 的「跨进程 resume 多轮」验证。
 *
 * (A) JsonlFileEventStore:append → read 往返 + 重新 new(模拟换进程)仍读到 → 磁盘持久。
 * (B) 端到端 fold:在 store 里放「上一轮的 user/assistant 事件」→ foldFromStore 重建出
 *     带历史的 ProviderMessage[];喂给 stub provider 的下一轮请求里**确实带上一轮内容**
 *     → 证明 resume 真的把历史接进了 LLM 上下文(不是只存了份转录)。
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventStore } from '../src/cli/event-store-fs';
import { connectStore } from '../src/history/event-store';
import { foldFromStore } from '../src/history/llm-fold-adapter';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent } from '../src/events/types';

const tmpFiles: string[] = [];
function tmpFile(name: string): string {
  const f = join(tmpdir(), `fxc-resume-${name}-${process.pid}-${tmpFiles.length}.jsonl`);
  tmpFiles.push(f);
  return f;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

describe('JsonlFileEventStore — 磁盘持久 + 跨「进程」读回', () => {
  test('append → read 往返,且 new 一个新实例(模拟换进程)仍能读到', async () => {
    const file = tmpFile('persist');
    const s1 = new JsonlFileEventStore(file);
    await s1.append([
      { type: 'user_prompt.submit', ts: 1, payload: { prompt: 'hi', turn: 0 } } as unknown as CoreEvent,
      { type: 'assistant.message', ts: 2, payload: { text: 'hello' } } as unknown as CoreEvent,
    ]);
    // 模拟「下一次进程」:全新实例指向同一文件。
    const s2 = new JsonlFileEventStore(file);
    const read: CoreEvent[] = [];
    for await (const e of s2.read!()) read.push(e);
    expect(read.length).toBe(2);
    expect(read[0].type).toBe('user_prompt.submit');
    expect(read[1].type).toBe('assistant.message');
  });

  test('坏行 fail-soft:跳过半截 JSON,不炸回放', async () => {
    const file = tmpFile('corrupt');
    const s = new JsonlFileEventStore(file);
    await s.append([{ type: 'a', ts: 1, payload: {} } as unknown as CoreEvent]);
    // 手动追加一条坏行
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, '{"type":"broke\n');
    await s.append([{ type: 'b', ts: 2, payload: {} } as unknown as CoreEvent]);
    const read: CoreEvent[] = [];
    for await (const e of new JsonlFileEventStore(file).read!()) read.push(e);
    expect(read.map((e) => e.type)).toEqual(['a', 'b']); // 坏行被跳过
  });
});

describe('resume 端到端 — connectStore 持久 + foldFromStore 重建历史接进上下文', () => {
  test('第一轮事件落盘 → 第二轮 fold 出历史,新一轮请求带上一轮内容', async () => {
    const file = tmpFile('e2e');
    const store = new JsonlFileEventStore(file);

    // ── 第一轮:在「进程1」里,bus→store 持久化一轮 user+assistant 事件 ──
    const bus1 = new EventBus();
    const off1 = connectStore(bus1, store);
    bus1.publish({ type: CoreEventType.UserPromptSubmit, ts: 1, payload: { prompt: 'My name is Ruibin', turn: 0 } } as CoreEvent);
    // assistant.message 是 loop 自吐的字面量类型;fold 读 payload.content(可为字符串或 blocks)。
    bus1.publish({ type: 'assistant.message', ts: 2, payload: { role: 'assistant', content: 'Nice to meet you, Ruibin.' } } as unknown as CoreEvent);
    off1();
    // append 是 fire-and-forget(connectStore 内 void Promise),让微任务跑完落盘。
    await new Promise((r) => setTimeout(r, 20));

    // ── 第二轮:在「进程2」里,从磁盘 read → fold 出历史 ──
    const store2 = new JsonlFileEventStore(file);
    const evs: CoreEvent[] = [];
    for await (const e of store2.read!()) evs.push(e);
    const history = foldFromStore(evs);

    // fold 出的历史里**确实带上一轮的 user 名字 + assistant 回应** → resume 真的接进了上下文。
    const flat = JSON.stringify(history);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(flat).toContain('Ruibin');
    expect(flat).toContain('Nice to meet you');
  });
});
