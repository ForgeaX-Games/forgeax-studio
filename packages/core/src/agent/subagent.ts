/**
 * Subagent(Task / AgentTool / forkSubagent)—— 基础能力 + 治理收口。
 *
 * 一个 subagent = 在**隔离上下文**里跑一个子 CoreAgent loop(自己的 EventBus / messages /
 * 工具集),跑到 done,**只把最终结果文本返回父**。两层"压缩"都在此:
 *   1. **subagent 自压缩**:子 loop 注入 compaction strategy → 子上下文涨到水位时自动压缩
 *      (与主 loop 同一 §3.8 fold 机制)。
 *   2. **transcript→result 压缩**:子的全程 tool 调用/中间步骤**不外溢父上下文**,父只见子
 *      最终回答(= subagent 把工作压成一个 result 的核心行为)。
 *
 * 集成层在此把三块治理原语接上(Task 的并发/递归/预算护栏):
 *   - **类型注册表**(S1 `SubagentRegistry`):Task 工具按 `subagent_type` 解析子 loop 的
 *     system / 工具集 / model / maxTurns / budget。显式 `resolveTools`/`resolveSystem` 优先,
 *     registry 作回退。
 *   - **并发上限 + 深度护栏 + 预算分摊**(S2):闭包级 `ConcurrencyLimiter` 给 Task fan-out
 *     限流;`assertDepth` 在派子前兜递归(超限抛 → 表现为 tool error,父不崩);`splitBudget`
 *     把父预算切片给子。
 *   - **终态事件 + 结果预算**(S3):子跑完发 `subagent.stop`(hook 可见);返回前用
 *     `budgetSubagentResult` 给「父读子结果」上一道兜底。
 *
 * 防递归:子的 tools 不应含 Task(由 resolveTools 控制 + `resolveSubagentTools` 强制剥离 +
 * 深度护栏三重兜底)。
 * Boundary: 仅 core 相对 import。
 */
import { CoreAgent, type CompactionV2Options } from './agent';
import type { AgentContext, TerminalReason } from './types';
import type { LLMProvider } from '../provider/types';
import { buildTool, type AgentTool, type JSONSchema, type Slot, type ToolContext } from '../capability/types';
import { makeStructuredOutputTool } from '../capability/builtin-tools/structured-output';
import type { CompactionStrategy } from '../context/types';
import type { PermissionRuleSet } from '../permission/rules';
import type { PermissionMode } from '../permission/engine';
import { EventBus } from '../events/event-bus';
import type { EventBusAPI } from '../events/types';
import {
  type SubagentRegistry,
  resolveSubagentTools,
  resolveSubagentSystem,
  describeSubagentTypes,
} from './subagent-registry';
import {
  ConcurrencyLimiter,
  depthOf,
  withIncrementedDepth,
  assertDepth,
  splitBudget,
} from './subagent-governance';
import {
  emitSubagentStop,
  emitSubagentStart,
  emitSubagentTurn,
  emitSubagentToolCall,
  budgetSubagentResult,
} from './subagent-events';
import type { BackgroundTasks } from './background';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function lastAssistantText(message: { payload?: unknown }): string {
  const content = (message.payload as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
}

/** Task 治理默认值(Task fan-out 的并发闸 / 递归深度护栏)。 */
/** Task 并发上限默认值(同一时刻最多几个子 loop)。 */
export const DEFAULT_SUBAGENT_CONCURRENCY = 8;
/** Task 递归深度上限默认值(`depth > max` 即拒)。 */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 5;
/** 父读子结果的字符兜底上限默认值(防巨型子结果灌爆父窗)。 */
export const DEFAULT_SUBAGENT_RESULT_BUDGET = 50_000;
/**
 * 子 loop 的「LLM↔工具」往返兜底上限。
 *
 * 这是个**防失控的高位兜底**,不是给正常子任务设的低墙——一个 Explore 做彻底搜索、
 * 或 general-purpose 做多步任务,轻松 >20 往返;墙太低会让子 agent 把**残缺结果**
 * 交回父(比主 loop 弹「已停止:max_turns」更隐蔽)。对齐 cc:cc 的子 agent 默认
 * **不封顶**,只在某 agent 的 frontmatter 显式声明 `max-turns`/`maxTurns` 时才收紧。
 * 这里 registry 类型声明(frontmatter)优先于本默认(见 `childMaxTurns` 解析)。
 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 200;

export interface SubagentSpec {
  /** 子任务(作 user 输入)。 */
  input: string;
  agentId?: string;
  agentType?: string;
  /** 可选:子 agent 角色标识(进 `subagent.start`/`subagent.turn` 等事件,供 host 路由/展示)。 */
  role?: string;
  /** 可选:递归深度(父=0,逐层 +1;进各 `subagent.*` 事件的 depth 字段)。 */
  depth?: number;
  /**
   * 可选:略去重型上下文标记。为 true 时在建子 AgentContext 前从 `systemPromptSlots`
   * 里剔掉名匹配 /claudeMd|gitStatus|env|directoryStructure/i 的重型 slot,让子 loop
   * 轻装上阵。无匹配 slot 时为 no-op(防御式,零回归)。
   */
  omitHeavyContext?: boolean;
  /** 子 agent 的 system 首段(角色/指令)。 */
  leadingSystemText?: string;
  systemPromptSlots?: Slot[];
  model: string;
  /** 子可用工具(**不含 Task**,防无限递归)。 */
  tools: AgentTool[];
  maxTurns?: number;
  /** subagent 自压缩策略(子上下文到水位自动压缩)。 */
  compaction?: CompactionStrategy;
  /** ★ subagent 自压缩 V2(与主 agent 同一套:比例水位 + 闸 + 管线 + 重挂)。
   *  子 agent 用**自己独立**的 CoreAgent 实例 → gateState/熔断/冷却天然隔离,不影响父。 */
  compactionV2?: CompactionV2Options;
  contextWindow?: number;
  /** 子 loop 的 token 预算(由父预算切片而来;详见 splitBudget)。 */
  taskBudget?: { total: number };
  /**
   * 可选(010):结构化返回 schema。给定时,把 `StructuredOutput` 工具挂进子工具集,
   * 强制子 agent 以**校验过的 JSON** 提交结果;最后一次合法 payload 绑定到
   * `SubagentResult.structured`。子提交非法对象 → 校验错误回灌让其重试。
   * 未给 ⇒ 不挂该工具,行为与从前 byte-for-byte 一致(零回归)。
   */
  schema?: JSONSchema;
}

export interface SubagentDeps {
  provider: LLMProvider;
  toolContext?: Omit<ToolContext, 'signal'>;
  rules?: Partial<PermissionRuleSet> | null;
  mode?: PermissionMode;
  signal?: AbortSignal;
  /**
   * hook 可见的 EventBus —— 子跑完会在此发 `subagent.stop`。缺省时退回子自己的
   * 隔离 bus(父侧 hook 看不到,仅保证不报错)。
   */
  bus?: EventBusAPI;
  /**
   * 可选:子 agent 生命周期回调(start/turn/tool_call/done)。供 host 把子 loop 的
   * 进展投射成 kernel 事件(`x.subagent.*`)。缺省 ⇒ 不发,行为与从前 byte-for-byte 一致。
   */
  onSubagentEvent?: (ev: {
    type: string;
    agentId: string;
    agentType?: string;
    role?: string;
    depth?: number;
    turn?: number;
    toolName?: string;
    toolUseId?: string;
    reason?: string;
    turns?: number;
    toolCalls?: number;
  }) => void;
}

export interface SubagentResult {
  /** 子 agent 最终回答 —— 父只见此(transcript→result 压缩)。 */
  text: string;
  terminalReason: TerminalReason;
  turns: number;
  toolCalls: number;
  /**
   * 可选(010):子 agent 经 `StructuredOutput` 提交的最后一次**合法** payload。
   * 仅当 `spec.schema` 给定且子 agent 成功提交过合法对象时存在;否则 undefined。
   */
  structured?: unknown;
}

/**
 * 在隔离上下文跑一个子 agent,返回其最终结果(父不见子中间步骤)。
 *
 * 子 loop 始终用**自己的**隔离 EventBus(上下文/transcript 不进父)。若 `deps.bus` 提供,
 * 则在子跑完后额外往该 bus 发一条 `subagent.stop`(父侧 hook 可见);缺省退回子 bus。
 */
export async function runSubagent(spec: SubagentSpec, deps: SubagentDeps): Promise<SubagentResult> {
  // omitHeavyContext:防御式剔重型 slot(名匹配 claudeMd/gitStatus/env/directoryStructure)。
  // 无匹配 ⇒ no-op,数组按原序保留,零回归。
  const baseSlots = spec.systemPromptSlots ?? [];
  const childSlots = spec.omitHeavyContext
    ? baseSlots.filter((s) => !/claudeMd|gitStatus|env|directoryStructure/i.test(s.name))
    : baseSlots;
  // 010:给了 schema → 把 StructuredOutput 工具挂进子工具集,onValid 闭包捕获最后一次合法 payload。
  //   未给 ⇒ structuredPayload 恒为 undefined,childTools 即 spec.tools 原样(零回归)。
  let structuredPayload: unknown;
  const childTools = spec.schema
    ? [
        ...spec.tools,
        makeStructuredOutputTool({
          schema: spec.schema,
          onValid: (payload) => {
            structuredPayload = payload; // 保留最后一次合法 payload 作子结构化返回值
          },
        }),
      ]
    : spec.tools;
  const context: AgentContext = {
    agentId: spec.agentId ?? 'subagent',
    agentType: spec.agentType,
    provider: deps.provider,
    config: {
      systemPromptSlots: childSlots,
      leadingSystemText: spec.leadingSystemText,
      model: spec.model,
      tools: childTools,
      maxTurns: spec.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
      taskBudget: spec.taskBudget,
    },
    toolContext: deps.toolContext ?? {},
  };
  // 子 agent 独立 EventBus → 上下文隔离,transcript 不进父。compaction 注入 = 子自压缩。
  const childBus = new EventBus();
  const child = new CoreAgent({
    context,
    bus: childBus,
    compaction: spec.compaction,
    compactionV2: spec.compactionV2,
    contextWindow: spec.contextWindow,
    rules: deps.rules,
    mode: deps.mode,
  });

  // 生命周期事件统一发到 hook 可见的父侧 bus,缺省退回子自己的隔离 bus(零回归)。
  const lifeBus = deps.bus ?? childBus;
  const agentId = context.agentId;

  // L4:子启动事件。子 loop fork 完、进 run 之前发。
  emitSubagentStart(lifeBus, { agentId, agentType: spec.agentType, role: spec.role, depth: spec.depth });
  deps.onSubagentEvent?.({
    type: 'subagent.start',
    agentId,
    agentType: spec.agentType,
    role: spec.role,
    depth: spec.depth,
  });

  let text = '';
  let terminalReason: TerminalReason = 'completed';
  let turns = 0;
  let toolCalls = 0;
  for await (const ev of child.run({ input: { type: 'user', payload: spec.input, ts: 0 }, signal: deps.signal })) {
    if (ev.type === 'assistant') {
      const t = lastAssistantText(ev.message);
      if (t) text = t; // 保留最后一条非空 assistant 文本作结果
    } else if (ev.type === 'tool_call') {
      toolCalls++;
      // L4:子工具调用事件。
      emitSubagentToolCall(lifeBus, {
        agentId,
        toolName: ev.toolName,
        toolUseId: ev.toolUseId,
        turn: turns,
        depth: spec.depth,
      });
      deps.onSubagentEvent?.({
        type: 'subagent.tool_call',
        agentId,
        toolName: ev.toolName,
        toolUseId: ev.toolUseId,
        turn: turns,
        depth: spec.depth,
      });
    } else if (ev.type === 'turn_start') {
      turns = ev.turn + 1;
      // L4:子进轮事件(turns 已更新后发)。
      emitSubagentTurn(lifeBus, { agentId, turn: turns, depth: spec.depth });
      deps.onSubagentEvent?.({ type: 'subagent.turn', agentId, turn: turns, depth: spec.depth });
    } else if (ev.type === 'done') terminalReason = ev.terminal.reason;
  }

  // S3:子终态事件。优先发到 hook 可见的父侧 bus,缺省退回子自己的隔离 bus。
  emitSubagentStop(lifeBus, {
    agentId,
    agentType: spec.agentType,
    terminalReason,
    turns,
    toolCalls,
  });
  // L4:子终态回调(与 emitSubagentStop 并列;onSubagentEvent 缺省 ⇒ no-op,零回归)。
  deps.onSubagentEvent?.({
    type: 'subagent.stop',
    agentId,
    agentType: spec.agentType,
    reason: terminalReason,
    turns,
    toolCalls,
    depth: spec.depth,
  });

  // 010:子若经 StructuredOutput 提交过合法 payload,作 structured 返回值(父/Workflow 取已校验对象)。
  return { text, terminalReason, turns, toolCalls, structured: structuredPayload };
}

// ─── worktree 隔离(P2)──────────────────────────

/** 一个已建好的子 worktree 句柄:子的工作目录 + 清理回调(吞错)。 */
interface ChildWorktree {
  /** worktree 根目录(子 toolContext.cwd 覆盖到此)。 */
  dir: string;
  /** 子跑完调用:`git worktree remove --force` + 删目录;任何错误都吞掉。 */
  cleanup: () => void;
}

/**
 * 在 `baseCwd` 这个 git 仓里建一个临时 worktree,返回其目录 + 清理回调。
 *
 * 实现(worktree 接缝,但最小化):
 *   1. `git -C <base> worktree add --detach <tmp>` —— 在 os.tmpdir 下新建一个 detached worktree;
 *   2. 返回该目录 + cleanup(`git worktree remove --force` 兜底再 `rm -rf`)。
 *
 * **优雅降级**:base 非 git 仓 / git 不可用 / add 失败 → 返回 `null`,调用方落回原 cwd
 * (默认路径完全不受影响)。所有 git 调用都 try/catch 吞错。
 */
function createChildWorktree(baseCwd: string | undefined): ChildWorktree | null {
  const cwd = baseCwd ?? process.cwd();
  // tmp 目录在 worktree add 之前先建好(git 要求目标路径不存在 → 建后即删再交给 git)。
  let dir: string;
  try {
    const stage = mkdtempSync(join(tmpdir(), 'forgeax-wt-'));
    dir = stage; // git worktree add 要求目标已存在为空目录或不存在;mkdtemp 给的是空目录,可直接用。
  } catch {
    return null;
  }
  try {
    // --detach:不创建分支,纯游离 worktree;避免污染 base 仓的分支命名空间。
    execFileSync('git', ['-C', cwd, 'worktree', 'add', '--detach', dir, 'HEAD'], {
      stdio: 'ignore',
    });
  } catch {
    // 非 git 仓 / HEAD 不存在 / git 缺失 → 删掉 stage 目录后降级。
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 吞错 */
    }
    return null;
  }
  return {
    dir,
    cleanup: () => {
      try {
        execFileSync('git', ['-C', cwd, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
      } catch {
        /* worktree remove 失败(已删/锁)→ 继续兜底 rm */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 吞错:残留临时目录无害 */
      }
    },
  };
}

// ─── Task 工具(Task / Agent 工具:父模型据此派 subagent)────────────

export interface TaskInput {
  /** 短描述(可选,渲染用)。 */
  description?: string;
  /** 交给 subagent 的任务。 */
  prompt: string;
  /** 选 subagent 类型(决定其 system + 工具集)。 */
  subagent_type?: string;
  /**
   * 可选(P2):后台跑子 agent。为 true **且** `TaskToolDeps.background` 已注入时,
   * 不 await 子 loop —— 把子 promise 登记进 `background`,立即返回占位结果
   * (`turns:0/toolCalls:0`,text 标注 `id=...`)。子跑完经 `onBackgroundDone` 回调。
   * 未注入 `background` 时**忽略本标记**,照常同步跑(零回归)。
   */
  run_in_background?: boolean;
  /**
   * 可选(P2):子 loop 在隔离 git worktree 里跑。为 `'worktree'` 时,在 `os.tmpdir()`
   * 下经 `git worktree add` 建一个临时工作区,把子的 toolContext.cwd 覆盖到该目录,
   * 子跑完后 `git worktree remove --force` 清理(吞错)。非 git cwd / git 不可用时
   * **优雅降级**为在原 cwd 里跑。标记未设时此接缝完全不触碰(零回归)。
   */
  isolation?: 'worktree';
  /**
   * 可选(010):本次子任务的结构化返回 schema。给定(或经 `TaskToolDeps.schema`
   * 缺省提供)时,把 `StructuredOutput` 挂进子工具集,强制子以校验过的 JSON 返回,
   * 合法 payload 经 `mapResult` 透出。本次 input 的 schema 优先于 deps 默认。
   */
  schema?: JSONSchema;
}

export interface TaskToolDeps {
  provider: LLMProvider;
  model: string;
  /**
   * 子 agent 可用工具(按 type 解析;**务必排除 Task 自身**防递归)。
   * 提供 `registry` 时此项可省略 —— 退回 `resolveSubagentTools(registry, type, …)`;
   * 显式提供则**优先**(registry 仅作回退)。
   */
  resolveTools?: (subagentType?: string) => AgentTool[];
  /**
   * 子 agent 的 system 首段(按 type)。提供 `registry` 时可省略 —— 退回
   * `resolveSubagentSystem(registry, type)`;显式提供则**优先**。
   */
  resolveSystem?: (subagentType?: string) => string;
  toolContext?: Omit<ToolContext, 'signal'>;
  rules?: Partial<PermissionRuleSet> | null;
  mode?: PermissionMode;
  compaction?: CompactionStrategy;
  /** ★ subagent 自压缩 V2(透传给每个子 loop;各子实例 gateState 独立)。 */
  compactionV2?: CompactionV2Options;
  contextWindow?: number;
  maxTurns?: number;
  /**
   * 可选:subagent 类型注册表(S1)。提供后:
   *  - 当 `resolveTools` 缺省时,子工具按 type 从 registry 解析(并强制剥 Task);
   *  - 当 `resolveSystem` 缺省时,子 system 按 type 从 registry 解析;
   *  - 子 loop 的 model / maxTurns / budget 也优先取该类型的声明;
   *  - 已注册类型列表会拼进 Task 工具的 `subagent_type` description。
   * 需要解析 registry 工具时,必须同时提供 `allTools`(父侧全量工具)。
   */
  registry?: SubagentRegistry;
  /** 父侧全量工具 —— registry 的 `allowedTools` 过滤器从此挑子集。 */
  allTools?: AgentTool[];
  /** Task fan-out 并发上限(同一时刻最多几个子 loop);默认 8,`<=0` 无限。 */
  concurrency?: number;
  /** Task 递归深度上限(`depth > max` 即拒);默认 5,`<=0` 关闭护栏。 */
  maxDepth?: number;
  /** 父读子结果的字符兜底上限;默认 50_000,Infinity 表示不裁。 */
  resultBudget?: number;
  /** 父 token 预算 —— 提供后按 splitBudget 切片给每个子 loop。 */
  parentBudget?: { total: number };
  /** 子预算占父预算的比例(splitBudget 的 fraction);默认 0.5。 */
  budgetFraction?: number;
  /**
   * 可选(010):子 agent 结构化返回 schema 的**缺省**值。给定时所有 Task 调用都把
   * `StructuredOutput` 挂进子工具集(单次 `TaskInput.schema` 可覆盖)。缺省 ⇒ 不挂
   * 该工具,子返回自由文本(零回归)。
   */
  schema?: JSONSchema;
  /**
   * hook 可见的 EventBus —— 子跑完会在此发 `subagent.stop`,父侧 hook(汇聚/审计/
   * preventStop)可订阅。缺省退回子自己的隔离 bus。
   */
  bus?: EventBusAPI;
  /**
   * 可选(P2):后台任务登记处。注入后,`input.run_in_background === true` 的 Task 调用
   * 不 await 子 loop —— 把子 promise 登记进此处并立即返回占位结果。**缺省 ⇒ 忽略
   * `run_in_background` 标记,照常同步跑**(零回归)。
   */
  background?: BackgroundTasks<SubagentResult>;
  /**
   * 可选(P2):后台子 loop settle(成功/失败)时回调。仅在 `background` 注入且本次
   * 走后台路径时生效;与 `background.onDone` 二选一即可(若构造 `background` 时已带
   * `onDone`,可不传此项)。缺省 ⇒ 不回调。
   */
  onBackgroundDone?: (done: {
    id: string;
    label?: string;
    result?: SubagentResult;
    error?: unknown;
  }) => void;
  /**
   * 可选:子 agent 生命周期回调(start/turn/tool_call/done),透传给每个子 loop。
   * 供 host 把子 loop 的进展投射成 kernel 事件(`x.subagent.*`)。缺省 ⇒ 不发,
   * 行为与从前 byte-for-byte 一致。
   */
  onSubagentEvent?: (ev: {
    type: string;
    agentId: string;
    agentType?: string;
    role?: string;
    depth?: number;
    turn?: number;
    toolName?: string;
    toolUseId?: string;
    reason?: string;
    turns?: number;
    toolCalls?: number;
  }) => void;
}

/**
 * 把 subagent 暴露成可调用工具(name 'Task')。**并发安全**:多 subagent 各自隔离上下文,可并行
 * —— 但受闭包级 `ConcurrencyLimiter` 限流(默认 8)、递归深度护栏(默认 5)、子结果预算(默认 50k)三道闸约束。
 *
 * 解析优先级(显式 > registry > 兜底):
 *   - 工具:`deps.resolveTools(type)` ?? `resolveSubagentTools(registry, type, allTools)` ?? `[]`
 *   - system:`deps.resolveSystem(type)` ?? `resolveSubagentSystem(registry, type)`
 *   - model / maxTurns / budget:registry 类型声明优先,否则 deps 默认。
 */
export function makeTaskTool(deps: TaskToolDeps): AgentTool<TaskInput, SubagentResult> {
  // 闭包级并发闸:同一 Task 工具实例的所有调用共享一个限流器 → 整体 fan-out 受控。
  const limiter = new ConcurrencyLimiter(deps.concurrency ?? DEFAULT_SUBAGENT_CONCURRENCY);
  const maxDepth = deps.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH;
  const resultBudget = deps.resultBudget ?? DEFAULT_SUBAGENT_RESULT_BUDGET;

  // registry 已注册类型列表 → 拼进 subagent_type description,给父模型看可选类型。
  const typeMenu = deps.registry ? describeSubagentTypes(deps.registry) : '';
  const subagentTypeDesc = typeMenu
    ? `Which kind of subagent to use. Available types:\n${typeMenu}`
    : 'Which kind of subagent to use';

  /** 解析某类型的子工具:显式 resolveTools 优先,否则走 registry(强制剥 Task),再否则空。 */
  const resolveChildTools = (type?: string): AgentTool[] => {
    if (deps.resolveTools) return deps.resolveTools(type);
    if (deps.registry) return resolveSubagentTools(deps.registry, type, deps.allTools ?? []);
    return [];
  };
  /** 解析某类型的子 system:显式 resolveSystem 优先,否则走 registry。 */
  const resolveChildSystem = (type?: string): string | undefined => {
    if (deps.resolveSystem) return deps.resolveSystem(type);
    if (deps.registry) return resolveSubagentSystem(deps.registry, type);
    return undefined;
  };

  return buildTool<TaskInput, SubagentResult>({
    name: 'Task',
    description:
      'Delegate a self-contained task to a fresh subagent that runs autonomously with its own context and the same tools, then returns a concise result. Use for multi-step research or work you want isolated from the main thread.',
    aliases: ['agent', 'task'],
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    inputJSONSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short (3-5 word) task description' },
        prompt: { type: 'string', description: 'The task for the subagent to perform' },
        subagent_type: { type: 'string', description: subagentTypeDesc },
      },
      required: ['prompt'],
    },
    call: async (input: TaskInput, ctx: ToolContext) => {
      // S2 深度护栏:派子前先校验当前深度。超限抛 → buildTool 兜成 tool error,父不崩。
      const depth = depthOf(ctx as unknown as Record<string, unknown>);
      assertDepth(depth, maxDepth);

      const type = input.subagent_type;
      const reg = deps.registry?.resolve(type);

      // registry 类型声明优先于 deps 默认(model / maxTurns / budget)。
      const childModel = reg?.model ?? deps.model;
      const childMaxTurns = reg?.maxTurns ?? deps.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS;
      // 子预算:registry 类型声明优先,否则按 splitBudget 从父预算切片。
      const childBudget =
        reg?.budget ?? splitBudget(deps.parentBudget, deps.budgetFraction);

      // S2 深度透传:子的 toolContext 深度 +1 → 子自己的 Task(若有)看到 depth+1。
      const childToolContext = withIncrementedDepth(
        (deps.toolContext ?? {}) as Record<string, unknown>,
      ) as unknown as Omit<ToolContext, 'signal'>;

      // P2 worktree 隔离:仅 isolation==='worktree' 时尝试建临时 worktree 并覆盖子 cwd。
      // 建失败(非 git 仓 / git 缺失)→ wt=null,childToolContext 不动,优雅降级回原 cwd。
      let wt: ChildWorktree | null = null;
      let runToolContext = childToolContext;
      if (input.isolation === 'worktree') {
        const baseCwd = (childToolContext as { cwd?: unknown }).cwd;
        wt = createChildWorktree(typeof baseCwd === 'string' ? baseCwd : undefined);
        if (wt) {
          // 覆盖子的 cwd 到 worktree 目录;只在建成时才动 toolContext(零回归)。
          runToolContext = { ...childToolContext, cwd: wt.dir } as Omit<ToolContext, 'signal'>;
        }
      }

      // 一次子 loop 的运行单元(限流器内跑);worktree 在子 settle 后清理(吞错)。
      const spec: SubagentSpec = {
        input: input.prompt,
        agentType: type,
        agentId: `subagent:${type ?? 'default'}`,
        // L4:registry 类型声明的 role / omitHeavyContext 透传进 spec(供事件归因 + 轻装上阵)。
        role: reg?.role,
        omitHeavyContext: reg?.omitHeavyContext,
        // L4:子深度 = 子 toolContext 已 +1 后的深度(与子自己的 Task 护栏对齐)。
        depth: depthOf(runToolContext as unknown as Record<string, unknown>),
        leadingSystemText: resolveChildSystem(type),
        model: childModel,
        tools: resolveChildTools(type),
        maxTurns: childMaxTurns,
        compaction: deps.compaction,
        compactionV2: deps.compactionV2,
        contextWindow: deps.contextWindow,
        taskBudget: childBudget,
        // 010:单次 input.schema 优先,否则退回 deps.schema 缺省;两者皆无 ⇒ 不挂 StructuredOutput。
        schema: input.schema ?? deps.schema,
      };
      const runOnce = (): Promise<SubagentResult> =>
        limiter.run(() =>
          runSubagent(spec, {
            provider: deps.provider,
            toolContext: runToolContext,
            rules: deps.rules,
            mode: deps.mode,
            signal: ctx.signal,
            bus: deps.bus,
            // L4:子生命周期回调透传(缺省 ⇒ 不发,零回归)。
            onSubagentEvent: deps.onSubagentEvent,
          }),
        );

      // P2 后台路径:run_in_background 为真**且** background 已注入 → 不 await,登记后立即返回占位。
      // background 缺省 ⇒ 落到下面同步路径,忽略 run_in_background 标记(零回归)。
      if (input.run_in_background && deps.background) {
        const bg = deps.background;
        // 子 promise 跑完后(成功/失败)清理 worktree;结果不再裁剪(占位已返回)。
        const promise = runOnce().finally(() => wt?.cleanup());
        const id = bg.start(input.description, promise);
        if (deps.onBackgroundDone) {
          promise.then(
            (result) => deps.onBackgroundDone?.({ id, label: input.description, result }),
            (error) => deps.onBackgroundDone?.({ id, label: input.description, error }),
          );
        }
        return {
          data: {
            text: `Subagent started in background (id=${id})`,
            terminalReason: 'completed' as TerminalReason,
            turns: 0,
            toolCalls: 0,
          },
        };
      }

      // 同步路径(默认):S2 并发闸内跑;无论成败都清理 worktree。
      let result: SubagentResult;
      try {
        result = await runOnce();
      } finally {
        wt?.cleanup();
      }

      // S3 结果预算:父读子结果前兜底裁剪,防巨型子结果灌爆父上下文窗。
      return { data: { ...result, text: budgetSubagentResult(result.text, resultBudget) } };
    },
    mapResult: (r, id) => ({
      type: 'tool.result',
      payload: {
        toolUseId: id,
        ok: r.terminalReason === 'completed',
        result: r.text,
        turns: r.turns,
        toolCalls: r.toolCalls,
        // 010:子经 StructuredOutput 提交的已校验对象(仅给了 schema 时存在),additive 透给父。
        ...(r.structured !== undefined ? { structured: r.structured } : {}),
      },
      ts: 0,
    }),
    maxResultSizeChars: Infinity,
  });
}
