/**
 * 多模态图片输入 — facade 把 TurnRequest.input.attachments 组成 Anthropic image content
 * block,作为 user 消息 content 数组送 provider(无附件则保持纯字符串,零回归)。
 */
import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import type { LLMProvider, ProviderRequest, ProviderStreamEvent, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime/contract';

function asstText(text: string): ProviderStreamEvent {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: EMPTY_USAGE as Usage,
    stopReason: 'end_turn',
  };
}

/** 捕获 provider:记录每次 stream 的 ProviderRequest,便于断言 user 消息 content。 */
function capturing(): { provider: LLMProvider; calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  const provider: LLMProvider = {
    api: 'stub',
    async *stream(r: ProviderRequest) {
      calls.push(r);
      yield asstText('ok');
    },
  } as LLMProvider;
  return { provider, calls };
}

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    session: { threadId: 'th', agentId: 'ag' },
    input: { text: 'describe this' },
    systemPrompt: { charter: 'C', persona: 'P' },
    tools: [],
    budget: { maxTurns: 4 },
    ...over,
  };
}

async function run(kernel: ForgeaxCoreKernel, r: TurnRequest): Promise<KernelEvent[]> {
  const out: KernelEvent[] = [];
  for await (const e of kernel.runTurn(r, new AbortController().signal)) out.push(e);
  return out;
}

function firstUser(calls: ProviderRequest[]): { role: string; content: unknown } {
  const m = calls[0].messages.find((x) => x.role === 'user');
  if (!m) throw new Error('no user message captured');
  return m as { role: string; content: unknown };
}

describe('facade 多模态 — image content block', () => {
  test('无附件 → user content 保持纯字符串(零回归)', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req());
    expect(firstUser(calls).content).toBe('describe this');
  });

  test('base64 图片附件 → content 数组 [text, image]', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'describe this', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'QUJD' }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  });

  test('dataUrl 前缀被剥离 + media_type 从 dataUrl 推断', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'x', attachments: [{ kind: 'image', data: 'data:image/jpeg;base64,WlpaWg==' }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'WlpaWg==' } });
  });

  test('path 附件 → 读盘转 base64 + media_type 从扩展名推断', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-img-'));
    const p = join(dir, 'pic.jpg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);
    writeFileSync(p, bytes);
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'y', attachments: [{ kind: 'image', path: p }] } }));
    const content = firstUser(calls).content as Array<Record<string, unknown>>;
    const src = (content[1] as { source: { media_type: string; data: string } }).source;
    expect(src.media_type).toBe('image/jpeg');
    expect(src.data).toBe(bytes.toString('base64'));
  });

  test('附件无法解析(空 data)→ 退回纯文本', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'z', attachments: [{ kind: 'image' }] } }));
    expect(firstUser(calls).content).toBe('z');
  });

  test('非 image 附件 kind → 跳过,退回纯文本', async () => {
    const { provider, calls } = capturing();
    const k = new ForgeaxCoreKernel({ provider, executeTool: async () => null });
    await run(k, req({ input: { text: 'w', attachments: [{ kind: 'file', data: 'AAAA' }] } }));
    expect(firstUser(calls).content).toBe('w');
  });
});
