/**
 * Provider 重试包装 (C4)。
 *
 * 设计：默认重试 + 黑名单 + 指数退避(jitter) + retry-after 优先。
 * - 最多 10 次重试。
 * - 429/408/409/5xx/connection 可重试；4xx(除上述) 不可重试 → CannotRetryError。
 * - 529 连发达 MAX_529_RETRIES(3) 且有 fallbackModel → FallbackTriggeredError，
 *   由 LOOP 决定真正切模型。
 *
 * Boundary：只 import C4 契约（types.ts），不碰 @anthropic-ai/sdk / cli 内部。
 * 错误以 provider 抛出的「带 status / retryAfterMs 的普通对象」为输入——anthropic.ts
 * 的 throwHttpApiError 会打这些字段。
 */

import { CannotRetryError, FallbackTriggeredError } from './types';

const DEFAULT_MAX_RETRIES = 10;
const MAX_529_RETRIES = 3;
export const BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 32000;

/** 错误上提取的字段（provider 打上的 status / retryAfterMs / code / message）。 */
interface ErrorLike {
  status?: number;
  statusCode?: number;
  retryAfterMs?: number;
  retryAfterHeader?: string | null;
  code?: string;
  message?: string;
  cause?: unknown;
}

function asErrorLike(err: unknown): ErrorLike {
  if (typeof err === 'object' && err !== null) return err as ErrorLike;
  return {};
}

export function getStatus(err: unknown): number | undefined {
  const e = asErrorLike(err);
  if (typeof e.status === 'number') return e.status;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return undefined;
}

function getErrorCode(err: unknown): string | undefined {
  const e = asErrorLike(err);
  if (typeof e.code === 'string') return e.code;
  if (e.cause) return getErrorCode(e.cause);
  return undefined;
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = asErrorLike(err);
  if (typeof e.message === 'string') return e.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

/** SDK 有时在流式下不带 529 status，只在 message 里露 overloaded_error。 */
export function is529Error(err: unknown): boolean {
  if (getStatus(err) === 529) return true;
  return getMessage(err).includes('"type":"overloaded_error"');
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/**
 * 计算重试延迟：
 * - retry-after header（秒）优先，直接返回，不受 maxDelayMs 约束（服务端指令）。
 * - 否则指数退避 BASE_DELAY_MS * 2^(attempt-1)，封顶 maxDelayMs，叠加 ≤25% jitter。
 * attempt 从 1 起。
 */
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs);
  const jitter = Math.random() * 0.25 * baseDelay;
  return baseDelay + jitter;
}

/** 从错误里取 retry-after 字符串（provider 已转 retryAfterMs 时优先用之）。 */
function getRetryAfterHeader(err: unknown): string | null {
  const e = asErrorLike(err);
  if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) {
    return String(Math.round(e.retryAfterMs / 1000));
  }
  if (typeof e.retryAfterHeader === 'string') return e.retryAfterHeader;
  return null;
}

/** 终端 HTTP（不重试）。429 不在此列（限流可重试）。 */
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

/** 是否值得重试（默认重试 + 黑名单）。 */
export function shouldRetry(err: unknown): boolean {
  // overloaded_error（SDK 漏 status 的 529）
  if (is529Error(err)) return true;

  const status = getStatus(err);
  if (status !== undefined) {
    if (TERMINAL_STATUSES.has(status)) return false;
    // 429 / 408 / 409 / 5xx 可重试
    if (status === 429 || status === 408 || status === 409) return true;
    if (status >= 500) return true;
    return false;
  }

  // 网络错误码 → 重试
  if (getErrorCode(err)) return true;

  // 无 status 无 code 的未知错误：保守重试
  return true;
}

export function getDefaultMaxRetries(): number {
  const env = process.env.FORGEAX_MAX_RETRIES;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n)) return n;
  }
  return DEFAULT_MAX_RETRIES;
}

export interface WithRetryOptions {
  model: string;
  fallbackModel?: string;
  maxRetries?: number;
  signal?: AbortSignal;
  /** 预置连续 529 计数（流式 529 后转非流式重试时对齐总数）。 */
  initialConsecutive529Errors?: number;
  /** 等待 hook（可注入便于测试；默认真实 setTimeout）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * 重试包装一个 async operation。
 *
 * operation 收到当前 attempt（1 起）；抛错时按分类决定重试/退避/上抛。
 * - aborted → 直接上抛 AbortError（不包 CannotRetryError）。
 * - 529 连发 ≥ MAX_529_RETRIES 且有 fallbackModel → FallbackTriggeredError。
 * - 不可重试 / 重试耗尽 → CannotRetryError(originalError)。
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: WithRetryOptions,
): Promise<T> {
  const maxRetries = options.maxRetries ?? getDefaultMaxRetries();
  const sleep = options.sleep ?? defaultSleep;
  let consecutive529 = options.initialConsecutive529Errors ?? 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) throw makeAbortError();

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (isAbortError(error) || options.signal?.aborted) {
        throw error instanceof Error ? error : makeAbortError();
      }

      // 529 连发追踪 → fallback。
      if (is529Error(error)) {
        consecutive529++;
        if (consecutive529 >= MAX_529_RETRIES && options.fallbackModel) {
          throw new FallbackTriggeredError(options.model, options.fallbackModel);
        }
      } else {
        consecutive529 = 0;
      }

      // 不可重试 → 立即上抛。
      if (!shouldRetry(error)) {
        throw new CannotRetryError(error, getMessage(error));
      }

      // 重试耗尽 → 上抛。
      if (attempt > maxRetries) {
        throw new CannotRetryError(error, getMessage(error));
      }

      const delayMs = getRetryDelay(attempt, getRetryAfterHeader(error));
      await sleep(delayMs, options.signal);
    }
  }

  throw new CannotRetryError(lastError, getMessage(lastError));
}
