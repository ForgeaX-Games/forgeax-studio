/**
 * Host-context 装配(从 cli/main.ts `runCli` 抽出,供 runCli 与 TUI driver 共用)。
 *
 * 这是 forgeax-core「最小自带 host」的全量装配路径:从 env/--demo 造 provider,
 * 注 NodeSandboxFs/NodeTerminal,跑 assembleCapabilities(builtin+web+todo+notebook+
 * memory+skill+mcp+plugin+hooks+subagent),建 AgentContext,并返回 disposers/bus/store。
 *
 * ⚠️ 与同步的 `buildContext`(main.ts)区别:那条**无** mcp/plugin/hooks/disposers,
 * 只服务测试 + 简单嵌入。TUI driver 与 runCli 必须走**本文件**(§0-A、PRD §4)。
 *
 * Boundary(HOST 层):仅 core 相对 import + node:。
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { AgentContext } from '../agent/types';
import type { LLMProvider, ProviderMessage } from '../provider/types';
import { resolveProvider } from '../provider/register';
import { makeProviderCompactSummarize } from '../context/compaction-llm';
import { contextWindowForModel } from '../context/model-window';
import { NodeSandboxFs, NodeTerminal, makeNodeBackgroundSpawn } from './io';
import { EventBus } from '../events/event-bus';
import { assembleCapabilities } from '../runtime/assemble';
import { makeSpawnSyncHookRunner, makeHttpSearchBackend } from './host-bits';
import { makeStdioMcpFactory } from './mcp-stdio';
import { makeEnvTokenProvider } from './mcp-token';
import { connectStore } from '../history/event-store';
import { JsonlFileEventStore } from './event-store-fs';
import type { EventStore } from '../inject/types';
import { loadAgentDefs, buildSubagentRegistry } from '../capability/agent/index';
import { builtinSubagents } from '../capability/agent/builtin/index';
import { resolveSubagentSystem } from '../agent/subagent-registry';
import { DEFAULT_SUBAGENT_MAX_TURNS } from '../agent/subagent';
import { demoProvider } from './demo-provider';
import { TeamBoardStore, taskBoardToolsPack } from '../agent/team/task-board-tools';
import { InProcessTeammateExecutor } from '../inject/in-process-teammate-executor';
import { buildInboxClosure } from '../agent/team/inbox-router';
import { sendMessageTool } from '../capability/builtin-tools/message-tools';
import { teamSpawnTool } from '../capability/builtin-tools/team-spawn-tool';
import { makeTeamPeerSpawner } from './peer';
import { makeEnvSlot } from './env-slot';
import { effectiveSkillDirs, effectiveCommandDirs, discoverAgentDirs, discoverPluginDirs, loadMergedMcpConfig } from './locations';
import { getMergedSettings } from './settings';

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_LEADING = 'You are forgeax-core, a self-contained coding agent running as a CLI.';

/**
 * 交互式主 loop 单次用户请求的「LLM↔工具」往返硬上限。
 *
 * 交互式主会话不该被低上限硬截停——一个复杂任务轻松 >24 往返(命中即弹「已停止:
 * max_turns」)。这里只保留一个**防失控**的高位兜底(同一工具连错、token 预算、
 * reactive autocompact 等另有更精细的兜底),给正常长任务足够余量。
 * `FORGEAX_MAX_TURNS` 可覆盖(<=0 / 非法 → 退回默认)。
 *
 * 子 agent 走 `DEFAULT_SUBAGENT_MAX_TURNS`(另一个高位兜底,frontmatter 可逐类收紧),
 * 不走这个常量。
 */
export const DEFAULT_MAIN_MAX_TURNS = ((): number => {
  const raw = Number(process.env.FORGEAX_MAX_TURNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
})();

/** host-context 装配所需的输入(runCli 从 CliArgs 喂;driver 自造)。 */
export interface HostContextArgs {
  model: string;
  demo?: boolean;
  memoryDir?: string;
  skillDirs?: string[];
  /** 单文件 markdown 指令根目录(给了即只用 flag,关闭自动发现)。 */
  commandDirs?: string[];
  mcpConfigPath?: string;
  /** MCP server→ENVVAR token 映射(透传给 makeEnvTokenProvider)。 */
  mcpTokenMap?: Record<string, string>;
  pluginDirs?: string[];
  hooksConfigPath?: string;
  searchUrl?: string;
  /** 会话 id(--resume/--session)。设了即开磁盘 WAL + connectStore。 */
  sessionId?: string;
  /** 会话 WAL 根目录(默认 ./.forgeax/sessions)。 */
  sessionsDir?: string;
}

/** 全量装配结果。disposers 退出时必须 await(R4)。 */
export interface HostContext {
  context: AgentContext;
  /** plugins/hooks/WAL 订阅的同一 bus。 */
  bus: EventBus;
  provider: LLMProvider;
  /** per-session 磁盘 WAL(--resume 时;否则 undefined)。 */
  store?: EventStore;
  /** 退出清理:断 store + dispose 装配的子进程(mcp/plugin/hooks)。 */
  disposers: Array<() => void | Promise<void>>;
  /** team 模式(FORGEAX_TEAM=1):coordinator 的 inbox 闭包——挂到 CoreAgent.inbox 收 peer 回报。
   *  非 team → undefined(CoreAgent 不挂 inbox,零变化)。 */
  coordinatorInbox?: () => ProviderMessage[];
}

/** map model → provider api family(anthropic↔openai-compat↔...)。 */
export function pickApi(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai-compat';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('deepseek')) return 'deepseek-v4';
  return 'anthropic-messages';
}

/** 解析 provider(env/--demo/override 三态)。 */
export function resolveHostProvider(args: { model: string; demo?: boolean }, providerOverride?: LLMProvider): LLMProvider {
  if (args.demo || providerOverride) return providerOverride ?? demoProvider();
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 未设置。设置后重试,或用 --demo 演示 CLI 形态。');
  return resolveProvider(pickApi(args.model), {
    apiKey,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    headers: { 'anthropic-version': '2023-06-01' },
  });
}

/** 读 hooks 配置文件:支持顶层即 settings,或 `{hooks:{...}}` 包裹。 */
function readHooksSettings(path: string): Record<string, Array<{ matcher?: string; command: string }>> {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown> } & Record<string, unknown>;
  return (j.hooks ?? j) as Record<string, Array<{ matcher?: string; command: string }>>;
}

/**
 * 跑全量装配路径,产出 AgentContext + bus + disposers(+ 可选 WAL store)。
 * 与 runCli 的装配逻辑同源(单一真相),TUI driver 直接复用。
 */
export async function buildHostContext(args: HostContextArgs, providerOverride?: LLMProvider): Promise<HostContext> {
  const provider = resolveHostProvider(args, providerOverride);
  const sandboxFs = new NodeSandboxFs();
  // toolContext 开放形状:assemble 建出的后台进程注册表(007)在装配后挂到 shellRegistry。
  const toolContext: Record<string, unknown> = { sandboxFs, terminal: new NodeTerminal(), cwd: process.cwd() };
  const bus = new EventBus();
  const searchBackend = args.searchUrl ? makeHttpSearchBackend(args.searchUrl) : undefined;

  // 自动发现:各能力按 `.forgeax` 约定发现「项目级 + 用户级」目录(项目优先,见 locations.ts)。
  //   规则:**给了 flag 就只用 flag**(关闭该能力的自动发现);否则用发现到的两层目录。
  const skillDirs = effectiveSkillDirs(args.skillDirs);
  const commandDirs = effectiveCommandDirs(args.commandDirs);
  const pluginDirs = args.pluginDirs?.length ? args.pluginDirs : discoverPluginDirs();

  // subagent 类型注册表:内置(Explore / general-purpose)+ 磁盘 agents(项目级 + 用户级)。
  const disk = loadAgentDefs(discoverAgentDirs());
  const registry = buildSubagentRegistry(builtinSubagents, disk);

  // MCP:`--mcp` 给了只读该文件;否则合并 `<root>/mcp.json`(项目键覆盖用户键)。无 → undefined。
  const mcpConfig = loadMergedMcpConfig(args.mcpConfigPath);

  // hooks:`--hooks` 给了走文件;否则读合并 settings 的 `hooks` 键(user<project<local,补上
  //   settings.json 里 hooks 之前未被加载的缺口)。两者都空 → 不挂。
  const hooksSettings = args.hooksConfigPath
    ? readHooksSettings(args.hooksConfigPath)
    : (getMergedSettings().hooks as Record<string, Array<{ matcher?: string; command: string }>> | undefined);

  const assembled = await assembleCapabilities({
    bus,
    searchBackend,
    memory: args.memoryDir ? { dir: args.memoryDir, sandboxFs } : undefined,
    skillDirs,
    commandDirs,
    mcp: mcpConfig
      ? {
          config: mcpConfig,
          // host 注入接缝:stdio spawn factory + env-based token provider;env 透传给
          // parseMcpConfig 做 `${VAR}` 展开 + `auth.tokenEnv` 解析。
          deps: {
            stdioFactory: makeStdioMcpFactory(),
            tokenProvider: makeEnvTokenProvider(args.mcpTokenMap),
          },
          env: process.env,
        }
      : undefined,
    // 007:host 注入真实非阻塞 spawn → 后台 bash 三件套可用。
    backgroundSpawn: makeNodeBackgroundSpawn(),
    pluginSources: pluginDirs.map((d) => ({ source: 'session' as const, dir: d })),
    hooks: hooksSettings && Object.keys(hooksSettings).length > 0
      ? { settings: hooksSettings, runHook: makeSpawnSyncHookRunner() }
      : undefined,
    task: {
      provider,
      model: args.model,
      toolContext,
      registry,
      resolveSystem: (t) =>
        resolveSubagentSystem(
          registry,
          t,
          `You are a ${t ?? 'general'} subagent of forgeax-core. Do the task and report the result concisely.`,
        )!,
      compactionV2: { summarize: makeProviderCompactSummarize(provider, args.model) },
      contextWindow: contextWindowForModel(args.model),
      // 子 agent 兜底上限;某 agent 的 frontmatter `max-turns` 仍可逐类收紧(对齐 cc)。
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
    },
  });

  // 007:把装配出的后台进程注册表挂到 toolContext,供三工具经 ctx 取用。
  if (assembled.shellRegistry) toolContext.shellRegistry = assembled.shellRegistry;

  // ── team 接线(FORGEAX_TEAM=1;coordinator-view,无 OOS-3)─────────────────────
  //   per-session 一个共享任务表 + 进程内 executor(mailbox 两平面)+ team 共享 bus。
  //   coordinator(本 agent,id='cli')持 team 工具(task_* + SendMessage + team_spawn);
  //   peer 经 team_spawn 的注入 spawnPeer(HOST 层 makeTeamPeerSpawner)真起,剥 team_spawn/Task。
  //   coordinator inbox 从 executor.mailbox drain peer 的 SendMessage(经既有 CoreAgent.inbox 接缝)。
  const coordinatorId = 'cli';
  let coordinatorInbox: (() => ProviderMessage[]) | undefined;
  let leadingSystemText = DEFAULT_LEADING;
  const teamTools = [];
  // 运行期读 env(非 module-load const):**默认开**;`FORGEAX_TEAM=0` 显式关。
  //   demo provider 不组队(echo 驱不动 peer)→ demo 形态下恒关。
  if (process.env.FORGEAX_TEAM !== '0' && !args.demo) {
    const board = new TeamBoardStore({ teamId: 'tui-team' }); // 内存态(session 内可见;落盘已单测覆盖)
    const executor = new InProcessTeammateExecutor();
    executor.register(coordinatorId);
    const teamBus = new EventBus();
    toolContext.teamBoard = board; // coordinator 的 task_* 工具据此解析共享板
    toolContext.agentId = coordinatorId; // claim 的 owner 主键(loop 不把 context.agentId 注进 tool ctx)
    coordinatorInbox = buildInboxClosure({ self: coordinatorId, mailbox: executor.mailbox });
    const spawnPeer = makeTeamPeerSpawner({ provider, model: args.model, executor, bus: teamBus, board, coordinatorId });
    teamTools.push(
      ...(taskBoardToolsPack().tools ?? []),
      sendMessageTool({ executor, coordinatorId }),
      teamSpawnTool({ spawnPeer }),
    );
    // ★ 让模型理解「启动一个 team」= 用这些工具(否则模型会去翻代码、问你 team 是啥)。
    leadingSystemText +=
      '\n\nTEAM MODE is ON. You are the team coordinator and have team tools: ' +
      '`team_spawn` (form a team of peer agents), `task_create`/`task_list`/`task_get`/`task_update` ' +
      '(a shared task board with atomic claim/owner/blockedBy; task_update {action:"claim"} to take a task), ' +
      'and `SendMessage` (talk to peers / coordinator). ' +
      'When the user asks to start/launch/test a team or its members: seed work with `task_create`, ' +
      'then call `team_spawn` with members (each {name, brief}); peers self-claim tasks from the board and ' +
      'report back to you via SendMessage (you receive their reports next turn). Use `task_list` to see progress. ' +
      'Do NOT go read the source code to figure out what "team" means — just use these tools.';
  }

  const context: AgentContext = {
    agentId: coordinatorId,
    provider,
    config: {
      // env slot 排静态段首:紧跟 leading 作 cwd 锚点(防模型瞎拼绝对路径)。
      systemPromptSlots: [makeEnvSlot(), ...assembled.slots],
      leadingSystemText,
      model: args.model,
      tools: [...assembled.tools, ...teamTools],
      maxTurns: DEFAULT_MAIN_MAX_TURNS,
    },
    toolContext,
  };

  const disposers: Array<() => void | Promise<void>> = [...assembled.disposers];

  // per-session 磁盘 WAL(--resume <id> / --continue):接同一 bus 持久化事件流
  //   (必须在 assembleCapabilities 之后 → connectStore 排在 blocking hooks 之后,§6.3)。
  let store: EventStore | undefined;
  if (args.sessionId) {
    const file = resolvePath(args.sessionsDir ?? `${process.cwd()}/.forgeax/sessions`, args.sessionId, 'events.jsonl');
    store = new JsonlFileEventStore(file);
    const disconnect = connectStore(bus, store);
    disposers.unshift(disconnect);
  }

  return { context, bus, provider, store, disposers, ...(coordinatorInbox ? { coordinatorInbox } : {}) };
}
