/**
 * usage-stats (A 层 · 015 /context + /cost) tests — summarizeUsage + contextStats 纯计算。
 *
 * Covers: cost 拆解算术(input/output/cacheWrite/cacheRead)、cacheWrite/cacheRead
 * 缺省推导、未知模型 fallback(费用 0 + pricingKnown=false)、空 usage;
 * contextStats 窗口/百分比/距水位余量、number vs history 两种入参、未知模型 200k 默认、
 * 1M 长上下文模型窗口、override 注入。
 */
import { test, expect, describe } from 'bun:test';
import {
  summarizeUsage,
  contextStats,
  lookupModelPricing,
  FALLBACK_PRICING,
} from '../src/context/usage-stats';
import { computeWatermarksFromModel } from '../src/context/watermarks';
import { lookupModelContext } from '../src/context/model-context-table';
import type { Usage } from '../src/provider/types';

const usage = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  ...over,
});

// ─── summarizeUsage ───────────────────────────────────────────────────────────

describe('summarizeUsage — cost 拆解与单价', () => {
  test('opus 单价:input/output 按 15/75 per 1M 折算', () => {
    const s = summarizeUsage(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), 'claude-opus-4-8');
    expect(s.cost.inputUsd).toBeCloseTo(15, 6);
    expect(s.cost.outputUsd).toBeCloseTo(75, 6);
    expect(s.cost.totalUsd).toBeCloseTo(90, 6);
    expect(s.pricingKnown).toBe(true);
  });

  test('cacheWrite/cacheRead 缺省推导:write=input×1.25 read=input×0.1', () => {
    const s = summarizeUsage(
      usage({ cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
      'claude-sonnet-4',
    );
    // sonnet input = 3 → write 3.75 / read 0.3
    expect(s.cost.cacheWriteUsd).toBeCloseTo(3.75, 6);
    expect(s.cost.cacheReadUsd).toBeCloseTo(0.3, 6);
    expect(s.pricing.cacheWritePerMillion).toBeCloseTo(3.75, 6);
    expect(s.pricing.cacheReadPerMillion).toBeCloseTo(0.3, 6);
  });

  test('token 汇总:totalInput = input + cacheWrite + cacheRead;totalTokens 含 output', () => {
    const s = summarizeUsage(
      usage({ inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 200, cacheReadInputTokens: 300 }),
      'claude-sonnet-4',
    );
    expect(s.totalInputTokens).toBe(600);
    expect(s.totalTokens).toBe(650);
  });

  test('未知模型:费用 0、pricingKnown=false、token 仍如实汇总', () => {
    const s = summarizeUsage(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), 'totally-unknown-model');
    expect(s.cost.totalUsd).toBe(0);
    expect(s.pricingKnown).toBe(false);
    expect(s.inputTokens).toBe(1_000_000);
  });

  test('undefined usage / undefined model:全 0,不抛', () => {
    const s = summarizeUsage(undefined, undefined);
    expect(s.totalTokens).toBe(0);
    expect(s.cost.totalUsd).toBe(0);
    expect(s.pricingKnown).toBe(false);
  });

  test('pricingOverrides 精确覆写优先', () => {
    const s = summarizeUsage(usage({ inputTokens: 1_000_000 }), 'my-model', {
      pricingOverrides: { 'my-model': { inputPerMillion: 10, outputPerMillion: 20 } },
    });
    expect(s.cost.inputUsd).toBeCloseTo(10, 6);
    expect(s.pricingKnown).toBe(true);
  });
});

describe('lookupModelPricing', () => {
  test('子串匹配 + 未知走 FALLBACK', () => {
    expect(lookupModelPricing('claude-opus-4-8[1m]')).not.toBe(FALLBACK_PRICING);
    expect(lookupModelPricing('nope')).toBe(FALLBACK_PRICING);
    expect(lookupModelPricing(undefined)).toBe(FALLBACK_PRICING);
  });
});

// ─── contextStats ─────────────────────────────────────────────────────────────

describe('contextStats — 窗口 / 百分比 / 距水位', () => {
  test('200k 默认窗口:百分比与距水位与 computeWatermarksFromModel 一致', () => {
    const tokens = 100_000;
    const st = contextStats(tokens, 'claude-sonnet-4');
    const info = lookupModelContext('claude-sonnet-4');
    const marks = computeWatermarksFromModel(info);

    expect(st.contextWindow).toBe(200_000);
    expect(st.effectiveWindow).toBe(marks.effectiveWindow);
    expect(st.preCompactThreshold).toBe(marks.preCompactThreshold);
    expect(st.tokensToPreCompact).toBe(marks.preCompactThreshold - tokens);
    expect(st.tokensToBlocking).toBe(marks.blockingLimit - tokens);
    expect(st.percentUsed).toBeCloseTo((tokens / 200_000) * 100, 6);
    expect(st.percentOfEffective).toBeCloseTo((tokens / marks.effectiveWindow) * 100, 6);
  });

  test('1M 长上下文模型:窗口取 1_000_000', () => {
    const st = contextStats(500_000, 'claude-opus-4-8[1m]');
    expect(st.contextWindow).toBe(1_000_000);
  });

  test('未知模型走 200k 默认窗口', () => {
    const st = contextStats(10_000, 'unknown-x');
    expect(st.contextWindow).toBe(200_000);
  });

  test('入参为消息历史时用 estimateTokens 粗估', () => {
    const history = [{ role: 'user', content: 'a'.repeat(4000) }]; // ~1000 token
    const st = contextStats(history, 'claude-sonnet-4');
    expect(st.tokens).toBe(1000);
  });

  test('越过 preCompact 水位时余量为负', () => {
    const st = contextStats(10_000_000, 'claude-sonnet-4');
    expect(st.tokensToPreCompact).toBeLessThan(0);
    expect(st.percentUsed).toBeGreaterThan(100);
  });

  test('modelOverrides 注入自定义窗口', () => {
    const st = contextStats(1000, 'tiny', { modelOverrides: { tiny: { contextWindow: 8_000 } } });
    expect(st.contextWindow).toBe(8_000);
  });
});
