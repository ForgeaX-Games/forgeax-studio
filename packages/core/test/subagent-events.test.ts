/**
 * S3 单测 —— emitSubagentStop 在真实 EventBus 上 publish + hook 可改写;
 *           budgetSubagentResult 超限裁剪 / 未超限 / Infinity 三态正确。
 */
import { test, expect, describe } from 'bun:test';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import {
  emitSubagentStop,
  budgetSubagentResult,
  type SubagentStopPayload,
} from '../src/agent/subagent-events';
import { DEFAULT_MCP_RESULT_BUDGET } from '../src/context/tool-result-budget';
import type { CoreEvent } from '../src/events/types';

describe('emitSubagentStop', () => {
  test('在真实 EventBus 上 publish,订阅者收到 subagent.stop 与完整 payload', () => {
    const bus = new EventBus();
    const seen: CoreEvent[] = [];
    bus.subscribe(CoreEventType.SubagentStop, (e) => {
      seen.push(e);
    });

    const payload: SubagentStopPayload = {
      agentId: 'iori-1',
      agentType: 'iori',
      terminalReason: 'completed',
      turns: 3,
      toolCalls: 7,
    };
    const ret = emitSubagentStop(bus, payload);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe(CoreEventType.SubagentStop);
    expect(seen[0]!.payload).toEqual(payload);
    // source 取自 agentId,便于按子 agent 归因。
    expect(seen[0]!.source).toBe('iori-1');
    expect(ret.type).toBe(CoreEventType.SubagentStop);
  });

  test('订阅者可通过 modify 改写事件,返回值反映改写结果', () => {
    const bus = new EventBus();
    bus.subscribe(CoreEventType.SubagentStop, (_e, ctl) => {
      ctl.modify({ source: 'rewritten' });
    });

    const ret = emitSubagentStop(bus, { agentId: 'iori-1' });
    expect(ret.source).toBe('rewritten');
  });

  test('payload 字段全省略也能正常 publish(source=undefined)', () => {
    const bus = new EventBus();
    let got: CoreEvent | undefined;
    bus.subscribe('*', (e) => {
      got = e;
    });

    const ret = emitSubagentStop(bus, {});
    expect(got?.type).toBe(CoreEventType.SubagentStop);
    expect(ret.source).toBeUndefined();
  });
});

describe('budgetSubagentResult', () => {
  test('超限文本被裁剪并带 truncated marker,长度不超过上限', () => {
    const big = 'x'.repeat(DEFAULT_MCP_RESULT_BUDGET + 5_000);
    const out = budgetSubagentResult(big, DEFAULT_MCP_RESULT_BUDGET);
    expect(out.length).toBeLessThan(big.length);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MCP_RESULT_BUDGET);
    expect(out).toContain('[truncated');
  });

  test('未超限文本原样返回', () => {
    const small = 'hello child';
    expect(budgetSubagentResult(small, DEFAULT_MCP_RESULT_BUDGET)).toBe(small);
  });

  test('max === Infinity 时永不裁剪', () => {
    const big = 'y'.repeat(DEFAULT_MCP_RESULT_BUDGET + 100_000);
    expect(budgetSubagentResult(big, Infinity)).toBe(big);
  });
});
