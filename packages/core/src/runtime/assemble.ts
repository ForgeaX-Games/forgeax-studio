/**
 * assembleCapabilities (B 装配层) — 把所有 CapabilityPack 收集、索引、扁平化成可直接喂给
 * CoreAgent 的 `tools[]` + `slots[]`,并把 plugins / settings-hooks 订阅到 EventBus。
 *
 * 这是设计稿 §14.5 指出的「缺失的默认装配层」:各子系统早已是统一的 `CapabilityPack`
 * (builtin/web/todo/notebook/memory/skill/mcp/plugin),但没有 runnable 把它们装起来。
 * 本函数即该装配点 —— `createAgent`(原生 API)与 CLI 都经它拿到完整默认能力面。
 *
 * 设计要点:
 *   - 用现有 `CapabilityRegistry.assembleToolPool` 做去重/排序/deny/isEnabled 过滤,
 *     保 builtin 连续前缀(prompt-cache 断点)。
 *   - plugins 经 `Plugin.start(ctx)` 真订阅 bus;settings-hooks 经 loadHooksFromSettings 订阅;
 *     两者的解订阅都收进 `disposers`(host 在 abort/退出时调)。
 *   - Task 工具最后挂:其 subagent 工具集 = 已装配的非-Task 工具(防递归)。
 *
 * Boundary: 仅 import core-local。
 */
import { CapabilityRegistry } from '../capability/registry';
import { builtinToolsPack } from '../capability/builtin-tools/index';
import { webToolsPack, type WebSearchBackend } from '../capability/builtin-tools/web-tools';
import { todoToolsPack, type TodoStore } from '../capability/builtin-tools/todo-tools';
import { notebookToolsPack } from '../capability/builtin-tools/notebook-tools';
import { BackgroundShellRegistry, type BackgroundSpawnFn } from '../capability/builtin-tools/shell-registry';
import { lspToolsPack } from '../capability/lsp/index';
import { memoryPack } from '../capability/memory/index';
import { skillPack } from '../capability/skill/index';
import {
  parseMcpConfig,
  resolveMcpClient,
  mcpPack,
  decideMcpDeferMode,
  readMcpSyncThreshold,
  readMcpDeferDefault,
  type ResolveMcpDeps,
  type MCPClient,
} from '../capability/mcp/index';
import { loadPlugins, pluginToCapabilityPack, type HookRunner, type PluginSource } from '../capability/plugin/index';
import { loadHooksFromSettings, type HooksSettings, type HookCommandRunner } from '../capability/hooks/from-settings';
import { makeTaskTool, type TaskToolDeps } from '../agent/subagent';
import type { AgentTool, CapabilityPack, Slot } from '../capability/types';
import type { DenyRules } from '../capability/registry';
import type { EventBus } from '../events/event-bus';
import type { SandboxFs, AskQuestionFn } from '../inject/types';
import type { MemorySelectFn } from '../capability/memory/recall';

export interface AssembleCapabilitiesOptions {
  /** 订阅 plugins / settings-hooks 的 EventBus(loop 的同一 bus)。 */
  bus: EventBus;
  /** web_search 后端(注入);缺省 → web_search 调用时报未配置。 */
  searchBackend?: WebSearchBackend;
  /** web_fetch 用的 fetch(测试可注入)。 */
  fetchImpl?: typeof fetch;
  /** TodoWrite 的清单持有者(host 可读其 items 渲染)。 */
  todoStore?: TodoStore;
  /** 记忆:给了即挂 memory_search/remember + MEMORY.md slot。 */
  memory?: { dir: string; sandboxFs: SandboxFs; selectFn?: MemorySelectFn };
  /** skill 根目录(给了即挂 Skill 工具)。 */
  skillDirs?: readonly string[];
  /** 单文件 markdown 指令根目录(目录下递归 `*.md`;与 skill 合并进同一 Skill 工具)。 */
  commandDirs?: readonly string[];
  /** MCP:raw `{ mcpServers: {...} }` 配置 + 注入接缝(stdio/ws/sdk factory / fetch / tokenProvider)
   *  + env 源(用于 `${VAR}` 展开与 `auth.tokenEnv` 解析)。 */
  mcp?: { config: unknown; deps?: ResolveMcpDeps; env?: Record<string, string | undefined> };
  /** plugin 源目录(给了即扫描加载,hooks 订阅 bus)。 */
  pluginSources?: readonly PluginSource[];
  /** plugin hook 动作的 host 执行器(plugin 的 hooksConfig 命中时)。 */
  runHook?: HookRunner;
  /** settings 形状 hooks(PreToolUse/PostToolUse/Stop) + 同步命令执行器。 */
  hooks?: { settings: HooksSettings; runHook: HookCommandRunner };
  /** 给了即把 subagent 暴露成 Task 工具(resolveTools 缺省=当前非-Task 工具集)。 */
  task?: Omit<TaskToolDeps, 'resolveTools'> & { resolveTools?: TaskToolDeps['resolveTools'] };
  /** 装配期 deny 过滤(工具名 / mcp server 前缀)。 */
  deny?: DenyRules;
  /** 007 后台 bash 三件套:host 注入的非阻塞 spawn 接缝(输出回调式)。给了即建
   *  后台进程注册表并经 `shellRegistry` 返回,host 须挂到 toolContext.shellRegistry。
   *  缺省 → bash(run_in_background)/bash_output/kill_shell 调用时优雅 loud throw。 */
  backgroundSpawn?: BackgroundSpawnFn;
  /** 008 结构化提问接缝:host 注入的 askQuestion 回调(AskUserQuestion 工具用)。给了即经
   *  `askQuestion` 原样返回,host 须挂到 toolContext.askQuestion 供工具经 ctx 取用。
   *  缺省 → AskUserQuestion 调用时优雅降级(回灌 unsupported,不断流)。 */
  askQuestion?: AskQuestionFn;
}

export interface AssembledCapabilities {
  tools: AgentTool[];
  slots: Slot[];
  /** abort / 退出时调:解 plugin 订阅、关 MCP 连接、解 settings-hooks。 */
  disposers: Array<() => void | Promise<void>>;
  /** 007:后台 bash 三件套的进程注册表(仅当注入 backgroundSpawn 时存在)。
   *  host 须把它挂到 `toolContext.shellRegistry` 供三工具经 ctx 取用。 */
  shellRegistry?: BackgroundShellRegistry;
  /** 008:结构化提问接缝(仅当注入 askQuestion 时存在)。host 须把它挂到
   *  `toolContext.askQuestion` 供 AskUserQuestion 工具经 ctx 取用。 */
  askQuestion?: AskQuestionFn;
}

/** 收集所有 pack → 扁平 tools/slots + 订阅副作用。见文件头。 */
export async function assembleCapabilities(opts: AssembleCapabilitiesOptions): Promise<AssembledCapabilities> {
  const registry = new CapabilityRegistry();
  const disposers: Array<() => void | Promise<void>> = [];
  const packs: CapabilityPack[] = [];

  // 007:给了非阻塞 spawn 接缝 → 建后台进程注册表;退出/abort 时 kill 残留进程。
  let shellRegistry: BackgroundShellRegistry | undefined;
  if (opts.backgroundSpawn) {
    shellRegistry = new BackgroundShellRegistry(opts.backgroundSpawn);
    const reg = shellRegistry;
    disposers.push(() => {
      reg.killAll('SIGKILL');
    });
  }

  // ① 内核通用工具 + 新增 web/todo/notebook(默认全开)。
  packs.push(builtinToolsPack());
  packs.push(webToolsPack({ searchBackend: opts.searchBackend, fetchImpl: opts.fetchImpl }));
  packs.push(todoToolsPack({ store: opts.todoStore }));
  packs.push(notebookToolsPack());
  packs.push(lspToolsPack()); // LSP 代码智能工具(独立 pack;缺 server 时优雅降级)。

  // ② 记忆(memory_search/remember + MEMORY.md slot)。
  if (opts.memory) {
    packs.push(memoryPack({ memoryDir: opts.memory.dir, sandboxFs: opts.memory.sandboxFs, selectFn: opts.memory.selectFn }));
  }

  // ③ skill(+ 单文件 markdown 指令;两者合并进同一 Skill 工具)。
  if ((opts.skillDirs && opts.skillDirs.length > 0) || (opts.commandDirs && opts.commandDirs.length > 0)) {
    packs.push(skillPack(opts.skillDirs ?? [], undefined, { commandDirs: opts.commandDirs }));
  }

  // ④ MCP:解析配置 →(pass1)连接+计数 → decideMcpDeferMode →(pass2)按 deferMode 打 pack。
  //   接 M1 注入治理:默认 defer —— MCP 工具首轮不全量上线,改由 ToolSearch 现取现用
  //   (省首轮 prompt token / 保 prompt-cache)。裁决器与 `/mcp` 巡检(inspect.ts)同一个,
  //   保证「显示会 defer」与「实际装配」一致。
  if (opts.mcp) {
    const { servers, errors } = parseMcpConfig(opts.mcp.config, { env: opts.mcp.env });
    for (const e of errors) process.stderr.write(`[assemble] mcp config: ${e}\n`);

    // pass1:连接 + initialize + 拉工具数(client 留着给 pass2 复用,避免二次连接)。
    const serverConfigs: Record<string, { defer_loading?: boolean } | undefined> = {};
    const toolCounts: Record<string, number> = {};
    const live: Array<{ name: string; client: MCPClient }> = [];
    for (const s of servers) {
      serverConfigs[s.name] = { defer_loading: s.config.defer_loading };
      try {
        const client = await resolveMcpClient(s.name, s.config, opts.mcp.deps);
        // 协议握手(fail-soft):tools/list 之前先 initialize(若 client 支持)。
        // 失败不阻断后续 list —— 与既有 graceful-degradation 一致。
        const maybeInit = (client as { initialize?: () => Promise<unknown> }).initialize;
        if (typeof maybeInit === 'function') {
          await maybeInit.call(client).catch(() => {});
        }
        const tools = await client.listTools();
        toolCounts[s.name] = tools.length;
        live.push({ name: s.name, client });
      } catch (e) {
        toolCounts[s.name] = 0;
        process.stderr.write(`[assemble] mcp "${s.name}": ${(e as Error).message}\n`);
      }
    }

    // 用与 /mcp 诊断同一裁决器算每 server 模式(env 从 opts.mcp.env 取,缺省 defer)。
    const { perServer } = decideMcpDeferMode(
      serverConfigs,
      toolCounts,
      readMcpSyncThreshold(opts.mcp.env ?? {}),
      readMcpDeferDefault(opts.mcp.env ?? {}),
    );

    // pass2:按 deferMode 打 pack。async server 的工具声明 shouldDefer(首轮不上线)。
    for (const { name, client } of live) {
      try {
        packs.push(await mcpPack(client, name, { deferMode: perServer[name] }));
        const maybeClose = (client as { close?: () => unknown }).close;
        if (typeof maybeClose === 'function') {
          disposers.push(() => {
            maybeClose.call(client);
          });
        }
      } catch (e) {
        process.stderr.write(`[assemble] mcp "${name}": ${(e as Error).message}\n`);
      }
    }
  }

  // ⑤ plugin:扫目录加载 → 转 pack(hooks 经 buildHooksPlugin 订阅 bus)。
  if (opts.pluginSources && opts.pluginSources.length > 0) {
    const { plugins, errors } = loadPlugins(opts.pluginSources);
    for (const e of errors) process.stderr.write(`[assemble] plugin ${e.path}: ${e.reason}\n`);
    for (const lp of plugins) packs.push(pluginToCapabilityPack(lp, opts.bus, { runHook: opts.runHook }));
  }

  // 索引所有 pack 的 tools/slots/plugins(同名后注册覆盖 = 高层 override 近似)。
  for (const p of packs) {
    for (const t of p.tools ?? []) registry.registerTool(t);
    for (const s of p.slots ?? []) registry.registerSlot(s);
    for (const pl of p.plugins ?? []) registry.registerPlugin(pl);
  }

  // 启动 plugins(真订阅 bus),收集 dispose。
  for (const pl of registry.listPlugins()) {
    const dispose = await pl.start({});
    disposers.push(dispose);
  }

  // settings hooks 订阅。
  if (opts.hooks) {
    disposers.push(loadHooksFromSettings(opts.bus, opts.hooks.settings, opts.hooks.runHook));
  }

  // 工具池装配(builtin 连续前缀 + 去重 + deny + isEnabled)。
  let tools = registry.assembleToolPool({ deny: opts.deny });

  // Task 最后挂:subagent 工具集 = 当前非-Task 工具(防无限递归)。
  // 无 registry → 显式 resolveTools 兜底为全量非-Task(与从前 byte-for-byte 一致);
  // 有 registry → resolveTools 留空让 makeTaskTool 走 registry 路径(按 type 过滤 +
  // 强制剥 Task),allTools 缺省取当前非-Task 工具池。
  if (opts.task) {
    const nonTask = tools;
    const taskTool = makeTaskTool({
      ...opts.task,
      allTools: opts.task.allTools ?? (opts.task.registry ? nonTask : undefined),
      resolveTools: opts.task.resolveTools ?? (opts.task.registry ? undefined : () => nonTask),
    });
    tools = [...tools, taskTool];
  }

  // 008:把 host 的 askQuestion 接缝原样透出,host 须挂到 toolContext.askQuestion。
  const result: AssembledCapabilities = { tools, slots: registry.listSlots(), disposers };
  if (shellRegistry) result.shellRegistry = shellRegistry;
  if (opts.askQuestion) result.askQuestion = opts.askQuestion;
  return result;
}
