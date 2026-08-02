import { build } from 'bun';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('./dist', { recursive: true, force: true });

const result = await build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  target: 'browser',
  format: 'esm',
  sourcemap: 'linked',
  minify: false,
  packages: 'bundle',
});

for (const log of result.logs) console.log(String(log));
if (!result.success) process.exit(1);

mkdirSync('./dist', { recursive: true });
writeFileSync(
  './dist/index.d.ts',
  `export declare const NPC_PROTOCOL_VERSION: 1;

export interface Vec2 { x: number; y: number }
export type AffordanceParam =
  | { type: 'enum'; source: 'waypoint' }
  | { type: 'enum'; source: 'nearby.id' }
  | { type: 'enum'; source: 'literal'; values: string[] };
export interface Affordance { action: string; params?: Record<string, AffordanceParam> }
export interface PerceptionSnapshot {
  v: 1;
  eventId: string;
  game: string;
  npcId: string;
  t: number;
  trigger: 'player_message' | 'event' | 'heartbeat' | 'attach' | 'spotlight';
  playerId?: string;
  text?: string;
  self: { pos: Vec2; activity: string; mood?: string };
  nearby: Array<{ kind: string; id: string; pos: Vec2; facts: string[] }>;
  events: Array<{ type: string; [key: string]: string | number | boolean | null }>;
  affordances: Affordance[];
  recentEvents?: string[];
  scene?: string;
  visibilityGroup?: string;
}
export interface NpcDecision {
  v: 1;
  npcId: string;
  seq: number;
  intent?: { action: string; params?: Record<string, string>; ttlSec: number };
  utterance?: { lines: string[] };
  emotion?: { mood: string; towards?: Record<string, number> };
  fallback?: boolean;
}
export type NpcWireEnvelope = Record<string, unknown> & { type: string; v: 1; eventId: string; epoch: number; seq: number; ack?: number };
export interface NpcClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface ReconnectOptions { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number }
export interface NpcBudget { maxDecisions?: number; maxConcurrent?: number }
export interface SpotlightHooks {
  onPromote?: (npcId: string) => void;
  onDemote?: (npcId: string) => void;
  onAttach?: (npcId: string) => void;
  onDetach?: (npcId: string) => void;
}
export type NpcCognitiveLod = 'spotlight' | 'ambient' | 'offstage';
export interface NpcSoulBinding { npcId: string; soulId?: string }
export interface NpcClientOptions {
  game: string;
  npcIds: string[];
  /** Explicit NPC-to-Soul bindings. Supplying these makes missing declared packs a server error. */
  npcs?: NpcSoulBinding[];
  playerId?: string;
  endpoint?: string;
  authToken?: string;
  fetcher?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocket;
  now?: () => number;
  clock?: NpcClock;
  reconnect?: ReconnectOptions;
  heartbeatMs?: number;
  samplingIntervalMs?: number;
  livenessTimeoutMs?: number;
  utterancePaceMs?: number;
  budget?: NpcBudget;
  onDecision?: (decision: NpcDecision) => void;
  onBudget?: (budget: { limit: number; used: number; remaining: number }) => void;
  onIntentExpired?: (npcId: string, intent: NonNullable<NpcDecision['intent']>) => void;
  onFallback?: (snapshot: PerceptionSnapshot, reason: Error) => void;
  onUtteranceLine?: (npcId: string, line: string, lineIndex: number) => void;
  spotlight?: SpotlightHooks;
}
export declare const npcProtocol: {
  readonly version: 1;
  decision(value: unknown): NpcDecision;
  envelope(value: unknown): NpcWireEnvelope;
  sessionResponse(value: unknown): unknown;
  snapshot(value: unknown): PerceptionSnapshot;
};
export declare class NpcClient {
  static connect(options: NpcClientOptions): Promise<NpcClient>;
  constructor(options: NpcClientOptions);
  declareAffordances(npcId: string, affordances: Affordance[]): void;
  affordancesFor(npcId: string): readonly Affordance[];
  onDecision(npcId: string, handler: (decision: NpcDecision) => void): () => void;
  onFallback(npcId: string, handler: (error: Error) => void): () => void;
  connect(): Promise<void>;
  decide(snapshot: PerceptionSnapshot, timeoutMs?: number): Promise<NpcDecision | undefined>;
  decideBatch(snapshots: PerceptionSnapshot[], budget?: NpcBudget): Promise<Array<NpcDecision | undefined>>;
  emit(snapshot: PerceptionSnapshot): Promise<NpcDecision | undefined>;
  sampleWorld(sampler: (npcId: string) => PerceptionSnapshot | undefined): Promise<void>;
  tick(dt: number, sampler: (npcId: string) => PerceptionSnapshot | undefined): void;
  tick(sampler: (npcId: string) => PerceptionSnapshot | undefined): void;
  isThinking(eventId?: string): boolean;
  currentIntent(npcOrDecision: string | NpcDecision | undefined): NpcDecision['intent'] | undefined;
  intentExpired(receivedAt: number, decision: NpcDecision): boolean;
  promote(npcId: string, snapshot?: PerceptionSnapshot): void;
  demote(npcId: string): void;
  setLod(npcId: string, level: NpcCognitiveLod, snapshot?: PerceptionSnapshot): void;
  lod(npcId: string): NpcCognitiveLod;
  attach(npcId: string, snapshot?: PerceptionSnapshot, binding?: { soulId?: string }): Promise<void>;
  detach(npcId: string): Promise<void>;
  connectWebSocket(): Promise<void>;
  sendSnapshot(snapshot: PerceptionSnapshot): Promise<void>;
  sendSnapshots(snapshots: PerceptionSnapshot[]): Promise<void>;
  resume(): Promise<{ reset: boolean }>;
  endEpisode(): Promise<void>;
  disconnect(): void;
}
`,
);
console.log(`[build] @forgeax/npc-client -> dist (${result.outputs.length} outputs)`);
