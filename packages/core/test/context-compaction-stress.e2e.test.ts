/**
 * Context-compaction STRESS e2e — drives the REAL production facade
 * (`ForgeaxCoreKernel.runTurn`) with the EXACT production compaction wiring
 * (makeProviderCompaction + microCompact + hardcoded contextWindow:200_000 +
 * real watermark math), feeding fabricated histories as host-owned resume
 * context (`TurnRequest.history`).
 *
 * The only thing stubbed is the network LLM. The stub provider is FAITHFUL to
 * the real anthropic provider in the two ways that matter for compaction:
 *   1. it reports `usage.inputTokens` = the real prompt size (so the loop's
 *      "real token account" path drives the watermark, not just the char/4
 *      first-turn estimate);
 *   2. when a request exceeds the model's real context window it throws the
 *      SAME error shape the real provider throws (`anthropic API error 400: …`
 *      with `.status = 400`, see provider/anthropic.ts:throwHttpError) — NOT the
 *      canonical "Prompt is too long" string that the loop's reactive-recovery
 *      and the LLM-compaction PTL-retry actually look for. A `canonical` mode is
 *      provided to isolate that the retry LOGIC is correct while the production
 *      WIRING is mismatched.
 *
 * Compaction is observable end-to-end: a summarize pass makes an EXTRA provider
 * call whose system prompt carries the compaction template ("create a detailed
 * summary of the conversation"). So `summaryCalls > 0` ⟺ compaction fired, and
 * the post-compaction main call's prompt size proves the history collapsed.
 *
 * Scenarios:
 *   FAC-1  normal same-model compaction (history crosses autoCompactThreshold)
 *   FAC-2  small history → no compaction
 *   FAC-3  brute > 1M tokens, summary overflows, REAL anthropic error shape
 *   FAC-4  moderate overflow, CANONICAL PTL shape → head-truncate retry recovers
 *   FAC-5  brute > 1M, CANONICAL shape → 3 retries insufficient → throws
 *   FAC-6  model switch to a SMALLER-window model (the user's real scenario)
 *   GATE-7 blocking-limit hard bail (CoreAgent-direct watermark gate)
 */
import { test, expect, describe } from 'bun:test';
import { ForgeaxCoreKernel } from '../src/kernel-facade/forgeax-core-kernel';
import { CoreAgent } from '../src/agent/agent';
import type {
  TurnRequest,
  TurnMessage,
  KernelEvent,
  TurnDoneReason,
} from '@forgeax/agent-runtime/contract';
import type {
  LLMProvider,
  ProviderRequest,
  ProviderStreamEvent,
  Usage,
  ProviderCallOpts,
} from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import { buildTool } from '../src/capability/types';

// ─── token model (mirror the loop's char/4 heuristic, agent.ts:estimateTokens) ─
const CHARS_PER_TOKEN = 4;
const tokensToChars = (t: number) => t * CHARS_PER_TOKEN;

function contentChars(content: unknown): number {
  return typeof content === 'string' ? content.length : JSON.stringify(content).length;
}
function estimateReqTokens(req: ProviderRequest): number {
  let chars = 0;
  for (const b of req.system) chars += (b.text ?? '').length;
  for (const m of req.messages) chars += contentChars(m.content);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Detect the LLM-compaction summarize call by its prompt template. */
function isSummarizeReq(req: ProviderRequest): boolean {
  return req.system.some(
    (b) => typeof b.text === 'string' && b.text.includes('create a detailed summary'),
  );
}

// ─── controllable stub provider ───────────────────────────────────────────────
interface StubCall {
  isSummary: boolean;
  promptTokens: number;
  model: string;
}
interface StubOpts {
  /** Real context window per model id. Anything not listed = `defaultWindow`. */
  windowByModel?: Record<string, number>;
  defaultWindow?: number;
  /** Overflow error shape: 'anthropic' = real provider shape (status 400, message
   *  "anthropic API error 400: …"); 'canonical' = "Prompt is too long". */
  errorShape?: 'anthropic' | 'canonical';
}
function makeStubProvider(opts: StubOpts = {}) {
  const calls: StubCall[] = [];
  const windowByModel = opts.windowByModel ?? {};
  const defaultWindow = opts.defaultWindow ?? 200_000;
  const shape = opts.errorShape ?? 'anthropic';

  const provider: LLMProvider = {
    api: 'stub-anthropic',
    async *stream(req: ProviderRequest, _o: ProviderCallOpts): AsyncIterable<ProviderStreamEvent> {
      const isSummary = isSummarizeReq(req);
      const promptTokens = estimateReqTokens(req);
      const model = req.model;
      calls.push({ isSummary, promptTokens, model });
      const window = windowByModel[model] ?? defaultWindow;

      if (promptTokens > window) {
        if (shape === 'canonical') {
          // The shape the loop/strategy actually recognise (provider/types:PROMPT_TOO_LONG_MESSAGE).
          throw new Error(`Prompt is too long: ${promptTokens} tokens > ${window}`);
        }
        // The shape the REAL anthropic provider throws (provider/anthropic.ts:380).
        const err = new Error(
          `anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: ${promptTokens} tokens > ${window} maximum"}}`,
        ) as Error & { status: number };
        err.status = 400;
        throw err;
      }

      const usage: Usage = { ...EMPTY_USAGE, inputTokens: promptTokens, outputTokens: 12 };
      const text = isSummary ? '<summary>\nCondensed prior conversation.\n</summary>' : 'ok done';
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        usage,
        stopReason: 'end_turn',
      };
    },
  };
  return { provider, calls };
}

// ─── fabricated history (resume context) ──────────────────────────────────────
/** Build ~targetTokens of realistic alternating turns (~20k tokens each). */
function buildHistory(targetTokens: number): TurnMessage[] {
  const chunkTokens = 20_000;
  const filler = 'lorem ipsum dolor sit amet '.repeat(
    Math.ceil(tokensToChars(chunkTokens) / 'lorem ipsum dolor sit amet '.length),
  );
  const out: TurnMessage[] = [];
  let acc = 0;
  let i = 0;
  while (acc < targetTokens) {
    const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant';
    out.push({ role, content: `[turn ${i}] ${filler}` });
    acc += chunkTokens;
    i++;
  }
  return out;
}

// ─── facade turn driver ───────────────────────────────────────────────────────
function makeReq(history: TurnMessage[], model?: string): TurnRequest {
  return {
    session: { threadId: 't1', agentId: 'forge' },
    callId: 'c1',
    input: { text: 'Please continue the work.' },
    history,
    systemPrompt: { charter: 'You are Forge.', persona: 'Helpful game-dev agent.' },
    tools: [],
    budget: { maxTurns: 4 },
    ...(model ? { model } : {}),
  };
}

interface TurnOutcome {
  events: KernelEvent[];
  doneReason: TurnDoneReason | null;
  threw: boolean;
  error?: unknown;
}
async function runFacadeTurn(kernel: ForgeaxCoreKernel, req: TurnRequest): Promise<TurnOutcome> {
  const events: KernelEvent[] = [];
  let doneReason: TurnDoneReason | null = null;
  try {
    for await (const ev of kernel.runTurn(req, new AbortController().signal)) {
      events.push(ev);
      if (ev.kind === 'turn.done') doneReason = ev.reason;
    }
    return { events, doneReason, threw: false };
  } catch (error) {
    return { events, doneReason, threw: true, error };
  }
}

function newKernel(provider: LLMProvider): ForgeaxCoreKernel {
  return new ForgeaxCoreKernel({ provider, executeTool: async () => ({}) });
}

// Watermarks for the production-hardcoded 200k window (watermarks.ts):
//   effective = 180k · autoCompact = 167k · warning = 160k · blocking = 177k

describe('FAC: compaction through the real ForgeaxCoreKernel facade', () => {
  test('FAC-1 normal same-model compaction: history > autoCompactThreshold → summarize fires, history collapses, turn completes', async () => {
    const { provider, calls } = makeStubProvider({ defaultWindow: 200_000 });
    const kernel = newKernel(provider);
    // 175k tokens: ≥ autoCompact(167k), < blocking(177k), < window(200k) so the
    // summarize call itself succeeds.
    const out = await runFacadeTurn(kernel, makeReq(buildHistory(175_000)));

    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('stop');
    const summaryCalls = calls.filter((c) => c.isSummary);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1); // compaction fired
    // post-compaction main (non-summary) call must be far smaller than the input history.
    const mainCalls = calls.filter((c) => !c.isSummary);
    expect(mainCalls.length).toBeGreaterThanOrEqual(1);
    expect(mainCalls.at(-1)!.promptTokens).toBeLessThan(20_000);
  });

  test('FAC-2 small history → no compaction', async () => {
    const { provider, calls } = makeStubProvider({ defaultWindow: 200_000 });
    const kernel = newKernel(provider);
    const out = await runFacadeTurn(kernel, makeReq(buildHistory(5_000)));

    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('stop');
    expect(calls.filter((c) => c.isSummary).length).toBe(0); // never compacted
  });

  test('FAC-3 brute >1M tokens, summary overflows, REAL anthropic error shape → recovers (no crash)', async () => {
    const { provider, calls } = makeStubProvider({
      defaultWindow: 200_000,
      errorShape: 'anthropic',
    });
    const kernel = newKernel(provider);
    const out = await runFacadeTurn(kernel, makeReq(buildHistory(1_050_000)));

    // FIX②: isPromptTooLong now recognises the real `status:400 + "prompt is too
    // long"` shape, so the summarize PTL-retry kicks in; FIX④ (0.5 head-drop)
    // converges 1.05M → 525k → 262k → 131k within MAX_PTL_RETRIES.
    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('stop');
    const summaryCalls = calls.filter((c) => c.isSummary);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2); // initial + head-truncate retries
    expect(calls.filter((c) => !c.isSummary).at(-1)!.promptTokens).toBeLessThan(20_000);
  });

  test('FAC-4 moderate overflow + CANONICAL PTL shape → head-truncate retry recovers, turn completes', async () => {
    const { provider, calls } = makeStubProvider({
      defaultWindow: 200_000,
      errorShape: 'canonical',
    });
    const kernel = newKernel(provider);
    // 235k history: summarize input 235k > 200k → 1 canonical PTL → truncate 20%
    // → ~188k < 200k → succeeds on retry.
    const out = await runFacadeTurn(kernel, makeReq(buildHistory(235_000)));

    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('stop');
    const summaryCalls = calls.filter((c) => c.isSummary);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2); // initial + ≥1 PTL retry
  });

  test('FAC-5 brute >1M + CANONICAL shape → 0.5 head-drop converges within MAX_PTL_RETRIES', async () => {
    const { provider, calls } = makeStubProvider({
      defaultWindow: 200_000,
      errorShape: 'canonical',
    });
    const kernel = newKernel(provider);
    const out = await runFacadeTurn(kernel, makeReq(buildHistory(1_050_000)));

    // FIX④: 1.05M · 0.5^3 ≈ 131k < 200k → succeeds on the 3rd retry (was: threw).
    const summaryCalls = calls.filter((c) => c.isSummary);
    expect(summaryCalls.length).toBe(4); // initial + 3 retries (last succeeds)
    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('stop');
  });

  test('FAC-5b unrecoverable single >1M user message (nothing to head-truncate) → graceful prompt_too_long, NO crash', async () => {
    const { provider } = makeStubProvider({ defaultWindow: 200_000, errorShape: 'anthropic' });
    const kernel = newKernel(provider);
    // No history; one ~1.05M-token user input. The summarize prefix is a single
    // message → truncateHeadForPTLRetry returns null → compact() throws.
    const req = makeReq([]);
    req.input = { text: 'x'.repeat(tokensToChars(1_050_000)) };
    const out = await runFacadeTurn(kernel, req);

    // FIX①: proactive compact() is wrapped → graceful terminal instead of a
    // thrown generator that the host would see as an unhandled rejection.
    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('error'); // prompt_too_long → mapReason → 'error'
  });

  test('FAC-6 model switch to a SMALLER-window model: history under 200k watermark but over the switched window → reactive recovery (was model_error)', async () => {
    const { provider, calls } = makeStubProvider({
      windowByModel: { 'claude-small-128k': 128_000 },
      defaultWindow: 200_000,
      errorShape: 'anthropic',
    });
    const kernel = newKernel(provider);
    // 150k history: < autoCompact(167k) so proactive compaction never arms; but
    // > the switched model's real 128k window → provider 400s.
    const out = await runFacadeTurn(
      kernel,
      makeReq(buildHistory(150_000), 'claude-small-128k'),
    );

    // FIX②: the 400 is now recognised as PTL → the loop's reactive-recovery path
    // fires a compaction (a summarize call appears) and retries the same turn,
    // turning the old hard model_error into a graceful recovery.
    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('stop');
    expect(calls.some((c) => c.isSummary)).toBe(true); // reactive compaction fired
  });

  test('FAC-8 1M-window model id ([1m]) raises the watermark → no premature compaction at ~300k', async () => {
    const { provider, calls } = makeStubProvider({ defaultWindow: 1_000_000 });
    const kernel = newKernel(provider);
    // 300k history: would compact under a 200k window (autoCompact 167k), but the
    // [1m] model gets a 1M window (autoCompact 967k) → no compaction.
    const out = await runFacadeTurn(
      kernel,
      makeReq(buildHistory(300_000), 'claude-opus-4-8[1m]'),
    );

    expect(out.threw).toBe(false);
    expect(out.doneReason).toBe('stop');
    expect(calls.filter((c) => c.isSummary).length).toBe(0); // FIX③: window sized to the model
  });
});

// ─── GATE-7: blocking-limit hard bail (CoreAgent-direct watermark gate) ────────
describe('GATE: watermark blocking-limit', () => {
  test('GATE-7 history over blockingLimit and compaction cannot shrink it → done(blocking_limit)', async () => {
    let providerCalled = false;
    const provider: LLMProvider = {
      api: 'stub',
      async *stream() {
        providerCalled = true;
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
          usage: EMPTY_USAGE,
          stopReason: 'end_turn',
        } as ProviderStreamEvent;
      },
    };
    const tool = buildTool({
      name: 'noop',
      call: async () => ({ data: 1 }),
      mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
      maxResultSizeChars: 100,
    });
    const context: AgentContext = {
      agentId: 'g',
      provider,
      config: { systemPromptSlots: [], model: 'm', tools: [tool], maxTurns: 4 },
      toolContext: {},
    };
    // strategy present (so the blocking check runs) but never shrinks anything.
    const inertStrategy = {
      name: 'inert',
      shouldCompact: () => false,
      async compact() {
        return { replacement: {}, coveredFrom: 0, coveredTo: 0 };
      },
    };
    const agent = new CoreAgent({ context, compaction: inertStrategy, contextWindow: 200_000 });

    const events: AgentEvent[] = [];
    for await (const e of agent.run({
      input: { type: 'user', payload: 'hi', ts: 0 },
      // ~185k tokens ≥ blockingLimit(177k); shouldCompact=false so it stays.
      history: buildHistory(185_000).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: (m as { content: unknown }).content,
      })),
    })) {
      events.push(e);
    }

    const last = events.at(-1)!;
    expect(last.type === 'done' && last.terminal.reason).toBe('blocking_limit');
    expect(providerCalled).toBe(false); // bailed before the model call
  });

  test('STOP-9 stopReason model_context_window_exceeded (no compaction) → prompt_too_long, NOT silently completed (FIX④)', async () => {
    const provider: LLMProvider = {
      api: 'stub',
      async *stream() {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [] },
          usage: EMPTY_USAGE,
          stopReason: 'model_context_window_exceeded',
        } as ProviderStreamEvent;
      },
    };
    const context: AgentContext = {
      agentId: 'g',
      provider,
      config: { systemPromptSlots: [], model: 'm', tools: [], maxTurns: 4 },
      toolContext: {},
    };
    const agent = new CoreAgent({ context }); // no compaction strategy
    const events: AgentEvent[] = [];
    for await (const e of agent.run({ input: { type: 'user', payload: 'hi', ts: 0 } })) {
      events.push(e);
    }
    const last = events.at(-1)!;
    // Before the fix, toolUses.length===0 made this branch read as `completed`.
    expect(last.type === 'done' && last.terminal.reason).toBe('prompt_too_long');
  });
});
