/**
 * dispatch errorCategory 五类(移植 agentic_os 03.E.1)单测。
 */
import { test, expect, describe } from 'bun:test';
import { dispatchTools, type ErrorCategory } from '../src/agent/dispatch';
import { buildTool, type AgentTool } from '../src/capability/types';

function run(tools: AgentTool[], name: string, input: unknown = {}, signal = new AbortController().signal) {
  return dispatchTools([{ id: 'x', name, input }], { tools, toolContext: {}, signal });
}

describe('errorCategory 就近赋类', () => {
  test('unknown tool → unknown_tool', async () => {
    const [r] = await run([], 'nope');
    expect(r.isError).toBe(true);
    expect(r.errorCategory).toBe<ErrorCategory>('unknown_tool');
    expect((r.result.payload as { errorCategory?: string }).errorCategory).toBe('unknown_tool');
  });

  test('权限 deny → permission_denied', async () => {
    const denied = buildTool({
      name: 'danger',
      checkPermissions: async () => ({ behavior: 'deny', message: 'no' }),
      call: async () => ({ data: 'x' }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const [r] = await run([denied], 'danger');
    expect(r.errorCategory).toBe<ErrorCategory>('permission_denied');
  });

  test('hook block → permission_denied', async () => {
    const t = buildTool({
      name: 'e',
      isConcurrencySafe: () => true,
      call: async () => ({ data: 'x' }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const [r] = await dispatchTools([{ id: 'x', name: 'e', input: {} }], {
      tools: [t],
      toolContext: {},
      signal: new AbortController().signal,
      isBlocked: () => true,
    });
    expect(r.errorCategory).toBe<ErrorCategory>('permission_denied');
  });

  test('handler 抛普通异常 → runtime_error', async () => {
    const t = buildTool({
      name: 'boom',
      isConcurrencySafe: () => true,
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => {
        throw new Error('kaboom');
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const [r] = await run([t], 'boom');
    expect(r.errorCategory).toBe<ErrorCategory>('runtime_error');
  });

  test('超时类 message → timeout', async () => {
    const t = buildTool({
      name: 'slow',
      isConcurrencySafe: () => true,
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => {
        throw new Error('operation timed out after 5s');
      },
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const [r] = await run([t], 'slow');
    expect(r.errorCategory).toBe<ErrorCategory>('timeout');
  });

  test('成功调用 → 无 errorCategory', async () => {
    const t = buildTool({
      name: 'ok',
      isConcurrencySafe: () => true,
      checkPermissions: async () => ({ behavior: 'allow' }),
      call: async () => ({ data: 'fine' }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const [r] = await run([t], 'ok');
    expect(r.isError).toBe(false);
    expect(r.errorCategory).toBeUndefined();
  });
});
