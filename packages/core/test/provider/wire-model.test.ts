/**
 * wireModel + resolveProvider 的 wire 规整:剥掉 `[1m]` 这类内部标记后缀,
 * 防御泄漏的 ANTHROPIC_MODEL(如 cc 的 claude-opus-4-8[1m])被原样发给 API 导致 401。
 */
import { test, expect, describe } from 'bun:test';
import { wireModel } from '../../src/provider/model-id';
import { registerProvider, resolveProvider } from '../../src/provider/register';
import type { LLMProvider, ProviderStreamEvent } from '../../src/provider/types';

describe('wireModel', () => {
  test('剥掉末尾 [1m] 标记', () => {
    expect(wireModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    expect(wireModel('claude-opus-4-8 [1m]')).toBe('claude-opus-4-8');
    expect(wireModel('claude-sonnet-4-6[beta]')).toBe('claude-sonnet-4-6');
  });
  test('无标记原样返回', () => {
    expect(wireModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(wireModel('gpt-5')).toBe('gpt-5');
  });
  test('多重标记循环剥净 + trim', () => {
    expect(wireModel('  m[x][y]  ')).toBe('m');
  });
  test('空/异常输入防御', () => {
    expect(wireModel('')).toBe('');
    expect(wireModel(undefined as unknown as string)).toBe(undefined as unknown as string);
  });
});

describe('resolveProvider wire 规整', () => {
  test('provider.stream 收到的 req.model 已被剥掉后缀', async () => {
    let seen = '';
    const fake: LLMProvider = {
      api: 'fake-wire-test',
      // eslint-disable-next-line require-yield
      async *stream(req): AsyncIterable<ProviderStreamEvent> {
        seen = req.model;
        return;
      },
    };
    registerProvider('fake-wire-test', () => fake);
    const p = resolveProvider('fake-wire-test', {} as never);
    for await (const _ of p.stream({ model: 'claude-opus-4-8[1m]', messages: [] } as never, {} as never)) {
      void _;
    }
    expect(seen).toBe('claude-opus-4-8');
  });
});
