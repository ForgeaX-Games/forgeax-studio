/**
 * dispatch-cases — coverage-completion suite for `src/agent/dispatch.ts`.
 *
 * Targets the previously-uncovered runOne / partition / dispatchTools branches:
 *  - unknown tool → error result                              (dispatch.ts:60-61)
 *  - isBlocked hook intercept → "blocked by hook" error       (dispatch.ts:63-64)
 *  - parseInput: inputSchema.parse throws → falls back to raw (dispatch.ts:49-52)
 *  - permission deny → error result, call NOT run             (dispatch.ts:74-81)
 *  - tool.call throws → mapped to error result                (dispatch.ts:88-93)
 *  - parallel batch: ≥2 concurrency-safe tools via Promise.all (dispatch.ts:131-132)
 *  - isConcurrencySafe throws → fail-closed serial            (dispatch.ts:109)
 *  - abort short-circuits remaining batches                   (dispatch.ts:128)
 *  - alias resolution + updatedInput from permission allow
 *
 * Covers: partitionToolCalls + toolExecution.ts.
 */
import { test, expect, describe } from 'bun:test';
import { dispatchTools, partition, type ToolUse } from '../src/agent/dispatch';
import { buildTool, type AgentTool } from '../src/capability/types';
import type { CoreEvent } from '../src/events/types';
import type { PermissionRuleSet } from '../src/permission/rules';

function okResult(o: unknown, id: string): CoreEvent {
  return { type: 'tool.result', payload: { id, o }, ts: 0 };
}

function deps(tools: AgentTool[], over: Partial<Parameters<typeof dispatchTools>[1]> = {}) {
  return {
    tools,
    toolContext: {},
    signal: new AbortController().signal,
    trusted: false,
    ...over,
  };
}

// concurrency-safe read tool
const safeTool = buildTool({
  name: 'safe',
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: okResult,
  maxResultSizeChars: 1000,
});

// not-concurrency-safe (serial) tool (buildTool default isConcurrencySafe=false)
const serialTool = buildTool({
  name: 'serial',
  call: async (i: unknown) => ({ data: i }),
  mapResult: okResult,
  maxResultSizeChars: 1000,
});

// ─── unknown tool ─────────────────────────────────────────────────────────────

describe('dispatch — unknown tool', () => {
  test('unknown tool name → isError result with message', async () => {
    const results = await dispatchTools([{ id: 'x', name: 'ghost', input: {} }], deps([safeTool], { trusted: true }));
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toContain('unknown tool');
  });
});

// ─── hook isBlocked ───────────────────────────────────────────────────────────

describe('dispatch — hook isBlocked intercept', () => {
  test('isBlocked returns true → "blocked by hook" error, call NOT run', async () => {
    let ran = false;
    const tool = buildTool({
      name: 'blockme',
      call: async () => {
        ran = true;
        return { data: 1 };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'b', name: 'blockme', input: {} }], deps([tool], {
      isBlocked: () => true,
    }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toContain('blocked by hook');
    expect(ran).toBe(false);
  });

  test('isBlocked returns false → tool runs normally', async () => {
    const results = await dispatchTools([{ id: 'b', name: 'serial', input: { v: 1 } }], deps([serialTool], {
      isBlocked: () => false,
    }));
    expect(results[0].isError).toBe(false);
  });
});

// ─── parseInput: inputSchema.parse throws → falls back to raw ─────────────────

describe('dispatch — parseInput failure falls back to raw', () => {
  test('inputSchema.parse throws → raw forwarded to call (not crash)', async () => {
    let seen: unknown;
    const throwingSchema = {
      parse(_x: unknown): { v: number } {
        throw new Error('schema mismatch');
      },
      safeParse(): { success: boolean } {
        return { success: false };
      },
    };
    const tool = buildTool<{ v: number }, unknown>({
      name: 'schema',
      inputSchema: throwingSchema,
      isConcurrencySafe: () => false,
      call: async (i) => {
        seen = i;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const raw = { weird: true };
    const results = await dispatchTools([{ id: 's', name: 'schema', input: raw }], deps([tool], { trusted: true }));
    expect(results[0].isError).toBe(false);
    expect(seen).toEqual(raw); // raw passed through after parse threw
  });

  test('inputSchema.parse succeeds → parsed value forwarded', async () => {
    let seen: unknown;
    const tool = buildTool<{ n: number }, unknown>({
      name: 'okschema',
      inputSchema: {
        parse: (x: unknown) => ({ n: (x as { n: number }).n * 2 }),
        safeParse: (x: unknown) => ({ success: true, data: x as { n: number } }),
      },
      call: async (i) => {
        seen = i;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    await dispatchTools([{ id: 'o', name: 'okschema', input: { n: 3 } }], deps([tool], { trusted: true }));
    expect(seen).toEqual({ n: 6 });
  });
});

// ─── permission deny ──────────────────────────────────────────────────────────

describe('dispatch — permission deny', () => {
  test('checkPermissions deny → error result, call NOT run', async () => {
    let ran = false;
    const tool = buildTool({
      name: 'danger',
      checkPermissions: async () => ({ behavior: 'deny', message: 'no way' }),
      call: async () => {
        ran = true;
        return { data: 1 };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'd', name: 'danger', input: {} }], deps([tool]));
    expect(results[0].isError).toBe(true);
    expect(ran).toBe(false);
  });

  test('deny rule (settings) → error result', async () => {
    const rules: Partial<PermissionRuleSet> = { deny: [{ toolName: 'serial', behavior: 'deny' }] };
    const results = await dispatchTools([{ id: 'r', name: 'serial', input: {} }], deps([serialTool], { rules }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toContain('denied');
  });

  test('trusted channel bypasses permission deny entirely', async () => {
    let ran = false;
    const tool = buildTool({
      name: 'danger2',
      checkPermissions: async () => ({ behavior: 'deny', message: 'no' }),
      call: async () => {
        ran = true;
        return { data: 'ok' };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'd', name: 'danger2', input: {} }], deps([tool], { trusted: true }));
    expect(results[0].isError).toBe(false);
    expect(ran).toBe(true);
  });

  test('permission allow updatedInput is passed to call', async () => {
    let seen: unknown;
    const tool = buildTool({
      name: 'rewrite',
      checkPermissions: async () => ({ behavior: 'allow', updatedInput: { rewritten: true } }),
      call: async (i) => {
        seen = i;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    await dispatchTools([{ id: 'w', name: 'rewrite', input: { rewritten: false } }], deps([tool]));
    expect(seen).toEqual({ rewritten: true });
  });
});

// ─── tool.call throws ─────────────────────────────────────────────────────────

describe('dispatch — tool.call throws', () => {
  test('Error thrown in call → mapped to isError result with message', async () => {
    const tool = buildTool({
      name: 'boom',
      call: async () => {
        throw new Error('kaboom');
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'e', name: 'boom', input: {} }], deps([tool], { trusted: true }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toBe('kaboom');
  });

  test('non-Error thrown (string) → stringified message', async () => {
    const tool = buildTool({
      name: 'boom2',
      call: async () => {
        throw 'plain-string-error';
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'e', name: 'boom2', input: {} }], deps([tool], { trusted: true }));
    expect(results[0].isError).toBe(true);
    expect((results[0].result.payload as { message: string }).message).toBe('plain-string-error');
  });
});

// ─── parallel batch (Promise.all) ─────────────────────────────────────────────

describe('dispatch — parallel batch of concurrency-safe tools', () => {
  test('≥2 consecutive safe tools run as one Promise.all batch, results in order', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const par = buildTool({
      name: 'par',
      isConcurrencySafe: () => true,
      call: async (i: unknown) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        order.push((i as { id: string }).id);
        active--;
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const uses: ToolUse[] = [
      { id: 'a', name: 'par', input: { id: 'a' } },
      { id: 'b', name: 'par', input: { id: 'b' } },
      { id: 'c', name: 'par', input: { id: 'c' } },
    ];
    const results = await dispatchTools(uses, deps([par], { trusted: true }));
    // ran concurrently (Promise.all) → more than 1 active at once
    expect(maxActive).toBeGreaterThan(1);
    // output preserves original ordering of uses
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'b', 'c']);
  });
});

// ─── isConcurrencySafe throws → fail-closed serial ───────────────────────────

describe('partition — isConcurrencySafe throws → fail-closed (serial)', () => {
  test('throwing predicate is treated as unsafe → its own serial batch', () => {
    const blowup = buildTool({
      name: 'blowup',
      isConcurrencySafe: () => {
        throw new Error('predicate failed');
      },
      call: async () => ({ data: 1 }),
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const uses: ToolUse[] = [
      { id: '1', name: 'safe', input: {} },
      { id: '2', name: 'blowup', input: {} },
      { id: '3', name: 'safe', input: {} },
    ];
    const batches = partition(uses, [safeTool, blowup]);
    // safe | blowup(serial) | safe → 3 batches
    expect(batches.map((b) => b.map((u) => u.id))).toEqual([['1'], ['2'], ['3']]);
  });

  test('unknown tool in partition → treated as unsafe (its own batch)', () => {
    const uses: ToolUse[] = [
      { id: '1', name: 'safe', input: {} },
      { id: '2', name: 'ghost', input: {} },
    ];
    const batches = partition(uses, [safeTool]);
    expect(batches.map((b) => b.map((u) => u.id))).toEqual([['1'], ['2']]);
  });

  test('end-of-list trailing safe batch flushed', () => {
    const uses: ToolUse[] = [
      { id: '1', name: 'serial', input: {} },
      { id: '2', name: 'safe', input: {} },
      { id: '3', name: 'safe', input: {} },
    ];
    const batches = partition(uses, [serialTool, safeTool]);
    expect(batches.map((b) => b.map((u) => u.id))).toEqual([['1'], ['2', '3']]);
  });
});

// ─── abort short-circuits remaining batches ──────────────────────────────────

describe('dispatch — abort short-circuits remaining batches', () => {
  test('pre-aborted signal → no batches run, empty results', async () => {
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    const tool = buildTool({
      name: 'serial',
      call: async () => {
        ran = true;
        return { data: 1 };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: '1', name: 'serial', input: {} }], deps([tool], { signal: ac.signal, trusted: true }));
    expect(results).toHaveLength(0);
    expect(ran).toBe(false);
  });

  test('abort after first serial batch → remaining batches skipped', async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const tool = buildTool({
      name: 'serial',
      call: async (i: unknown) => {
        const id = (i as { id: string }).id;
        ran.push(id);
        if (id === '1') ac.abort('after-first');
        return { data: i };
      },
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const uses: ToolUse[] = [
      { id: '1', name: 'serial', input: { id: '1' } },
      { id: '2', name: 'serial', input: { id: '2' } },
    ];
    const results = await dispatchTools(uses, deps([tool], { signal: ac.signal, trusted: true }));
    expect(ran).toEqual(['1']); // second batch short-circuited
    expect(results.map((r) => r.toolUseId)).toEqual(['1']);
  });
});

// ─── alias resolution ─────────────────────────────────────────────────────────

describe('dispatch — alias resolution', () => {
  test('tool resolved by alias name', async () => {
    const aliased = buildTool({
      name: 'canonical',
      aliases: ['old_name'],
      call: async (i: unknown) => ({ data: i }),
      mapResult: okResult,
      maxResultSizeChars: 100,
    });
    const results = await dispatchTools([{ id: 'a', name: 'old_name', input: { v: 1 } }], deps([aliased], { trusted: true }));
    expect(results[0].isError).toBe(false);
    expect(results[0].toolName).toBe('old_name');
  });
});
