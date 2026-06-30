/**
 * --demo 用的内置 provider:不打网络,回显一句,证明 CLI/TUI 形态闭环(免 API key)。
 *
 * 从 cli/main.ts 抽出,供 main.ts(headless)与 host-context(TUI driver)共用。
 * Boundary(HOST 层):仅 core 相对 import。
 */
import type { LLMProvider, ProviderStreamEvent, Usage } from '../provider/types';
import { EMPTY_USAGE } from '../provider/types';

export function demoProvider(): LLMProvider {
  return {
    api: 'demo',
    async *stream(req): AsyncIterable<ProviderStreamEvent> {
      const last = req.messages.at(-1);
      const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `forgeax-core(demo) 收到: ${text}` }] },
        usage: EMPTY_USAGE as Usage,
        stopReason: 'end_turn',
      };
    },
  };
}
