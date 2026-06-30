/**
 * Subagent 自压缩 e2e(忠实 stub,确定性,无网络)——补齐 subagent「子自压缩」的严格覆盖。
 *
 * 背景 / 为什么需要这文件:
 *   - test/subagent.test.ts 只用**假 `always` 策略 + stub provider**验「子 loop honors 注入
 *     的 compaction」这个接线,没跑生产那套真压缩;
 *   - test/context-compaction-stress.e2e.test.ts 跑了**真生产接线**(makeProviderCompaction +
 *     真水位 + per-model 窗口 + PTL 形状),但走的是**主 loop**(ForgeaxCoreKernel.runTurn),
 *     **不覆盖 subagent**。
 *   本文件把二者交叉点补上:让 **subagent**(runSubagent / makeTaskTool)走**真 makeProviderCompaction**,
 *   用忠实 stub(汇报真实 inputTokens、summarize 调用可辨识、能抛真/规范 PTL 形状)驱动子上下文
 *   过水位,断言:子真压缩了 + 子压缩后仍正确收尾 + transcript→result 跨压缩仍成立 + per-model
 *   窗口真的管着子的压缩时机。
 *
 * 与生产一致的关键(对照 agent.ts:518-540 自压缩路径):
 *   - 水位 = computeWatermarks(contextWindow):autoCompactThreshold = (W-20000)-13000 = W-33000;
 *   - 首轮 tokenCount 用 char/4 估算(lastPromptTokens=0)→ 大输入即可在首轮触发 proactive 压缩;
 *   - summarize 调用由其 system 模板「create a detailed summary」辨识(= 压缩真的发生)。
 */
import { test, expect, describe } from 'bun:test';
import { runSubagent, makeTaskTool } from '../src/agent/subagent';
import { LLMCompactionStrategy, makeProviderSummarize } from '../src/context/compaction-llm';
import { buildTool } from '../src/capability/types';
import type { LLMProvider as _LLMProviderForCompaction } from '../src/provider/types';

/**
 * 集成接缝迁移(2026-06-22):legacy `makeProviderCompaction(provider, model)` 工厂已被
 * compaction 重构删除(生产侧 facade/useAgent 改走 compactionV2.summarize)。subagent 的
 * `compaction?: CompactionStrategy` 注入面仍在,故本 e2e 用仍导出的构件原样复刻该工厂:
 *   makeProviderCompaction(p, m) ≡ new LLMCompactionStrategy({ summarize: makeProviderSummarize(p, m) })
 * 仅做接缝重连,不改任何压缩逻辑/断言。
 */
function makeProviderCompaction(provider: _LLMProviderForCompaction, model: string) {
  return new LLMCompactionStrategy({ summarize: makeProviderSummarize(provider, model) });
}
import type {
  LLMProvider,
  ProviderRequest,
  ProviderStreamEvent,
  Usage,
  ProviderCallOpts,
} from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

const CHARS_PER_TOKEN = 4;

function contentChars(content: unknown): number {
  return typeof content === 'string' ? content.length : JSON.stringify(content).length;
}
/** 复刻 loop 的 char/4 估算(agent.ts:estimateTokens)——req 规模 → token 数。 */
function estimateReqTokens(req: ProviderRequest): number {
  let chars = 0;
  for (const b of req.system) chars += (b.text ?? '').length;
  for (const m of req.messages) chars += contentChars(m.content);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
/** 用 summarize prompt 模板辨识「这是一次压缩摘要调用」(= 压缩真触发)。 */
function isSummarizeReq(req: ProviderRequest): boolean {
  return req.system.some((b) => typeof b.text === 'string' && b.text.includes('create a detailed summary'));
}

interface StubCall {
  isSummary: boolean;
  promptTokens: number;
  model: string;
}
interface StubOpts {
  windowByModel?: Record<string, number>;
  defaultWindow?: number;
  /** 主回答文本(非 summary 调用返回);用于断言「父拿到的是最终答案,不是摘要」。 */
  mainText?: string;
}
/**
 * 忠实 stub provider:
 *  - 汇报 `usage.inputTokens` = 真实 prompt 规模(驱动 loop 的真实 token 账);
 *  - prompt 超过该 model 的真实窗口时抛**真 anthropic 400 形状**(status=400);
 *  - summarize 调用返回摘要文本、主调用返回 mainText —— 二者可区分。
 */
function makeStubProvider(opts: StubOpts = {}) {
  const calls: StubCall[] = [];
  const windowByModel = opts.windowByModel ?? {};
  const defaultWindow = opts.defaultWindow ?? 200_000;
  const mainText = opts.mainText ?? 'CHILD_FINAL_ANSWER';

  const provider: LLMProvider = {
    api: 'stub-anthropic',
    async *stream(req: ProviderRequest, _o?: ProviderCallOpts): AsyncIterable<ProviderStreamEvent> {
      const isSummary = isSummarizeReq(req);
      const promptTokens = estimateReqTokens(req);
      calls.push({ isSummary, promptTokens, model: req.model });
      const window = windowByModel[req.model] ?? defaultWindow;

      if (promptTokens > window) {
        const err = new Error(
          `anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: ${promptTokens} tokens > ${window} maximum"}}`,
        ) as Error & { status: number };
        err.status = 400;
        throw err;
      }
      const usage: Usage = { ...EMPTY_USAGE, inputTokens: promptTokens, outputTokens: 12 };
      const text = isSummary ? '<summary>\nCondensed prior conversation.\n</summary>' : mainText;
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

const echo = buildTool({
  name: 'echo',
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  call: async (i: unknown) => ({ data: i }),
  mapResult: (o, id) => ({ type: 'tool.result', payload: { id, o }, ts: 0 }),
  maxResultSizeChars: 1000,
});

const MODEL = 'claude-opus-4-8';
// W=40000 → autoCompactThreshold = 40000-33000 = 7000 tokens = 28000 chars。
const SMALL_WINDOW = 40_000;
const THRESHOLD_TOKENS = SMALL_WINDOW - 33_000; // 7000
// 远超阈值、但远低于窗口(避免主调用 PTL,隔离出 proactive 自压缩路径)。
const bigInput = 'x'.repeat((THRESHOLD_TOKENS + 1_000) * CHARS_PER_TOKEN); // ~32000 chars ≈ 8000 tok
const smallInput = 'do a tiny task'; // 远低于阈值

const summaryCount = (calls: StubCall[]) => calls.filter((c) => c.isSummary).length;

describe('subagent 自压缩 — runSubagent 走真 makeProviderCompaction', () => {
  test('子上下文过水位 → 真压缩触发(summarize 被调)且子仍正确收尾', async () => {
    const { provider, calls } = makeStubProvider({ defaultWindow: SMALL_WINDOW, mainText: 'CHILD_DONE_OK' });
    const r = await runSubagent(
      {
        input: bigInput,
        model: MODEL,
        tools: [echo],
        leadingSystemText: 'You are a worker subagent.',
        compaction: makeProviderCompaction(provider, MODEL), // ← 生产同款真压缩
        contextWindow: SMALL_WINDOW,
      },
      { provider },
    );
    expect(summaryCount(calls)).toBeGreaterThanOrEqual(1); // 子真的压缩了(发生了 summarize 调用)
    expect(r.terminalReason).toBe('completed'); // 压缩后子正常收尾
    expect(r.text).toBe('CHILD_DONE_OK'); // 子返回的是最终答案,不是摘要
  });

  test('零回归:小输入(低于水位)不压缩,子照常完成', async () => {
    const { provider, calls } = makeStubProvider({ defaultWindow: SMALL_WINDOW, mainText: 'SMALL_OK' });
    const r = await runSubagent(
      { input: smallInput, model: MODEL, tools: [echo], compaction: makeProviderCompaction(provider, MODEL), contextWindow: SMALL_WINDOW },
      { provider },
    );
    expect(summaryCount(calls)).toBe(0); // 未触发压缩
    expect(r.terminalReason).toBe('completed');
    expect(r.text).toBe('SMALL_OK');
  });
});

describe('subagent 自压缩 — per-model 窗口真的管着子的压缩时机', () => {
  test('同一大输入:大窗口不压缩 / 小窗口压缩(contextWindow 治理生效)', async () => {
    // 大窗口:阈值 = 200000-33000 = 167000 tok,远高于 ~8000 → 不压缩。
    const big = makeStubProvider({ defaultWindow: 200_000 });
    const rBig = await runSubagent(
      { input: bigInput, model: MODEL, tools: [echo], compaction: makeProviderCompaction(big.provider, MODEL), contextWindow: 200_000 },
      { provider: big.provider },
    );
    expect(summaryCount(big.calls)).toBe(0);
    expect(rBig.terminalReason).toBe('completed');

    // 小窗口:同输入越过阈值 → 压缩。
    const small = makeStubProvider({ defaultWindow: SMALL_WINDOW });
    const rSmall = await runSubagent(
      { input: bigInput, model: MODEL, tools: [echo], compaction: makeProviderCompaction(small.provider, MODEL), contextWindow: SMALL_WINDOW },
      { provider: small.provider },
    );
    expect(summaryCount(small.calls)).toBeGreaterThanOrEqual(1);
    expect(rSmall.terminalReason).toBe('completed');
  });
});

describe('subagent 自压缩 — transcript→result 跨压缩仍成立(makeTaskTool 路径)', () => {
  test('子内发生压缩,父(Task)只拿到子的最终答案,不外溢摘要/中间步骤', async () => {
    const { provider, calls } = makeStubProvider({ defaultWindow: SMALL_WINDOW, mainText: 'PARENT_SEES_THIS' });
    const task = makeTaskTool({
      provider,
      model: MODEL,
      resolveTools: () => [echo],
      compaction: makeProviderCompaction(provider, MODEL), // 子自压缩(CLI main.ts:192 同款接线)
      contextWindow: SMALL_WINDOW,
    });
    const out = await task.call({ prompt: bigInput }, { signal: new AbortController().signal });

    expect(summaryCount(calls)).toBeGreaterThanOrEqual(1); // 子确实压缩过
    expect(out.data.terminalReason).toBe('completed');
    expect(out.data.text).toBe('PARENT_SEES_THIS'); // 父只见最终答案
    expect(out.data.text).not.toContain('summary'); // 摘要文本没外溢到父

    const ev = task.mapResult(out.data, 'call1') as { payload: { ok: boolean; result: string } };
    expect(ev.payload.ok).toBe(true);
    expect(ev.payload.result).toBe('PARENT_SEES_THIS');
  });
});
