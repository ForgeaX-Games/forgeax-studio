/**
 * RPC core — used identically by host and plugin sides.
 *
 * Responsibilities:
 *   - Generate envelope ids (UUID-ish, no external deps).
 *   - Validate every inbound envelope through HostSdkEnvelopeSchema before
 *     dispatching. Drops malformed traffic on the floor (do NOT crash).
 *   - Correlate request / reply via `replyTo`. request() returns a Promise
 *     that settles when the matching reply lands or rejects on timeout.
 *   - Route inbound envelopes to handler maps by `kind`.
 *
 * Doc anchor: 07-INTERFACE-EXPOSURE §统一调用入口；A2 验收：mock postMessage
 * 单测覆盖 handshake/tool/timeout 三类。
 */
import {
  HostSdkEnvelopeSchema,
  type HostSdkEnvelope,
} from '@forgeax/types';
import type { Transport } from './transport';

export type EnvelopeKind = HostSdkEnvelope['kind'];

/** Distributive Omit: applies Omit to each member of a union, so that
 *  `EnvelopePartial<HostSdkEnvelope>` produces a union of partials per kind
 *  instead of an Omit over the union (which loses kind-specific fields). */
type EnvelopePartial<T, K extends keyof HostSdkEnvelope> = T extends unknown
  ? Omit<T, K>
  : never;
type EnvelopeInit = EnvelopePartial<HostSdkEnvelope, 'v' | 'id' | 'from' | 'ts'>;
type EnvelopeReplyInit = EnvelopePartial<HostSdkEnvelope, 'v' | 'id' | 'from' | 'ts' | 'replyTo'>;

/** Identifies who we are on this end of the channel. Goes into envelope.from. */
export type SelfIdentity =
  | { kind: 'host' }
  | { kind: 'plugin'; pluginId: string };

export interface RpcChannelOptions {
  transport: Transport;
  self: SelfIdentity;
  /** Default timeout for request(); per-call override available. */
  defaultTimeoutMs?: number;
  /** Optional invalid-envelope hook for diagnostics (e.g. log to ledger). */
  onInvalid?: (raw: unknown, reason: string) => void;
}

interface PendingRequest {
  resolve: (env: HostSdkEnvelope) => void;
  reject: (e: Error) => void;
  expectedKind: EnvelopeKind;
  timer: ReturnType<typeof setTimeout>;
}

let _idCounter = 0;
function genId(prefix: string): string {
  _idCounter += 1;
  // Date.now() + counter + random — collision-resistant enough for one session.
  return `${prefix}-${Date.now().toString(36)}-${_idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RpcChannel {
  private readonly transport: Transport;
  private readonly self: SelfIdentity;
  private readonly defaultTimeoutMs: number;
  private readonly onInvalid: (raw: unknown, reason: string) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Map<EnvelopeKind, Set<(env: HostSdkEnvelope) => void>>();
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(opts: RpcChannelOptions) {
    this.transport = opts.transport;
    this.self = opts.self;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
    this.onInvalid = opts.onInvalid ?? (() => { /* swallow */ });
    this.unsubscribe = this.transport.onMessage((env) => this._dispatch(env));
  }

  /** Send an envelope without waiting for a reply. Returns the assigned id. */
  send(partial: EnvelopeInit): string {
    const id = genId('e');
    const env = {
      v: 1 as const,
      id,
      from: this.self,
      ts: new Date().toISOString(),
      ...partial,
    } as HostSdkEnvelope;
    this.transport.post(env);
    return id;
  }

  /** Send + await a reply with a specific kind. Rejects on timeout. */
  request<R extends HostSdkEnvelope>(
    partial: EnvelopeInit,
    expectedReplyKind: R['kind'],
    timeoutMs?: number,
  ): Promise<R> {
    const id = genId('e');
    const env = {
      v: 1 as const,
      id,
      from: this.self,
      ts: new Date().toISOString(),
      ...partial,
    } as HostSdkEnvelope;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${partial.kind} expecting ${expectedReplyKind}`));
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, {
        resolve: (e) => resolve(e as R),
        reject,
        expectedKind: expectedReplyKind,
        timer,
      });
      this.transport.post(env);
    });
  }

  /** Reply to an inbound envelope. Sets replyTo automatically. */
  reply(inReplyTo: HostSdkEnvelope, partial: EnvelopeReplyInit): string {
    const id = genId('e');
    const env = {
      v: 1 as const,
      id,
      replyTo: inReplyTo.id,
      from: this.self,
      ts: new Date().toISOString(),
      ...partial,
    } as HostSdkEnvelope;
    this.transport.post(env);
    return id;
  }

  /** Register a handler for inbound envelopes of `kind`. Returns unsub. */
  on<K extends EnvelopeKind>(
    kind: K,
    handler: (env: Extract<HostSdkEnvelope, { kind: K }>) => void,
  ): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    set.add(handler as (env: HostSdkEnvelope) => void);
    return () => set!.delete(handler as (env: HostSdkEnvelope) => void);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('channel closed'));
    }
    this.pending.clear();
    this.handlers.clear();
    this.transport.close();
  }

  private _dispatch(raw: unknown): void {
    if (this.closed) return;
    const r = HostSdkEnvelopeSchema.safeParse(raw);
    if (!r.success) {
      this.onInvalid(raw, r.error.issues[0]?.message ?? 'invalid envelope');
      return;
    }
    const env = r.data;

    // Reply path first: replyTo matches a pending request.
    if (env.replyTo) {
      const pend = this.pending.get(env.replyTo);
      if (pend) {
        if (env.kind === pend.expectedKind) {
          clearTimeout(pend.timer);
          this.pending.delete(env.replyTo);
          pend.resolve(env);
          return;
        }
        // Wrong reply kind — reject pending, but also fall through to handlers
        // so the envelope isn't silently dropped.
        clearTimeout(pend.timer);
        this.pending.delete(env.replyTo);
        pend.reject(new Error(`unexpected reply kind: got ${env.kind}, want ${pend.expectedKind}`));
      }
    }

    const set = this.handlers.get(env.kind);
    if (!set) return;
    for (const h of [...set]) {
      try { h(env); } catch { /* handler errors must not kill the channel */ }
    }
  }
}
