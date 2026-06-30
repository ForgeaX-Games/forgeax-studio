/**
 * TUI 契约(T0 冻结;改动需先同步 docs/features/cli-tui-tasks.md §T0)。
 *
 * 这里只放**类型与函数签名的真相**:复用 forgeax-core 原生类型(AgentEvent /
 * PermissionResult / ToolUse / AskUserFn)+ 本期本地 UI 契约。T1–T8 全部面向本
 * 文件编程,不依赖彼此实现。
 *
 * ⚠️ 契约冻结:接口/类型一经交付即冻结。若需变更,先改 tasks.md §T0 再改这里。
 *
 * 实现归属:
 *   - registerX / resolveX / listCommands 系列函数在各 registry.ts 实现并副作用注册;
 *   - useTheme/useSession/useStatusLine/useInputHistory/usePermissionQueue 在
 *     providers 目录实现;
 *   - useAgent / AgentDriver 在 driver/useAgent.tsx 实现。
 *   本文件只(可选)re-export 它们,不持有逻辑。
 *
 * Boundary(HOST 层):仅 core 相对 import + react(type-only)。
 */
import type React from 'react';

// ── 复用 forgeax-core 原生类型(不重定义)──
import type { AgentEvent } from '../agent/types';
import type { PermissionResult } from '../capability/types';
import type { ToolUse, AskUserFn } from '../agent/dispatch';
import type { ProviderMessage } from '../provider/types';
import type { AskQuestionFn, AskQuestionItem, AskQuestionAnswer } from '../inject/types';
export type { AgentEvent, PermissionResult, ToolUse, AskUserFn, ProviderMessage };
export type { AskQuestionFn, AskQuestionItem, AskQuestionAnswer };

// ── 命令补齐批次(025)A 层能力的返回/入参类型(type-only,接出口用)──
import type { PermissionMode } from '../permission/engine';
import type { UsageSummary, ContextStats } from '../context/usage-stats';
import type { McpInspectResult } from '../capability/mcp/inspect';
import type { PermissionRulesView } from '../permission/inspect';
import type { SessionSummary } from '../cli/resume-fold';
import type { AgentInfo } from '../capability/agent/inspect';
import type { MemoryListing } from '../capability/memory/inspect';
import type { ExtensionRow } from '../capability/extensions-inspect';
import type { StatusSnapshot } from '../cli/status-aggregate';
import type { DoctorReport } from '../cli/doctor';
import type { InitProjectResult } from '../cli/init-project';
// ── 回退点(checkpoint)类型:文件快照 diff + 锚点列表 ──
import type { DiffStats, FileDiffStat } from '../cli/checkpoint-store';
import type { CheckpointEntry } from '../cli/checkpoint-manager';
export type {
  PermissionMode,
  UsageSummary,
  ContextStats,
  McpInspectResult,
  PermissionRulesView,
  SessionSummary,
  AgentInfo,
  MemoryListing,
  ExtensionRow,
  StatusSnapshot,
  DoctorReport,
  InitProjectResult,
  DiffStats,
  FileDiffStat,
  CheckpointEntry,
};

/** 挂起态回退的 UI 视图(driver 由内存 boundary + manager.pending 派生)。 */
export interface PendingRewindView {
  boundaryId: string;
  /** 回退时保留的手改文件(可「这些文件也回退」);空 = 无可覆盖手改。 */
  keptDirty: string[];
  /** 已执行过「这些文件也回退」→ 可「撤销」。 */
  hasOverwrite: boolean;
  /** 该回退点是否含文件快照(false = 纯对话回退,文件动作不可用)。 */
  hasCode: boolean;
}

/** rewind 一轮的产物(供 Repl 据此更新 transcript)。 */
export type RewindOutcome =
  | { boundaryId: string; filesChanged: string[]; keptDirty: string[] }
  | { error: string };

// ── 本地 UI 消息模型(把 AgentEvent + 本地 user 输入统一成可渲染条目)──
//   user 条目可带 msgId:回退点的文件快照锚点(submit 时由 driver.checkpointTurn 生成)。
//   /resume 重建的历史无 msgId(walEventsToUiMessages 不产)→ 该会话文件回退按 ordinal
//   best-effort,见 checkpoint-manager。
export type UiMessage =
  | { kind: 'user'; text: string; msgId?: string }
  | { kind: 'agent'; event: AgentEvent }; // 原生事件直接挂

// ── Session 真相 = 有序事件日志(梁②;reduceTranscript 的输入)──
/** session 的真相 = 有序条目日志:本地 user 输入 + 原生 AgentEvent。
 *  reduceTranscript(log) 把它折成可渲染的 TranscriptItem[]。 */
export type SessionEntry =
  | { kind: 'user'; text: string }
  | { kind: 'event'; event: AgentEvent };

// ── Transcript 模型(梁②;reduceTranscript 输出的可渲染条目)──
/** 配对 tool_call/tool_result 后的工具卡状态。 */
export type ToolItemStatus = 'running' | 'ok' | 'error';
/** 一条可渲染条目:user / assistant(text|thinking) / tool(配对后) / notice(done!=completed/aborted/错误)。 */
export type TranscriptItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; event: AgentEvent }
  | {
      kind: 'tool';
      id: number;
      toolUseId: string;
      name: string;
      input: unknown;
      status: ToolItemStatus;
      result?: unknown;
      isError?: boolean;
    }
  | { kind: 'notice'; id: number; level: 'info' | 'warn' | 'error'; text: string };

// ── Theme(全程经 useTheme() 取色,严禁硬编码)──
export interface ThemeTokens {
  text: string;
  dim: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  border: string;
  bg: string;
  userMark: string;
  assistantMark: string;
  diffAdd: string;
  diffRemove: string;
  diffAddBg: string;
  diffRemoveBg: string;
  codeBg: string;
  /** 用户消息整行底色(满宽灰条)。 */
  userBg: string;
}

// ── 工具视图渲染器(梁①;by canonical name,不带 kind)──
/** 渲染器签名:已过 driver.toolMeta(name).canonical 解析,故 name=canonical 真名。
 *  每渲染器只读该工具自己已知的 input/result 形状(无跨工具共享形状耦合)。
 *  registry 按 canonical 真名注册(`bash`/`edit_file`/`read_file`…),default 兜底。 */
export type ToolView = (p: {
  name: string;
  displayName: string;
  input: unknown;
  result?: unknown;
  status: 'running' | 'ok' | 'error';
  isError?: boolean;
  theme: ThemeTokens;
}) => React.ReactNode;

// ── 输入 / 焦点模型(梁③;单 owner + mode 机 + 归一化)──
/** 整 TUI 唯一 useInput 的路由模式;按 mode 派给对应 handler。
 *  `scroll` 给 todo-001(滚动视口)留的插槽。 */
export type InputMode =
  | 'prompt'
  | 'command-menu'
  | 'model-picker'
  | 'resume-picker'
  | 'permission'
  | 'question'
  | 'rewind'
  | 'remote-control'
  | 'scroll';

/** 归一化按键:Ink 怪癖(DEL/BS 合并 chunk、esc=meta、方向键…)修一次后的统一形状。
 *  一个 chunk 可能产出多枚(连按退格 → count 或多 Key,见地基方案 §9 R4)。 */
export interface Key {
  kind:
    | 'char'
    | 'enter'
    | 'backspace'
    | 'left'
    | 'right'
    | 'home'
    | 'end'
    | 'up'
    | 'down'
    | 'esc'
    | 'ctrl-c'
    | 'ctrl-o'
    | 'paste'
    | 'tab';
  /** kind==='char'|'paste' 时的文本载荷。 */
  text?: string;
  /** 连按合并时的重复计数(如退格 ×3);拆不出时省略(见 §9 R4)。 */
  count?: number;
}

/** 输入框编辑状态(promptReducer 的不可变状态;多行 + 光标)。
 *  value=全文(可含 \n);cursor=字符偏移(0..value.length)。 */
export interface PromptState {
  value: string;
  cursor: number;
}

// ── Slash 命令 ──
/**
 * 命令上下文(025 批次扩展)。基础四件(send/clear/exit/setModel)+ 命令补齐批次需要
 * 的「渲染口 + 能力 getter」。能力真实现都在 AgentDriver(读 host/opts/rules/mode),
 * Repl 在构造 ctx 时把它们委派到 driver;命令文件只调 ctx、各自格式化输出经 print 落地。
 */
export interface CommandCtx {
  send(text: string): void;
  clear(): void;
  exit(): void;
  /** 注:forgeax-core 只有「模型」,无 kernel。 */
  setModel(id: string): void;
  /** 命令输出口:把一段文本作为 assistant 文本条目推进 session(命令统一渲染出口)。 */
  print(text: string): void;
  // —— 可观测性(015)——
  getUsage(): UsageSummary;
  getContextStats(): ContextStats;
  // —— MCP(016)——
  listMcp(): Promise<McpInspectResult>;
  // —— 权限(017)+ plan(021)——
  getPermissionRules(): PermissionRulesView;
  setPermissionMode(mode: PermissionMode): void;
  // —— 会话恢复(018)——
  listSessions(): SessionSummary[];
  resume(id: string): Promise<boolean>;
  /** 恢复会话**并把历史回灌进当前 transcript**(替换):返回 true=命中。
   *  Repl 注入:agent.resumeSession(id) 重建 UiMessage[] → session.replaceAll。 */
  resumeInto(id: string): Promise<boolean>;
  // —— agent / memory / 扩展(020/022/023)——
  listAgents(): AgentInfo[];
  listMemory(): MemoryListing;
  listSkills(): ExtensionRow[];
  listPlugins(): ExtensionRow[];
  listHooks(): ExtensionRow[];
  // —— 概览 / 自检(024)——
  getStatus(): StatusSnapshot;
  runDoctor(): Promise<DoctorReport>;
  // —— 压缩(014)/ init(019)——
  triggerCompact(instructions?: string): Promise<{ compacted: boolean; usedLLM: boolean }>;
  runInit(force?: boolean): Promise<InitProjectResult>;
}
export interface SlashCommand {
  name: string;
  desc: string;
  run(ctx: CommandCtx, args: string): void | Promise<void>;
  /** 来源:内置(静态注册)或 file(用户 `~/.forgeax/commands` 等的 markdown 指令)。缺省=builtin。 */
  source?: 'builtin' | 'file';
  /** file 指令:把参数展开成最终 prompt(由 Repl 作为一轮 user 输入提交;此时 run 不被调用)。 */
  expand?(args: string): string;
}

// ── 权限审批(桥接原生 askUser ↔ UI)──
export type PermissionDecision = 'allow-once' | 'allow-always' | 'deny';
export interface PermissionProps {
  use: ToolUse;
  perm: PermissionResult;
  theme: ThemeTokens;
  onDecision(d: PermissionDecision): void;
}

// ── Provider 状态契约 ──
export interface SessionState {
  messages: UiMessage[];
  push(m: UiMessage): void;
  clear(): void;
  /** 回退:只保留前 count 条消息(双击 esc 的回退点面板用)。 */
  rewindTo(count: number): void;
  /** 整体替换消息历史(/resume 选中后把恢复会话的 transcript 回灌进来,替换当前)。 */
  replaceAll(messages: UiMessage[]): void;
}
export interface StatusState {
  model?: string;
  ctxPct?: number;
  tokens?: number;
  elapsedMs?: number;
  busy: boolean;
  set(p: Partial<StatusState>): void;
}
export interface InputHistory {
  items: string[];
  add(s: string): void;
  /** 上一条历史。`current` 是当前输入框草稿:离开 live 位置(首次上翻)时被暂存,
   *  下翻回到底部时由 next() 还原,避免「上翻后下翻丢失正在输入的草稿」。 */
  prev(current?: string): string | undefined;
  next(): string | undefined;
  /** 整体替换历史栈并把游标复位到 live 位置、清空草稿。
   *  resume 选中历史会话后调用:用该会话的 user prompts 重新播种,
   *  使 ↑/↓ 翻的是恢复会话的历史输入,而非 resume 前本会话敲过的内容。 */
  reset(items: string[]): void;
}

/** 一条挂起的权限审批(桥接 askUser 回调 ↔ UI 选择)。 */
export interface PendingPermission {
  id: string;
  use: ToolUse;
  perm: PermissionResult;
  resolve(allow: boolean): void;
}
export interface PermissionQueue {
  pending: PendingPermission[];
  /** driver 注入的 askUser:UI 提供回调,enqueue → 等用户选择 → resolve(boolean)。 */
  ask: AskUserFn;
  /** UI 对队首(或指定 id)做决策。 */
  decide(id: string, allow: boolean): void;
}

// ── 结构化提问(桥接原生 askQuestion ↔ UI;区别于权限 askUser 的 yes/no)──
/** 一条挂起的结构化提问(= 一次 AskUserQuestion 工具调用的整组问题)。
 *  cursor 指向当前正在回答的问题;selections[i] 是第 i 题已勾选的选项下标(multiSelect 用,
 *  单选题忽略,确认时取高亮项)。 */
export interface PendingQuestion {
  id: string;
  items: AskQuestionItem[];
  cursor: number;
  /** 每题已勾选的「真选项」下标(不含自填项;multiSelect 用,单选题确认时取高亮项)。 */
  selections: number[][];
  /** 每题的「其它/自填」文本缓冲(独立于聊天输入框草稿,避免抢草稿)。 */
  others: PromptState[];
}
export interface QuestionQueue {
  pending: PendingQuestion[];
  /** driver 注入的 askQuestion:enqueue 一组问题 → 逐题收集 → resolve(answers,与 questions 同序)。 */
  ask: AskQuestionFn;
  /** multiSelect:勾选/取消当前题的某「真选项」(单选题、或下标越界=自填项 时为 no-op)。 */
  toggle(id: string, optionIndex: number): void;
  /** 编辑当前题的自填缓冲(用户在「其它」项里打字)。 */
  editOther(id: string, next: PromptState): void;
  /** 确认当前题:highlightIndex === options.length 即选中自填项(取自填文本);
   *  单选取高亮项、多选取已勾选集 + 非空自填;推进下一题,末题组装 answers 并 resolve。 */
  confirm(id: string, highlightIndex: number): void;
  /** 跳过/取消整组提问:以「每题空选」resolve(对齐 cc 的「declined to answer」)。 */
  cancel(id: string): void;
}

// ── agent driver(embed CoreAgent;直构,不走 runTurn,见 PRD §0-A)──
export interface AgentDriver {
  /** 跑一轮:把 AgentEvent 逐个回调(driver 内部 reduce 进 session)。done 时 resolve。 */
  driveTurn(prompt: string, onEvent: (e: AgentEvent) => void): Promise<void>;
  /** 取消在飞轮:CoreAgent.abort() → turn_aborted + done。 */
  abort(reason?: string): void;
  /** 按模型发来的名(含 aliases)解析回真工具,产出视图元信息(梁①)。
   *  canonical = 真工具 name;别名漂移在此被吃掉(`Bash`→`bash`)。
   *  未命中(MCP/plugin/未知)→ name 原样回、isMcp 据 `mcp__` 前缀启发。
   *  查渲染器/审批卡前必经 toolMeta(name).canonical,永不用模型裸名直查。 */
  toolMeta(name: string): { canonical: string; displayName: string; isReadOnly: boolean; isMcp: boolean };
  /** 切下一轮模型:**整 context 重建**(provider + Task 工具 + compaction + window,
   *  pickApi 可能换 api 家族;见 PRD §0-D),非仅换 provider。 */
  setModel(id: string): void;
  /** 当前 model id(状态栏 / 重建用)。 */
  readonly model: string;
  /** 当前激活会话 id(= 启动时 --session/--resume 指定或自动生成的 WAL 目录名)。
   *  /resume 面板据此默认高亮「当前正在用的会话」,未设/不在列表则回退第一条。 */
  readonly sessionId?: string;
  /** 注入权限回调(T7 接);未注入时按 deny/allow 占位。 */
  setAskUser(fn: AskUserFn): void;
  /** 注入结构化提问回调(AskUserQuestion 工具用);未注入时工具优雅降级(unsupported)。
   *  driver 把它挂到 toolContext.askQuestion(agent dispatch 经 ctx 取用),setModel 重建后自动重挂。 */
  setAskQuestion(fn: AskQuestionFn): void;
  /** allow-always(T7.5):就地把一条整工具 allow 规则推进 driver 持有的**可变 rules 对象**
   *  (同一引用、in-place,绝不重新赋值;见 PRD §0-B)。下一次派发引擎 ⑦ 即判 allow。
   *  ⚠️ 受保护路径(.git/ .forgeax/ shell rc)因 safetyCheck bypass 免疫,仍会弹卡(§0-E)。 */
  allowAlways(toolName: string): void;
  /** 透传权限模式给下一轮 CoreAgent(喂 CoreAgentOptions.mode)。025 起放开到全 PermissionMode
   *  (含 'plan' 只读规划 / 'acceptEdits'),供 /permissions /plan 命令切换。 */
  setMode(mode: PermissionMode): void;

  // ── 命令补齐批次(025)能力:真实现读 host/opts/rules/mode,经 ctx 委派给命令 ──
  /** 累计 usage 摘要(token + 估费;driver 从 stream 事件累积,跨 model 切换不清零)。 */
  getUsage(): UsageSummary;
  /** 当前上下文占用(token / 窗口百分比 / 距压缩水位)。 */
  getContextStats(): ContextStats;
  /** 状态栏数字:当前上下文窗口占用(input+cache,非累计)+ 在飞 output 估算;随流实时。 */
  getContextTokens(): number;
  /** 巡检所有配置的 MCP server(连接态 + 工具数 + deferred)。 */
  listMcp(): Promise<McpInspectResult>;
  /** 当前权限规则集 + 模式(可渲染视图)。 */
  getPermissionRules(): PermissionRulesView;
  /** 列可恢复会话(扫 WAL 目录)。 */
  listSessions(): SessionSummary[];
  /** 恢复指定会话:fold 出历史并 reseed 下一轮(命中 → true)。 */
  resume(id: string): Promise<boolean>;
  /** 恢复会话并重建可渲染 transcript:读全量 WAL → 既 reseed 下一轮 LLM 历史(foldFromStore),
   *  又把事件流映射回 UiMessage[] 供 Repl 回灌 transcript。无此会话 / 空 → null。 */
  resumeSession(id: string): Promise<UiMessage[] | null>;
  /** 列内置 + 已加载自定义 subagent。 */
  listAgents(): AgentInfo[];
  /** 列当前记忆条目(从 memoryDir)。 */
  listMemory(): MemoryListing;
  /** 列已加载 skill / plugin / hooks。 */
  listSkills(): ExtensionRow[];
  listPlugins(): ExtensionRow[];
  listHooks(): ExtensionRow[];
  /** 会话概览(model/cwd/会话/权限/MCP/usage 聚合)。 */
  getStatus(): StatusSnapshot;
  /** 环境自检(provider 连通 / MCP 可达)。 */
  runDoctor(): Promise<DoctorReport>;
  /** 手动压缩当前会话历史:压缩成功则就地替换 driver 历史并 reseed。 */
  triggerCompact(instructions?: string): Promise<{ compacted: boolean; usedLLM: boolean }>;
  /** 跑 init 子流程:产 AGENTS.md。 */
  runInit(force?: boolean): Promise<InitProjectResult>;
  /** 回退点(双击 esc 面板选中):重置 agent 并以给定历史重新播种,下一轮从该点续接。
   *  history 由 Repl 从保留的会话条目重建(user/assistant 文本轮)。 */
  rewindHistory(history: ProviderMessage[]): void;
  /** /clear:清空 driver 持有的对话历史(convo + 挂起 reseed)并重置 agent,下一轮从空续接。
   *  ⚠️ 只清显示(session.clear)不够 —— CoreAgent 每轮从 driver 的 convo 重建 LLM 历史,
   *  不清 convo 则下一轮仍把全部旧历史发给 provider(/clear「没生效」)。 */
  clearHistory(): void;

  // ── 回退点 · 文件 + 对话双回退状态机(checkpoint)──
  /** 每轮提交前对 cwd 拍 CAS 快照,返回锚点 msgId(无 store / 失败 → null,绝不抛)。 */
  checkpointTurn(): string | null;
  /** 列锚点(供 RewindPanel 渲染;hasCode 标该锚点有无文件快照)。 */
  listCheckpoints(): CheckpointEntry[];
  /** 当前挂起态(无 → null);驱动 pending 子面板与文件动作可用性。 */
  pendingRewind(): PendingRewindView | null;
  /** 确认面板的 diff 预览(盘上现状 vs 目标 checkpoint);无文件快照 → 空 DiffStats。 */
  previewRewind(msgId: string): DiffStats | null;
  /** 完整回退:存 pre-rewind 对话快照(messages+convo)+ 文件 pre-rewind 快照 → restore
   *  文件到目标 → reseed convo 到 targetHistory → 进挂起态。messages 截断由 Repl 负责。 */
  rewind(input: {
    msgId: string;
    hasCode: boolean;
    currentMessages: UiMessage[];
    targetHistory: ProviderMessage[];
  }): Promise<RewindOutcome>;
  /** 恢复(Redo):还原 pre-rewind 对话(返回 messages 交回 Repl 重灌)+ 文件。 */
  cancelRewind(): Promise<{ messages: UiMessage[]; keptDirty: string[] } | { error: string }>;
  /** 「这些文件也回退」:覆盖回退时保留的手改(覆盖前 safety 快照)。 */
  overwriteDirty(): Promise<{ files: string[] } | { error: string }>;
  /** 「撤销」上一步的「这些文件也回退」。 */
  undoOverwrite(): Promise<{ files: string[] } | { error: string }>;
  /** 新消息到达 → 定格挂起态(此后不可 Redo)。每次 submit 入轮前调。 */
  finalizeRewind(): void;

  /** 退出清理(assembleCapabilities 的 disposers)。 */
  dispose(): Promise<void>;
}
