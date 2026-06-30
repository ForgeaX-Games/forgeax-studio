/**
 * forgeax-core — observability HOST 的 CoreLogger 适配(H4 · consola adapter).
 *
 * `CoreLogger`(契约 SSOT)要求 `child(bindings)` 把 bindings 并进每条 record 的关联字段。
 * **consola 没有原生 `.child({fields})`**(只有 `withTag(string)`),所以 bindings 合并在本适配里自建:
 * child(bindings) 返回一个新 logger,持有「累积 bindings」,每条 debug/info/warn/error 都把
 * traceId/spanId/sid/agentId 从累积 bindings 取出 → 产 `LogRecord` → 经注入的 `emitLog` 出墙
 * (下游 redactor→coalesce→send)。traceId/spanId 走 child bindings(W1:不靠 getActiveSpan)。
 *
 * 可选地再把同一条 mirror 到 consola 实例(dev console 人类可读);production/测试可关。
 */
import { createConsola, type ConsolaInstance } from 'consola';
import type { CoreLogger } from '../../observability/contract';
import type { LogRecord } from '@forgeax/types';

type Level = LogRecord['level'];

/** 从累积 bindings 里抽出 4 个关联维度(其余进 fields)。 */
interface Bindings {
  traceId?: string;
  spanId?: string;
  sid?: string;
  agentId?: string;
  /** 非关联维度的 binding 也一并并进每条 record 的 fields(便于打 tag)。 */
  extra: Record<string, unknown>;
}

function mergeBindings(base: Bindings, add: Record<string, unknown>): Bindings {
  const next: Bindings = {
    traceId: base.traceId,
    spanId: base.spanId,
    sid: base.sid,
    agentId: base.agentId,
    extra: { ...base.extra },
  };
  for (const [k, v] of Object.entries(add)) {
    if (k === 'traceId') next.traceId = v == null ? next.traceId : String(v);
    else if (k === 'spanId') next.spanId = v == null ? next.spanId : String(v);
    else if (k === 'sid') next.sid = v == null ? next.sid : String(v);
    else if (k === 'agentId') next.agentId = v == null ? next.agentId : String(v);
    else next.extra[k] = v;
  }
  return next;
}

export interface ConsolaLoggerOptions {
  /** 产好的 LogRecord 出口(组装层接到 redactor→coalesce→send)。 */
  emitLog: (rec: LogRecord) => void;
  /** dev console 人类可读镜像(默认开;测试/纯线缆场景可关)。 */
  mirrorConsole?: boolean;
  /** 注入 consola 实例(测试可注 stub);默认 createConsola()。 */
  consola?: ConsolaInstance;
  /** 时钟注入;默认 Date.now。 */
  now?: () => number;
}

/**
 * consola 适配的 CoreLogger root。`child(bindings)` 返回携带累积 bindings 的同族 logger。
 * root 自身 bindings 为空 —— record 的关联字段全靠 producer `.child({traceId,spanId,sid,agentId})` 注入。
 */
export class ConsolaCoreLogger implements CoreLogger {
  private readonly emitLog: (rec: LogRecord) => void;
  private readonly mirror: boolean;
  private readonly consola: ConsolaInstance;
  private readonly now: () => number;
  private readonly bindings: Bindings;

  constructor(opts: ConsolaLoggerOptions, bindings?: Bindings) {
    this.emitLog = opts.emitLog;
    this.mirror = opts.mirrorConsole ?? true;
    this.consola = opts.consola ?? createConsola();
    this.now = opts.now ?? (() => Date.now());
    this.bindings = bindings ?? { extra: {} };
  }

  private emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
    const b = this.bindings;
    const mergedFields: Record<string, unknown> = { ...b.extra, ...(fields ?? {}) };
    const rec: LogRecord = {
      kind: 'log',
      ts: this.now(),
      level,
      msg,
      fields: Object.keys(mergedFields).length > 0 ? mergedFields : undefined,
      traceId: b.traceId,
      spanId: b.spanId,
      sid: b.sid,
      agentId: b.agentId,
    };
    this.emitLog(rec);
    if (this.mirror) {
      // 人类可读镜像;consola 的 level 名与我们一致(debug/info/warn/error)。
      this.consola[level](msg, mergedFields);
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit('error', msg, fields);
  }

  child(bindings: Record<string, unknown>): CoreLogger {
    const next = mergeBindings(this.bindings, bindings);
    return new ConsolaCoreLogger(
      {
        emitLog: this.emitLog,
        mirrorConsole: this.mirror,
        consola: this.consola,
        now: this.now,
      },
      next,
    );
  }
}
