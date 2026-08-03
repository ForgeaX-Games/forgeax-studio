import {
  NPC_DECISION_DEADLINE_PRESETS_MS,
  resolveNpcDecisionDeadlineMs,
  type AffordanceParam,
  type NpcBudgetState,
  type NpcDecisionDeadline,
  type NpcLoadedSoulBinding,
  type NpcSoulBinding,
} from '@forgeax/types/npc-protocol';
import {
  npcProtocol,
  snapshotDedupeKey,
  withDecisionFeedback,
  type Affordance,
  type NpcDecisionWire,
  type NpcWireEnvelope,
  type PerceptionSnapshot,
} from './protocol-adapter';

export { npcProtocol } from './protocol-adapter';
export const NPC_PROTOCOL_VERSION = npcProtocol.version;
export type {
  Affordance,
  AffordanceParam,
  NpcDecisionDeadline,
  NpcSoulBinding,
  PerceptionSnapshot,
};
export type NpcDecision = NpcDecisionWire;

export interface NpcClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export interface NpcBudget {
  maxDecisions?: number;
  maxConcurrent?: number;
}

export interface SpotlightHooks {
  onPromote?: (npcId: string) => void;
  onDemote?: (npcId: string) => void;
  onAttach?: (npcId: string) => void;
  onDetach?: (npcId: string) => void;
}

export type NpcCognitiveLod = 'spotlight' | 'ambient' | 'offstage';

export interface NpcClientOptions {
  game: string;
  npcIds: string[];
  /** Explicit NPC-to-Soul bindings. Supplying these makes missing declared packs a server error. */
  npcs?: NpcSoulBinding[];
  playerId?: string;
  endpoint?: string;
  /** Deployment-C service credential used only to mint the short-lived session capability. */
  authToken?: string;
  fetcher?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  now?: () => number;
  clock?: NpcClock;
  reconnect?: ReconnectOptions;
  heartbeatMs?: number;
  /** Low-frequency world sampling cadence used by tick(); defaults to 30s. */
  samplingIntervalMs?: number;
  livenessTimeoutMs?: number;
  utterancePaceMs?: number;
  budget?: NpcBudget;
  onDecision?: (decision: NpcDecisionWire) => void;
  onBudget?: (budget: NpcBudgetState) => void;
  onIntentExpired?: (npcId: string, intent: NonNullable<NpcDecisionWire['intent']>) => void;
  onFallback?: (snapshot: PerceptionSnapshot, reason: Error) => void;
  onUtteranceLine?: (npcId: string, line: string, lineIndex: number) => void;
  spotlight?: SpotlightHooks;
}

interface SessionGrant {
  sessionId: string;
  token: string;
  epoch: number;
  expiresAt: number;
  loaded: NpcLoadedSoulBinding[];
}

interface ActiveIntent {
  decision: NpcDecisionWire;
  receivedAt: number;
  timer: unknown;
}

interface QueuedUtterance {
  npcId: string;
  lines: string[];
  index: number;
}

const defaultClock: NpcClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const DECISION_RESPONSE_GRACE_MS = 1_000;

export class NpcClient {
  readonly #options: NpcClientOptions;
  readonly #clock: NpcClock;
  readonly #affordances = new Map<string, Affordance[]>();
  readonly #lastSeq = new Map<string, number>();
  readonly #lastInboundWireSeq = new Map<number, number>();
  readonly #inFlight = new Map<string, Promise<NpcDecisionWire | undefined>>();
  readonly #seenEvents = new Set<string>();
  readonly #controllers = new Set<AbortController>();
  readonly #activeIntents = new Map<string, ActiveIntent>();
  readonly #lastDecisions = new Map<string, NpcDecisionWire>();
  readonly #lastSnapshots = new Map<string, PerceptionSnapshot>();
  readonly #decisionTimeoutMs = new Map<string, number>();
  readonly #decisionHandlers = new Map<string, Set<(decision: NpcDecisionWire) => void>>();
  readonly #fallbackHandlers = new Map<string, Set<(error: Error) => void>>();
  readonly #spotlight = new Set<string>();
  readonly #lod = new Map<string, NpcCognitiveLod>();
  readonly #attachedNpcIds: Set<string>;
  readonly #utterances: QueuedUtterance[] = [];
  #session?: SessionGrant;
  #socket?: WebSocket;
  #socketReady?: Promise<void>;
  #openedSocketOnce = false;
  #outboundEpoch = 0;
  #outboundSeq = 0;
  #resumeToken?: string;
  #permanentFallback?: Error;
  #stopped = false;
  #reconnectAttempt = 0;
  #reconnectTimer?: unknown;
  #heartbeatTimer?: unknown;
  #livenessTimer?: unknown;
  #utteranceTimer?: unknown;
  #lastActivityAt = 0;
  #samplingElapsedMs = 0;
  #sampling = false;

  static async connect(options: NpcClientOptions): Promise<NpcClient> {
    const client = new NpcClient(options);
    try {
      await client.#ensureSession();
      await client.connectWebSocket();
    } catch {
      // The instance remains usable in permanent local-fallback mode.
    }
    return client;
  }

  constructor(options: NpcClientOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (options.now ? { ...defaultClock, now: options.now } : defaultClock);
    this.#attachedNpcIds = new Set(options.npcIds);
    const requestedBindings = new Map(options.npcs?.map((binding) => [binding.npcId, binding]));
    for (const npcId of options.npcIds) {
      this.#lod.set(npcId, 'spotlight');
      this.#decisionTimeoutMs.set(
        npcId,
        resolveNpcDecisionDeadlineMs(requestedBindings.get(npcId)?.decisionDeadline),
      );
    }
  }

  declareAffordances(npcId: string, affordances: Affordance[]): void {
    if (!this.#attachedNpcIds.has(npcId)) throw new Error(`Unknown NPC: ${npcId}`);
    this.#affordances.set(npcId, affordances.map((item) => ({ ...item })));
  }

  affordancesFor(npcId: string): readonly Affordance[] {
    return this.#affordances.get(npcId) ?? [];
  }

  onDecision(npcId: string, handler: (decision: NpcDecisionWire) => void): () => void {
    return this.#addHandler(this.#decisionHandlers, npcId, handler);
  }

  onFallback(npcId: string, handler: (error: Error) => void): () => void {
    return this.#addHandler(this.#fallbackHandlers, npcId, handler);
  }

  async connect(): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#options.authToken) headers.authorization = `Bearer ${this.#options.authToken}`;
    const response = await this.#fetch('/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        game: this.#options.game,
        playerId: this.#options.playerId,
        npcIds: this.#options.npcIds,
        ...(this.#options.npcs ? { npcs: this.#options.npcs } : {}),
      }),
    });
    const raw = await response.json();
    if (!response.ok) {
      throw new Error(
        typeof raw === 'object' && raw && 'error' in raw ? String(raw.error) : `NPC session failed (${response.status})`,
      );
    }
    const body = npcProtocol.sessionResponse(raw);
    if (!body.ok) throw new Error(body.error);
    this.#session = body;
    for (const binding of body.loaded) {
      this.#decisionTimeoutMs.set(binding.npcId, binding.decisionTimeoutMs);
    }
    this.#permanentFallback = undefined;
    this.#stopped = false;
    this.#resetWireCountersForEpoch(this.#session.epoch);
  }

  async decide(snapshot: PerceptionSnapshot, timeoutMs?: number): Promise<NpcDecisionWire | undefined> {
    const prepared = this.#prepareSnapshot(snapshot);
    const key = snapshotDedupeKey(prepared);
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    if (this.#seenEvents.has(key)) return undefined;
    this.#seenEvents.add(key);
    const effectiveTimeoutMs = timeoutMs ?? (
      this.decisionTimeoutMs(prepared.npcId) + DECISION_RESPONSE_GRACE_MS
    );
    const operation = this.#decideHttp(prepared, effectiveTimeoutMs).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, operation);
    return operation;
  }

  async decideBatch(
    snapshots: PerceptionSnapshot[],
    budget: NpcBudget = this.#options.budget ?? {},
  ): Promise<Array<NpcDecisionWire | undefined>> {
    const maxDecisions = Math.max(0, budget.maxDecisions ?? snapshots.length);
    const maxConcurrent = Math.max(1, budget.maxConcurrent ?? 2);
    const selected = [...snapshots]
      .sort((left, right) => Number(this.#spotlight.has(right.npcId)) - Number(this.#spotlight.has(left.npcId)))
      .slice(0, maxDecisions);
    const results: Array<NpcDecisionWire | undefined> = new Array(selected.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < selected.length) {
        const index = cursor++;
        results[index] = await this.decide(selected[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, selected.length) }, worker));
    return results;
  }

  /** Event-driven entry point. Uses WS when live and HTTP otherwise. */
  async emit(snapshot: PerceptionSnapshot): Promise<NpcDecisionWire | undefined> {
    const prepared = this.#prepareSnapshot(snapshot);
    if (await this.#trySendSnapshot(prepared)) return undefined;
    return this.decide(snapshot);
  }

  /** Low-frequency sampling entry point; the host controls cadence and world projection. */
  async sampleWorld(sampler: (npcId: string) => PerceptionSnapshot | undefined): Promise<void> {
    const snapshots = [...this.#attachedNpcIds].flatMap((npcId) => {
      if (this.lod(npcId) !== 'spotlight') return [];
      const value = sampler(npcId);
      return value ? [value] : [];
    });
    await this.sendSnapshots(snapshots);
  }

  tick(dt: number, sampler: (npcId: string) => PerceptionSnapshot | undefined): void;
  tick(sampler: (npcId: string) => PerceptionSnapshot | undefined): void;
  tick(
    dtOrSampler: number | ((npcId: string) => PerceptionSnapshot | undefined),
    maybeSampler?: (npcId: string) => PerceptionSnapshot | undefined,
  ): void {
    const sampler = typeof dtOrSampler === 'function' ? dtOrSampler : maybeSampler;
    if (!sampler || this.#sampling) return;
    const interval = this.#options.samplingIntervalMs ?? 30_000;
    this.#samplingElapsedMs += typeof dtOrSampler === 'number' ? Math.max(0, dtOrSampler * 1_000) : interval;
    if (this.#samplingElapsedMs < interval) return;
    this.#samplingElapsedMs %= interval;
    this.#sampling = true;
    void this.sampleWorld(sampler).finally(() => { this.#sampling = false; });
  }

  isThinking(eventId?: string): boolean {
    if (!eventId) return this.#inFlight.size > 0;
    for (const key of this.#inFlight.keys()) if (key.endsWith(`${eventId}`)) return true;
    return false;
  }

  currentIntent(npcOrDecision: string | NpcDecisionWire | undefined): NpcDecisionWire['intent'] | undefined {
    if (typeof npcOrDecision !== 'string') return npcOrDecision?.intent;
    return this.#activeIntents.get(npcOrDecision)?.decision.intent;
  }

  intentExpired(receivedAt: number, decision: NpcDecisionWire): boolean {
    return !decision.intent || receivedAt + decision.intent.ttlSec * 1_000 <= this.#now();
  }

  promote(npcId: string, snapshot?: PerceptionSnapshot): void {
    if (this.#spotlight.has(npcId)) return;
    this.#spotlight.add(npcId);
    this.#lod.set(npcId, 'spotlight');
    this.#options.spotlight?.onPromote?.(npcId);
    if (snapshot) void this.emit({ ...snapshot, trigger: 'spotlight' });
  }

  demote(npcId: string): void {
    this.#spotlight.delete(npcId);
    this.#lod.set(npcId, 'ambient');
    this.#options.spotlight?.onDemote?.(npcId);
  }

  setLod(npcId: string, level: NpcCognitiveLod, snapshot?: PerceptionSnapshot): void {
    if (!this.#attachedNpcIds.has(npcId)) throw new Error(`Unknown NPC: ${npcId}`);
    if (level === 'spotlight') this.promote(npcId, snapshot);
    else if (level === 'ambient') this.demote(npcId);
    else {
      this.#spotlight.delete(npcId);
      this.#lod.set(npcId, 'offstage');
      this.#options.spotlight?.onDemote?.(npcId);
    }
  }

  lod(npcId: string): NpcCognitiveLod {
    return this.#lod.get(npcId) ?? 'offstage';
  }

  /** Server-confirmed Brain decision deadline, excluding transport response grace. */
  decisionTimeoutMs(npcId: string): number {
    return this.#decisionTimeoutMs.get(npcId) ?? NPC_DECISION_DEADLINE_PRESETS_MS.balanced;
  }

  async attach(
    npcId: string,
    snapshot?: PerceptionSnapshot,
    binding: Omit<NpcSoulBinding, 'npcId'> = {},
  ): Promise<void> {
    await this.connectWebSocket();
    this.#sendFrame({
      type: 'attach',
      ...this.#frameHeader(`attach-${npcId}-${this.#outboundSeq + 1}`),
      sessionId: this.#session!.sessionId,
      binding: { npcId, ...binding },
    });
    this.#attachedNpcIds.add(npcId);
    this.#decisionTimeoutMs.set(npcId, resolveNpcDecisionDeadlineMs(binding.decisionDeadline));
    this.#lod.set(npcId, 'spotlight');
    this.#options.spotlight?.onAttach?.(npcId);
    if (snapshot) await this.emit({ ...snapshot, trigger: 'attach' });
  }

  async detach(npcId: string): Promise<void> {
    await this.connectWebSocket();
    this.#sendFrame({
      type: 'detach',
      ...this.#frameHeader(`detach-${npcId}-${this.#outboundSeq + 1}`),
      sessionId: this.#session!.sessionId,
      npcId,
    });
    this.#attachedNpcIds.delete(npcId);
    this.#decisionTimeoutMs.delete(npcId);
    this.#lod.set(npcId, 'offstage');
    this.#options.spotlight?.onDetach?.(npcId);
    this.#expireIntent(npcId);
  }

  async connectWebSocket(): Promise<void> {
    await this.#ensureSession();
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#socketReady) return this.#socketReady;
    const session = this.#session!;
    const socket = (this.#options.webSocketFactory ?? ((url) => new WebSocket(url)))(this.#webSocketUrl(session));
    this.#socket = socket;
    this.#socketReady = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        this.#reconnectAttempt = 0;
        this.#lastActivityAt = this.#now();
        const shouldResume = this.#openedSocketOnce;
        this.#openedSocketOnce = true;
        if (shouldResume) this.#sendResumeFrame();
        this.#scheduleHeartbeat();
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => reject(new Error('NPC WebSocket failed')), { once: true });
      socket.addEventListener('message', (event) => this.#handleSocketMessage(event.data));
      socket.addEventListener('close', () => this.#handleSocketClose(socket));
    }).finally(() => { this.#socketReady = undefined; });
    return this.#socketReady;
  }

  async sendSnapshot(snapshot: PerceptionSnapshot): Promise<void> {
    const prepared = this.#prepareSnapshot(snapshot);
    if (await this.#trySendSnapshot(prepared)) return;
    await this.decide(prepared);
  }

  async sendSnapshots(snapshots: PerceptionSnapshot[]): Promise<void> {
    const prepared = snapshots.map((snapshot) => this.#prepareSnapshot(snapshot));
    if (prepared.length === 0) return;
    try {
      await this.connectWebSocket();
      this.#sendFrame({
        type: 'snapshots',
        ...this.#frameHeader(`snapshots-${this.#outboundSeq + 1}`),
        snapshots: prepared,
      });
    } catch {
      await this.decideBatch(prepared);
    }
  }

  async resume(): Promise<{ reset: boolean }> {
    await this.#ensureSession();
    const resume = this.#resumeRequest();
    const response = await this.#fetch('/resume', {
      method: 'POST', headers: this.#headers(),
      body: JSON.stringify({ epoch: this.#session?.epoch, resume }),
    });
    const body = await response.json() as { ok?: boolean; epoch?: number; reset?: boolean; error?: string };
    if (!response.ok || !body.ok || body.epoch === undefined) throw new Error(body.error ?? 'NPC resume failed');
    if (body.reset) this.#lastSeq.clear();
    if (this.#session) {
      this.#session.epoch = body.epoch;
      this.#resetWireCountersForEpoch(body.epoch);
    }
    return { reset: body.reset === true };
  }

  async endEpisode(): Promise<void> {
    if (!this.#session) return;
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#sendFrame({
        type: 'episode_end',
        ...this.#frameHeader(`episode-end-${this.#session.epoch}-${this.#outboundSeq + 1}`),
        sessionId: this.#session.sessionId,
      });
    } else {
      await this.#fetch('/episode-end', { method: 'POST', headers: this.#headers() });
    }
    this.#clearSessionState();
  }

  disconnect(): void {
    this.#stopped = true;
    for (const controller of this.#controllers) controller.abort(new Error('NPC client disconnected'));
    this.#controllers.clear();
    this.#clearTimer('reconnect');
    this.#clearTimer('heartbeat');
    this.#clearTimer('liveness');
    this.#clearTimer('utterance');
    for (const intent of this.#activeIntents.values()) this.#clock.clearTimeout(intent.timer);
    this.#activeIntents.clear();
    this.#socket?.close(1000, 'NPC client disconnected');
    this.#socket = undefined;
    this.#socketReady = undefined;
  }

  async #decideHttp(snapshot: PerceptionSnapshot, timeoutMs: number): Promise<NpcDecisionWire | undefined> {
    try {
      await this.#ensureSession();
      const ctrl = new AbortController();
      this.#controllers.add(ctrl);
      const timer = this.#clock.setTimeout(() => ctrl.abort(new Error('NPC decision timeout')), timeoutMs);
      try {
        const response = await this.#fetch('/chat', {
          method: 'POST', headers: this.#headers(), body: JSON.stringify(snapshot), signal: ctrl.signal,
        });
        const body = await response.json() as {
          ok?: boolean;
          decision?: unknown;
          fallback?: boolean;
          reason?: string;
          epoch?: number;
          error?: string;
        };
        if (!response.ok || !body.ok) throw new Error(body.error ?? `NPC decision failed (${response.status})`);
        this.#adoptEpoch(body.epoch);
        if (body.fallback) throw new Error(body.reason ?? 'NPC Brain fallback');
        return this.#acceptDecision(npcProtocol.decision(body.decision));
      } finally {
        this.#clock.clearTimeout(timer);
        this.#controllers.delete(ctrl);
      }
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.#notifyFallback(snapshot, error);
      return undefined;
    }
  }

  async #trySendSnapshot(snapshot: PerceptionSnapshot): Promise<boolean> {
    try {
      await this.connectWebSocket();
      this.#sendFrame({ type: 'snapshot', ...this.#frameHeader(snapshot.eventId), snapshot });
      return true;
    } catch {
      return false;
    }
  }

  #prepareSnapshot(snapshot: PerceptionSnapshot): PerceptionSnapshot {
    const declared = this.#affordances.get(snapshot.npcId);
    const withAffordances = declared ? { ...snapshot, affordances: declared } : snapshot;
    const prepared = withDecisionFeedback(npcProtocol.snapshot(withAffordances), this.#lastDecisions.get(snapshot.npcId));
    this.#lastSnapshots.set(snapshot.npcId, prepared);
    return prepared;
  }

  async #ensureSession(): Promise<void> {
    if (this.#permanentFallback) throw this.#permanentFallback;
    if (this.#session && this.#session.expiresAt > this.#now()) return;
    try {
      await this.connect();
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.#permanentFallback = error;
      throw error;
    }
  }

  #webSocketUrl(session: SessionGrant): string {
    const base = this.#options.endpoint ?? '/api/npc';
    const pageHref = typeof location === 'undefined' ? 'http://localhost' : location.href;
    const absolute = new URL(`${base}/ws`, pageHref);
    absolute.protocol = absolute.protocol === 'https:' ? 'wss:' : 'ws:';
    absolute.searchParams.set('sessionId', session.sessionId);
    absolute.searchParams.set('token', session.token);
    return absolute.toString();
  }

  #handleSocketClose(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#socketReady = undefined;
    this.#clearTimer('heartbeat');
    this.#clearTimer('liveness');
    if (!this.#stopped) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const config = this.#options.reconnect ?? {};
    const maxAttempts = config.maxAttempts ?? 6;
    if (this.#reconnectAttempt >= maxAttempts || this.#reconnectTimer !== undefined) return;
    const delay = Math.min(
      config.maxDelayMs ?? 10_000,
      (config.initialDelayMs ?? 250) * 2 ** this.#reconnectAttempt,
    );
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#clock.setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connectWebSocket().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #scheduleHeartbeat(): void {
    this.#clearTimer('heartbeat');
    const interval = this.#options.heartbeatMs ?? 15_000;
    if (interval <= 0) return;
    this.#heartbeatTimer = this.#clock.setTimeout(() => {
      this.#heartbeatTimer = undefined;
      if (this.#socket?.readyState === WebSocket.OPEN) {
        this.#sendFrame({ type: 'heartbeat', ...this.#frameHeader(`heartbeat-${this.#outboundSeq + 1}`) });
        this.#armLivenessTimer();
        this.#scheduleHeartbeat();
      }
    }, interval);
  }

  #armLivenessTimer(): void {
    this.#clearTimer('liveness');
    const timeout = this.#options.livenessTimeoutMs ?? 45_000;
    if (timeout <= 0) return;
    const expectedActivity = this.#lastActivityAt;
    this.#livenessTimer = this.#clock.setTimeout(() => {
      this.#livenessTimer = undefined;
      if (this.#lastActivityAt <= expectedActivity) this.#socket?.close(4000, 'NPC heartbeat timeout');
    }, timeout);
  }

  #sendResumeFrame(): void {
    if (!this.#session || this.#socket?.readyState !== WebSocket.OPEN) return;
    const epoch = this.#session.epoch;
    this.#sendFrame({
      type: 'resume',
      ...this.#frameHeader(`resume-${epoch}-${this.#outboundSeq + 1}`),
      sessionId: this.#session.sessionId,
      resume: this.#resumeRequest(),
    });
  }

  #resumeRequest() {
    const epoch = this.#session?.epoch ?? 0;
    const ack = this.#lastInboundWireSeq.get(epoch) ?? 0;
    return {
      ack,
      fromSeq: ack + 1,
      lastDecisionSeq: Object.fromEntries(this.#lastSeq),
      ...(this.#resumeToken ? { token: this.#resumeToken } : {}),
    };
  }

  #sendFrame(frame: NpcWireEnvelope): void {
    this.#socket?.send(JSON.stringify(npcProtocol.envelope(frame)));
  }

  #frameHeader(eventId: string) {
    const epoch = this.#session?.epoch ?? 0;
    if (this.#outboundEpoch !== epoch) this.#resetWireCountersForEpoch(epoch);
    this.#outboundSeq += 1;
    const ack = this.#lastInboundWireSeq.get(epoch);
    return { v: NPC_PROTOCOL_VERSION, eventId, epoch, seq: this.#outboundSeq, ...(ack === undefined ? {} : { ack }) } as const;
  }

  #handleSocketMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: NpcWireEnvelope;
    try { message = npcProtocol.envelope(JSON.parse(raw)); } catch { return; }
    if (!this.#acceptWireFrame(message)) return;
    this.#lastActivityAt = this.#now();
    this.#clearTimer('liveness');
    if (message.type === 'session_ready') {
      if (!this.#session || message.sessionId !== this.#session.sessionId) return;
      this.#adoptEpoch(message.epoch);
      this.#resumeToken = message.resumeToken;
    } else if (message.type === 'decision') {
      this.#acceptDecision(message.decision);
    } else if (message.type === 'decisions') {
      for (const decision of message.decisions) this.#acceptDecision(decision);
    } else if (message.type === 'budget') {
      this.#options.onBudget?.(message.budget);
      if (message.budget.remaining === 0) {
        const error = new Error('NPC decision budget exhausted');
        for (const npcId of this.#attachedNpcIds) {
          const snapshot = this.#lastSnapshots.get(npcId);
          if (snapshot) this.#notifyFallback(snapshot, error);
          else for (const handler of this.#fallbackHandlers.get(npcId) ?? []) handler(error);
        }
      }
    } else if (message.type === 'error' && message.code === 'resume_reset') {
      this.#lastSeq.clear();
    }
  }

  #acceptWireFrame(message: NpcWireEnvelope): boolean {
    if (!this.#session) return false;
    if (message.epoch !== this.#session.epoch && message.type !== 'session_ready') return false;
    if (message.type === 'session_ready' && message.epoch < this.#session.epoch) return false;
    const previous = this.#lastInboundWireSeq.get(message.epoch);
    if (previous !== undefined && message.seq <= previous) return false;
    this.#lastInboundWireSeq.set(message.epoch, message.seq);
    return true;
  }

  #acceptDecision(decision: NpcDecisionWire): NpcDecisionWire | undefined {
    const previous = this.#lastSeq.get(decision.npcId) ?? 0;
    if (decision.seq <= previous) return undefined;
    this.#lastSeq.set(decision.npcId, decision.seq);
    this.#lastDecisions.set(decision.npcId, decision);
    this.#setActiveIntent(decision);
    this.#enqueueUtterance(decision);
    this.#options.onDecision?.(decision);
    for (const handler of this.#decisionHandlers.get(decision.npcId) ?? []) handler(decision);
    return decision;
  }

  #setActiveIntent(decision: NpcDecisionWire): void {
    this.#expireIntent(decision.npcId, false);
    if (!decision.intent) return;
    const timer = this.#clock.setTimeout(() => this.#expireIntent(decision.npcId), decision.intent.ttlSec * 1_000);
    this.#activeIntents.set(decision.npcId, { decision, receivedAt: this.#now(), timer });
  }

  #expireIntent(npcId: string, notify = true): void {
    const active = this.#activeIntents.get(npcId);
    if (!active) return;
    this.#clock.clearTimeout(active.timer);
    this.#activeIntents.delete(npcId);
    if (notify && active.decision.intent) this.#options.onIntentExpired?.(npcId, active.decision.intent);
  }

  #enqueueUtterance(decision: NpcDecisionWire): void {
    if (!decision.utterance || !this.#options.onUtteranceLine) return;
    this.#utterances.push({ npcId: decision.npcId, lines: decision.utterance.lines, index: 0 });
    if (this.#utteranceTimer === undefined) this.#drainUtterance();
  }

  #drainUtterance(): void {
    const current = this.#utterances[0];
    if (!current) {
      this.#utteranceTimer = undefined;
      return;
    }
    this.#options.onUtteranceLine?.(current.npcId, current.lines[current.index]!, current.index);
    current.index += 1;
    if (current.index >= current.lines.length) this.#utterances.shift();
    this.#utteranceTimer = this.#clock.setTimeout(() => this.#drainUtterance(), this.#options.utterancePaceMs ?? 1_200);
  }

  #adoptEpoch(epoch: number | undefined): void {
    if (epoch === undefined || !this.#session || epoch === this.#session.epoch) return;
    this.#session.epoch = epoch;
    this.#lastSeq.clear();
    this.#resetWireCountersForEpoch(epoch);
  }

  #clearSessionState(): void {
    this.#session = undefined;
    this.#lastSeq.clear();
    this.#lastInboundWireSeq.clear();
    this.#openedSocketOnce = false;
    this.#resumeToken = undefined;
    this.#resetWireCountersForEpoch(0);
  }

  #resetWireCountersForEpoch(epoch: number): void {
    this.#outboundEpoch = epoch;
    this.#outboundSeq = 0;
  }

  #clearTimer(kind: 'reconnect' | 'heartbeat' | 'liveness' | 'utterance'): void {
    if (kind === 'reconnect' && this.#reconnectTimer !== undefined) {
      this.#clock.clearTimeout(this.#reconnectTimer); this.#reconnectTimer = undefined;
    } else if (kind === 'heartbeat' && this.#heartbeatTimer !== undefined) {
      this.#clock.clearTimeout(this.#heartbeatTimer); this.#heartbeatTimer = undefined;
    } else if (kind === 'liveness' && this.#livenessTimer !== undefined) {
      this.#clock.clearTimeout(this.#livenessTimer); this.#livenessTimer = undefined;
    } else if (kind === 'utterance' && this.#utteranceTimer !== undefined) {
      this.#clock.clearTimeout(this.#utteranceTimer); this.#utteranceTimer = undefined;
    }
  }

  #headers(): Record<string, string> {
    if (!this.#session) throw new Error('NPC client is not connected');
    return {
      authorization: `Bearer ${this.#session.token}`,
      'x-npc-session': this.#session.sessionId,
      'content-type': 'application/json',
    };
  }

  #fetch(path: string, init: RequestInit) {
    return (this.#options.fetcher ?? fetch)(`${this.#options.endpoint ?? '/api/npc'}${path}`, init);
  }

  #notifyFallback(snapshot: PerceptionSnapshot, error: Error): void {
    this.#options.onFallback?.(snapshot, error);
    for (const handler of this.#fallbackHandlers.get(snapshot.npcId) ?? []) handler(error);
  }

  #addHandler<T>(registry: Map<string, Set<T>>, npcId: string, handler: T): () => void {
    if (!this.#attachedNpcIds.has(npcId)) throw new Error(`Unknown NPC: ${npcId}`);
    const handlers = registry.get(npcId) ?? new Set<T>();
    handlers.add(handler);
    registry.set(npcId, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) registry.delete(npcId);
    };
  }

  #now(): number { return this.#clock.now(); }
}
