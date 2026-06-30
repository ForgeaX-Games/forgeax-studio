/**
 * Injection interfaces — the host→core contract (设计稿 core-layer-spec §4).
 *
 * forgeax-core declares these; the host (forgeax-cli / agent-host) provides
 * implementations and injects them. core does NO real IO itself: persistence,
 * scheduling, fs, shell, sandbox, tree state, config merge, path layout all live
 * behind these interfaces. Phase F0 ships the surface; later phases wire it.
 *
 * Boundary: this file imports ONLY core-local types + agent-runtime/types.
 */
import type { CoreEvent, Unsubscribe } from '../events/types';
import type { Observability } from '../observability/contract';
import type { TeamMessage } from '../agent/team/team-message';

export type { Unsubscribe };

// ─── §4.1 EventStore — WAL persistence ───────────────────────────────────

export interface ReadOpts {
  /** Resume from this event index / id (inclusive), if the store supports it. */
  from?: number | string;
  limit?: number;
}

export interface EventFilterSpec {
  /** Match by event type(s); empty / omitted = all. */
  types?: string[];
}

export interface EventStore {
  /** Ordered append (events land in call order). The host decides durability /
   *  atomicity (it is the host's SLA — §4.1). */
  append(events: CoreEvent[]): Promise<void>;
  /** Optional replay on core boot. */
  read?(opts?: ReadOpts): AsyncIterable<CoreEvent>;
  /** Optional cross-host notification (capability/plugin may consume). */
  watch?(filter: EventFilterSpec): AsyncIterable<CoreEvent>;
}

// ─── §4.2 HandoffSink — scheduler protocol ────────────────────────────────

/** Minimal AgentSpec — the host resolves a template into this. Shape stays open
 *  (forward-compat); F6/Template-host refines it. */
export interface AgentSpec {
  type: string;
  cwd?: string;
  requirement?: string;
  [key: string]: unknown;
}

export type SleepCondition = { kind: 'event'; eventType: string } | { kind: 'timer'; ms: number };

export type HandoffIntent =
  | { kind: 'spawn_child'; spec: AgentSpec; mode: 'fg' | 'bg' }
  | { kind: 'pop_self'; result: unknown }
  | { kind: 'sleep'; until: SleepCondition }
  | { kind: 'resume_target'; agentId: string }
  // `agentId` 仅为「目标显式化」字段(team 下指定终止哪个成员;缺省 = 现有「终止本注册表
  //  所有在跑」语义)。本轮 M1 **只落字段、无行为**:成员级 abort 的兑现逻辑归 P3(见
  //  team-contract-coexistence.md)。
  | { kind: 'abort'; reason: string; agentId?: string };

export interface WakeupTrigger {
  eventType: string;
  payload?: unknown;
}

export type HandoffResolution =
  | { kind: 'ack' }
  | { kind: 'child_result'; events: CoreEvent[] }
  | { kind: 'wakeup'; trigger: WakeupTrigger };

export interface HandoffSink {
  /** core declares intent; the host scheduler decides when to execute / wake.
   *  No core-side timeout — host never resolving is a host SLA issue (§6.21). */
  declare(intent: HandoffIntent): Promise<HandoffResolution>;
}

// ─── §4.2bis TeammateExecutor — host spawn-fulfillment seam (team, 设计 §13.1#2) ──
//
// 分层(HandoffSink ↔ TeammateExecutor 契约共存,详见 docs/team-contract-coexistence.md):
//
//   ┌─ HandoffSink ──── 模型 intent 信道(**不动**)──────────────────────────────┐
//   │ 模型在 loop 内经 Handoff 工具声明意图(spawn_child/sleep/resume_target/      │
//   │ pop_self/abort);core 只「声明」,何时执行/唤醒由 host 调度器决定。           │
//   └──────────────────────────────────────────────────────────────────────────┘
//   ┌─ TeammateExecutor ── host spawn 兑现接缝(**新增**)────────────────────────┐
//   │ 当 host 要把一个 spawn intent 真正兑现成一个常驻 teammate 时,经本接缝;并提供 │
//   │ 「带外」(out-of-band,不经模型 loop)的 sendMessage/terminate/kill/isActive。 │
//   │ core 只持接口,host 注入实现(in-process TUI 后端 / server-WS studio 后端);  │
//   │ 后端是唯一变量,team 编排逻辑全在 core。对照 cc backends/types.ts 五法。      │
//   └──────────────────────────────────────────────────────────────────────────┘
//
// 二者非替代关系:HandoffSink = 模型「想做什么」;TeammateExecutor = host「怎么把常驻
// teammate 跑起来 + 带外操控它」。本轮 M1 仅落契约;in-process 兑现归 M2,server-WS 归 P6。

/** spawn 返回的 teammate 句柄(`agentId` 是带外寻址主键,对照 cc `name@team`)。 */
export interface TeammateHandle {
  agentId: string;
  /** host 后端标识(便于可观测;形状开放,如 'in-process' / 'server-ws')。 */
  backend?: string;
}

/**
 * host 兑现 spawn + 带外操控常驻 teammate 的接缝(恰 5 法,对照 cc `backends/types.ts`)。
 * core 只持接口;实现由 host 经 `CoreInjection.teammateExecutor` 注入。
 */
export interface TeammateExecutor {
  /** 把一个 AgentSpec 兑现成一个常驻 teammate,返回带外寻址用的句柄。 */
  spawn(spec: AgentSpec): Promise<TeammateHandle>;
  /** 带外向某 teammate 投递一条 TeamMessage(不经模型 loop;router 真投递的兑现口)。 */
  sendMessage(to: string, msg: TeamMessage): Promise<void>;
  /** 优雅终止一个 teammate(允许其收尾)。 */
  terminate(agentId: string): Promise<void>;
  /** 强制杀死一个 teammate(不等收尾)。 */
  kill(agentId: string): Promise<void>;
  /** 该 teammate 当前是否在册/存活(状态面 / 投递前判定)。 */
  isActive(agentId: string): boolean;
  /** 当前在册成员 id 列表(`to='*'` 显式广播寻址 / 后续 ListPeers 读 roster 用;可选)。 */
  listMembers?(): string[];
}

// ─── §4.3 FSWatcher — hot-reload trigger ──────────────────────────────────

export type FsChange = 'change' | 'add' | 'unlink';

export interface FSWatcher {
  /** core registers the patterns it cares about; the host only supplies the
   *  backend (fs.watch / chokidar) + debounce. Reload logic stays in core. */
  watch(pattern: RegExp, handler: (path: string, event: FsChange) => void): Unsubscribe;
}

// ─── §4.4 TerminalManager — shell bridge ──────────────────────────────────

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface Chunk {
  stream: 'stdout' | 'stderr' | 'exit';
  /** For `exit`, `data` is the exit code as a string. */
  data: string;
}

export interface TaskHandle {
  id: string;
  agentId: string;
  cmd: string;
  startedAt: number;
  pid?: number;
}

export interface TerminalManager {
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  stream(cmd: string, args: string[], opts?: RunOpts): AsyncIterable<Chunk>;
  runBackground(cmd: string, args: string[], opts?: RunOpts): Promise<TaskHandle>;
  list(agentId: string): TaskHandle[];
  kill(taskId: string, signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  /** core triggers on abort — kill all running tasks for the agent (§6.12). */
  killAll(agentId: string): Promise<void>;
}

// ─── §4.5 SandboxFs — abstract IO ─────────────────────────────────────────

export interface DirEnt {
  name: string;
  isFile: boolean;
  isDir: boolean;
  isSymlink: boolean;
}

export interface StatResult {
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface SandboxFs {
  readTextSync(path: string): string;
  writeTextSync(path: string, content: string): void;
  mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  statSync(path: string): StatResult;
  readdirSync(path: string, opts?: { withFileTypes?: boolean }): string[] | DirEnt[];
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  readBytes(path: string, offset?: number, limit?: number): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  readStream(path: string): ReadableStream<Uint8Array>;
  writeStream(path: string): WritableStream<Uint8Array>;
}

// ─── §4.6 FsBridge — host/container routing ───────────────────────────────

export interface ResolvedTarget {
  side: 'host' | 'container';
  actualPath: string;
  readonly?: boolean;
}

export interface FsBridge {
  needsProxy(path: string): boolean;
  resolve(path: string): ResolvedTarget;
}

// ─── §4.7 TreeAccess — agent tree topology (read-only) ────────────────────

export type AgentRole = 'admin' | 'steward' | 'worker' | (string & {});

export interface AgentTreeNode {
  id: string;
  parentId: string | null;
  role: AgentRole;
  childrenIds: string[];
  children?: AgentTreeNode[];
}

export interface TreeAccess {
  getParent(agentId: string): string | null;
  getChildren(agentId: string): string[];
  getSubtree(agentId: string, depth?: number): AgentTreeNode;
  getRoot(): AgentTreeNode;
  getNode(agentId: string): AgentTreeNode | null;
}

// ─── §4.8 ConfigSource — merged agent config ──────────────────────────────

export interface ModelParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  [key: string]: unknown;
}

export interface ModelConfig {
  model: string;
  provider: string;
  apiBase?: string;
  params?: ModelParams;
  [key: string]: unknown;
}

export interface AgentConfig {
  agentId: string;
  /** condition-evaluation groups (travel with the agent, not the tree node). */
  groups?: string[];
  models?: ModelConfig;
  capabilities?: {
    enable?: string[];
    disable?: string[];
    config?: Record<string, unknown>;
  };
  defaultDir?: string;
  timezone?: string;
  /** Business extensions — core does not parse, passes through to capability. */
  [key: string]: unknown;
}

export interface ConfigSource {
  /** Latest merged config view (host owns pack/team/overrides merge — §6.20). */
  get(): Readonly<AgentConfig>;
}

// ─── §4.10 AskQuestion — 结构化提问接缝(区别于权限 askUser 的 yes/no) ────────
//
// AskUserQuestion 工具(008)经此接缝向用户发**结构化多选问题**消歧(选方案 A/B、
// 确认需求),而非只能用权限闸做 yes/no。host 决定渲染:server 走 EventBus→WS
// card-pop(与权限审批同信道、不同 payload),CLI TUI 走进程内交互浮层(013)。
// core 自身不渲染、不阻塞 —— 只声明接缝,host 实现 Promise 解析。

/** 单个问题的一个候选项。 */
export interface AskQuestionOption {
  /** 选项标签(回灌结果时即用此值,除非用户选 Other 自填)。 */
  label: string;
  /** 选项说明(给用户看的辅助文案;可选)。 */
  description?: string;
}

/** 一条结构化问题。 */
export interface AskQuestionItem {
  /** 问题正文。 */
  question: string;
  /** 短标签(UI 上给问题加的小标题,如 "方案"/"框架")。 */
  header: string;
  /** 候选项(约定 2–4 个;host 可在 UI 上额外提供 "Other" 自填入口)。 */
  options: AskQuestionOption[];
  /** 是否允许多选(默认单选)。 */
  multiSelect?: boolean;
}

/** 用户对一条问题的回答:选了哪些 label(或自填 Other 文本)。 */
export interface AskQuestionAnswer {
  /** 用户选中的 label 列表(单选时长度 1);自填 Other 时其文本也落在此数组。 */
  selected: string[];
  /** 当用户走了 "Other" 自填路径时,记其原始自填文本(observability;可选)。 */
  other?: string;
}

/** host→core 的提问接缝:core 发结构化 questions,host 收集用户选择后 resolve answers。
 *  answers 与 questions **同序**(answers[i] 对应 questions[i])。 */
export type AskQuestionFn = (
  questions: AskQuestionItem[],
  signal?: AbortSignal,
) => Promise<AskQuestionAnswer[]>;

// ─── §4.9 PathConvention — path layout injection ──────────────────────────

export interface PathConvention {
  sharedRoot(): string;
  instanceRoot(): string;
  teamRoot(): string;
  userHome(): string;
  projectRoot?(): string | null;
  agentDir(agentId: string): string;
  agentHomeDir(agentId: string): string;
  agentJsonPath(agentId: string): string;
  agentOverridesPath(agentId: string): string;
  sessionDir(agentId: string): string;
  /** forgeax self-extension (e.g. souls/<id> reincarnation dirs). */
  custom?(key: string, agentId?: string): string;
}

// ─── Aggregate injection bundle ───────────────────────────────────────────

/** Everything the host injects into a core run. All optional at F0; later phases
 *  tighten which are required. `store` absent ⇒ core defaults to in-memory (§6.5). */
export interface CoreInjection {
  store?: EventStore;
  handoff?: HandoffSink;
  /** team:host 兑现 spawn + 带外操控常驻 teammate 的接缝(§13.1#2)。缺省 → 退化为
   *  现「单 agent + 父子树」(无 team),不崩(§9 Graceful Degradation)。M2 接 in-process。 */
  teammateExecutor?: TeammateExecutor;
  fsWatcher?: FSWatcher;
  terminal?: TerminalManager;
  sandboxFs?: SandboxFs;
  fsBridge?: FsBridge;
  tree?: TreeAccess;
  config?: ConfigSource;
  paths?: PathConvention;
  /** 008:结构化提问接缝(AskUserQuestion 工具用;缺省 → 工具优雅降级报需 host 接线)。 */
  askQuestion?: AskQuestionFn;
  /** ★ 可观测性(trace+log)注入缝 —— **仅 library 形态(form factor #1)**次路径;
   *  生产主路径走 CoreAgentOptions/ForgeaxCoreKernelOptions。缺省 → NOOP。 */
  observability?: Observability;
}
