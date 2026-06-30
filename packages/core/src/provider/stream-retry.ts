/**
 * streamWithRetry (T23) — wraps `LLMProvider.stream` with the C4 retry + model
 * fallback policy on the ACTUAL streaming path (PROV 留的集成点)。
 *
 * 流创建期/首事件前的可重试错误(429/5xx/conn)→ 指数退避重试;
 * `FallbackTriggeredError`(529 连发达阈值)→ 切 fallbackModel 重试。**一旦已吐出
 * 事件(mid-stream)就不再重试**(mid-stream fallback 不安全,会重复执行工具)——直接抛,
 * 由上层 LOOP 收尾(mid-stream fallback 不安全的谨慎处置)。
 * Boundary: 仅 core 相对 import。
 */
import type { LLMProvider, ProviderRequest, ProviderCallOpts, ProviderStreamEvent } from './types';
import { FallbackTriggeredError } from './types';
import { getRetryDelay, shouldRetry, getDefaultMaxRetries } from './retry';

export interface StreamRetryConfig {
  maxRetries?: number;
  /** 测试可注入(默认 setTimeout)。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function retryAfterHeader(err: unknown): string | null {
  const e = err as { retryAfterMs?: number };
  if (typeof e?.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) {
    return String(Math.round(e.retryAfterMs / 1000));
  }
  return null;
}

export async function* streamWithRetry(
  provider: LLMProvider,
  req: ProviderRequest,
  opts: ProviderCallOpts,
  cfg: StreamRetryConfig = {},
): AsyncIterable<ProviderStreamEvent> {
  const maxRetries = cfg.maxRetries ?? getDefaultMaxRetries();
  const sleep = cfg.sleep ?? defaultSleep;
  let model = req.model;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (opts.signal.aborted) return;
    let started = false;
    try {
      for await (const ev of provider.stream({ ...req, model }, opts)) {
        started = true;
        yield ev;
      }
      return; // 正常结束
    } catch (err) {
      // 模型 fallback:529 连发触发,切 fallbackModel 重来。
      if (err instanceof FallbackTriggeredError && opts.fallbackModel && !started) {
        opts.onStreamingFallback?.();
        model = opts.fallbackModel;
        continue;
      }
      // 已吐事件 / 不可重试 / 次数耗尽 → 抛给上层。
      if (started || !shouldRetry(err) || attempt > maxRetries || opts.signal.aborted) throw err;
      await sleep(getRetryDelay(attempt, retryAfterHeader(err)));
    }
  }
}
