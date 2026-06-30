/**
 * driver 会话续接 + usage 累计(025 §T2 硬化)的回归证据。
 *
 * 用一个**记录请求**的 fake provider 跑两轮 driveTurn,断言:
 *   - 第 2 轮 provider 收到的 messages = [上轮 user, 上轮 assistant, 本轮 user],
 *     即上轮 user 只出现一次(防 seed 引用 convo 被本轮 prompt 污染的重复 bug);
 *   - getUsage() 从 stream 事件累计出真实 token(跨轮累加)。
 */
import { test, expect, describe } from 'bun:test';
import type { LLMProvider, ProviderMessage, ProviderStreamEvent, Usage } from '../../src/provider/types';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';

function recordingProvider(seen: ProviderMessage[][]): LLMProvider {
  return {
    api: 'fake',
    async *stream(req): AsyncIterable<ProviderStreamEvent> {
      seen.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}

describe('driver 会话续接 + usage', () => {
  test('两轮:第二轮历史不重复 + usage 累计', async () => {
    const seen: ProviderMessage[][] = [];
    const provider = recordingProvider(seen);
    const host = await buildHostContext({ model: 'claude-opus-4-8' }, provider);
    const driver = createAgentDriver({ model: 'claude-opus-4-8', providerOverride: provider }, host);

    await driver.driveTurn('one', () => {});
    await driver.driveTurn('two', () => {});

    // 第 1 轮:仅本轮 user。
    expect(seen[0]!.map((m) => m.content)).toEqual(['one']);
    // 第 2 轮:上轮 user + 上轮 assistant + 本轮 user(上轮 user 只一次,本轮 user 居末)。
    const t2 = seen[1]!.map((m) => m.content);
    expect(t2).toEqual(['one', 'reply', 'two']);
    expect(t2.filter((c) => c === 'one')).toHaveLength(1);

    // usage 跨两轮累计(input 10×2 / output 5×2)。
    const u = driver.getUsage();
    expect(u.inputTokens).toBe(20);
    expect(u.outputTokens).toBe(10);

    await driver.dispose();
  });

  test('/clear 后下一轮 provider 不再携带旧历史', async () => {
    const seen: ProviderMessage[][] = [];
    const provider = recordingProvider(seen);
    const host = await buildHostContext({ model: 'claude-opus-4-8' }, provider);
    const driver = createAgentDriver({ model: 'claude-opus-4-8', providerOverride: provider }, host);

    await driver.driveTurn('one', () => {});
    // /clear:清空 driver 持有的 LLM 历史。
    driver.clearHistory();
    await driver.driveTurn('two', () => {});

    // clear 后那一轮:provider 只收到本轮 user,绝无上一轮的 user/assistant。
    expect(seen[1]!.map((m) => m.content)).toEqual(['two']);

    await driver.dispose();
  });
});
