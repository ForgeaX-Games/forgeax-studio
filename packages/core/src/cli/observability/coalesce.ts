/**
 * forgeax-core — observability HOST 攒批 + 限流(S2 · 线缆保护).
 *
 * 高频 log / 频繁 span onStart/onEnd 若一条一 RPC,会打爆 WS / sidecar 通道。Coalescer 在
 * 50–100ms 窗口内攒批,一次性 `flush` 调下游 `send`(rpc/ws/file…)。
 *
 * 另带一个极简 per-level **限流闸**:同一 level 在窗口内超过阈值就丢弃(只对 log;span 不限流,
 * 因为 span 量天然受 turn 结构约束)。两者都纯本地、无副作用外溢,可独立单测(H5)。
 */
import type { TelemetryRecord } from '@forgeax/types';

export interface CoalescerOptions {
  /** 攒批窗口(ms),默认 80(落在 50–100 区间)。 */
  windowMs?: number;
  /** 攒够这么多条立即 flush(防窗口内堆太多)。默认 256。 */
  maxBatch?: number;
  /** 下游出口。 */
  send: (records: TelemetryRecord[]) => void;
  /** setTimeout 注入(测试可换 fake timer);默认全局 setTimeout。 */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * 攒批器:`push` 累积,到窗口/批量上限触发一次 `send`。`flush` 立即排空,`stop` 清定时器并排空。
 * send 抛错被吞(可观测性绝不拖垮被观察者,§9 Graceful Degradation)。
 */
export class Coalescer {
  private buf: TelemetryRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private readonly maxBatch: number;
  private readonly send: (records: TelemetryRecord[]) => void;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;

  constructor(opts: CoalescerOptions) {
    this.windowMs = opts.windowMs ?? 80;
    this.maxBatch = opts.maxBatch ?? 256;
    this.send = opts.send;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  }

  push(record: TelemetryRecord): void {
    this.buf.push(record);
    if (this.buf.length >= this.maxBatch) {
      this.flush();
      return;
    }
    if (this.timer == null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
    }
  }

  /** 立即排空缓冲并 send(空则 no-op)。 */
  flush(): void {
    if (this.timer != null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    try {
      this.send(batch);
    } catch {
      // 出口故障绝不影响被观察者:吞掉。
    }
  }

  /** 关停:排空 + 清定时器(供 shutdown 走)。 */
  stop(): void {
    this.flush();
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RateLimitOptions {
  /** 每个滑窗每 level 允许的最大条数,默认 200。 */
  perWindow?: number;
  /** 滑窗长度(ms),默认 1000。 */
  windowMs?: number;
  /** 时钟注入(测试可换);默认 Date.now。 */
  now?: () => number;
}

/**
 * 极简 per-level 限流闸:`allow(level)` 在滑窗内超阈返 false(调用方丢弃该条 log)。
 * 默认开,可通过 `enabled=false` 整体关闭(span 不经此闸)。
 */
export class LogRateLimiter {
  private readonly perWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly state: Record<LogLevel, { windowStart: number; count: number }> = {
    debug: { windowStart: 0, count: 0 },
    info: { windowStart: 0, count: 0 },
    warn: { windowStart: 0, count: 0 },
    error: { windowStart: 0, count: 0 },
  };
  enabled: boolean;

  constructor(opts: RateLimitOptions & { enabled?: boolean } = {}) {
    this.perWindow = opts.perWindow ?? 200;
    this.windowMs = opts.windowMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.enabled = opts.enabled ?? true;
  }

  /** true=放行,false=本窗口该 level 已超额,调用方应丢弃。 */
  allow(level: LogLevel): boolean {
    if (!this.enabled) return true;
    const s = this.state[level];
    const t = this.now();
    if (t - s.windowStart >= this.windowMs) {
      s.windowStart = t;
      s.count = 0;
    }
    s.count += 1;
    return s.count <= this.perWindow;
  }
}
