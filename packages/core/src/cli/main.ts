#!/usr/bin/env bun
/**
 * forgeax-core CLI — the runnable form factor。
 *
 * forgeax-core 既是可 embed 的库,也以此 CLI 直接运行:它充当「最小自带 host」,
 * 注入 NodeSandboxFs/NodeTerminal(真实 IO)+ 从 env 造 provider,驱动 CoreAgent 跑
 * 一轮/REPL,把 AgentEvent 流渲染到终端。
 *
 * 用法:
 *   bun src/cli/main.ts -p "做个 X"        # 一次性 print 模式
 *   bun src/cli/main.ts                     # REPL(逐行读 stdin)
 *   bun src/cli/main.ts --demo -p "hi"      # 不需 API key,用内置 echo provider 演示形态
 * env: ANTHROPIC_API_KEY(必需,除非 --demo) · ANTHROPIC_BASE_URL(可选,M1/M2/M4) ·
 *      FORGEAX_MODEL(默认 claude-opus-4-8)
 * Boundary: 仅 core 相对 + node:。
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { CoreAgent } from '../agent/agent';
import type { AgentContext } from '../agent/types';
import { builtinToolsPack } from '../capability/builtin-tools/index';
import { webToolsPack } from '../capability/builtin-tools/web-tools';
import { todoToolsPack } from '../capability/builtin-tools/todo-tools';
import { notebookToolsPack } from '../capability/builtin-tools/notebook-tools';
import { memoryPack } from '../capability/memory/index';
import { skillPack } from '../capability/skill/index';
import { makeTaskTool, DEFAULT_SUBAGENT_MAX_TURNS } from '../agent/subagent';
import { loadAgentDefs, buildSubagentRegistry } from '../capability/agent/index';
import { builtinSubagents } from '../capability/agent/builtin/index';
import { resolveSubagentSystem } from '../agent/subagent-registry';
import { AutoMemory } from '../capability/memory/auto';
import { resolveProvider } from '../provider/register';
import type { LLMProvider, ProviderStreamEvent, Usage, ProviderRequest } from '../provider/types';
import { EMPTY_USAGE } from '../provider/types';
import { makeProviderCompactSummarize } from '../context/compaction-llm';
import { microCompact } from '../context/micro-compaction';
import { contextWindowForModel } from '../context/model-window';
import type { ProviderMessage } from '../provider/types';
import { NodeSandboxFs, NodeTerminal, makeNodeBackgroundSpawn } from './io';
import { BackgroundShellRegistry } from '../capability/builtin-tools/shell-registry';
import { EventBus } from '../events/event-bus';
import type { AskUserFn } from '../agent/dispatch';
import { makeAskUser, makeHttpSearchBackend } from './host-bits';
import { foldSessionHistory } from './resume-fold';
import type { EventStore } from '../inject/types';
import { resolve as resolvePath } from 'node:path';
import { renderEvent } from './render';
import type { AutoMemoryHook } from '../agent/agent';
import { demoProvider } from './demo-provider';
import { buildHostContext, resolveHostProvider, pickApi, DEFAULT_MODEL, DEFAULT_LEADING, DEFAULT_MAIN_MAX_TURNS } from './host-context';
import { getMergedSettings } from './settings';
import { discoverSkillDirs, discoverCommandDirs, discoverAgentDirs } from './locations';
import { makeEnvSlot } from './env-slot';

export interface CliArgs {
  prompt?: string;
  model: string;
  demo: boolean;
  help: boolean;
  version: boolean;
  /** auto-memory 落盘目录;undefined = 关闭。 */
  memoryDir?: string;
  /** skill 根目录(可逗号分隔/多次)。 */
  skillDirs?: string[];
  /** 单文件 markdown 指令根目录(可逗号分隔/多次)。 */
  commandDirs?: string[];
  /** MCP 配置文件路径(`{mcpServers:{...}}`)。 */
  mcpConfigPath?: string;
  /** MCP server→ENVVAR token 映射(`--mcp-token <server=ENVVAR | ENVVAR>`)。 */
  mcpTokenMap?: Record<string, string>;
  /** plugin 源目录(可逗号分隔/多次)。 */
  pluginDirs?: string[];
  /** settings hooks 配置文件路径(`{PreToolUse:[...],...}` 或 `{hooks:{...}}`)。 */
  hooksConfigPath?: string;
  /** 扩展思考:true=默认预算;数字=budget tokens。 */
  thinking?: boolean | number;
  /** web_search 后端 URL(POST {query})。 */
  searchUrl?: string;
  /** 交互式权限:全部放行(否则 'ask' fail-closed deny)。 */
  yes?: boolean;
  /** serve 模式:在 --sock 指定的 unix-sock 上起双向 JSON-RPC(供 sidecar 托管)。 */
  serve?: boolean;
  /** serve 模式监听的 per-session unix-sock 路径。 */
  sock?: string;
  /** 会话 id(--resume/--session)。设了即开磁盘 WAL + 跨进程 resume。 */
  sessionId?: string;
  /** --continue:续接「default」会话(= --resume default 的快捷)。 */
  continueSession?: boolean;
  /** 会话 WAL 根目录(默认 ./.forgeax/sessions)。 */
  sessionsDir?: string;
  /** 关闭 Ink TUI,强制走原 readline REPL(§0-C / R9 回落)。 */
  noTui?: boolean;
}

function appendList(prev: string[] | undefined, v: string): string[] {
  return [...(prev ?? []), ...v.split(',').map((s) => s.trim()).filter(Boolean)];
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    // 模型优先级:`--model` flag(下方循环覆盖)> FORGEAX_MODEL env >
    //   ANTHROPIC_MODEL env > 合并后的 settings.model(user<project<local,
    //   上轮 /model 选择)> DEFAULT_MODEL。
    model:
      process.env.FORGEAX_MODEL ??
      process.env.ANTHROPIC_MODEL ??
      getMergedSettings().model ??
      DEFAULT_MODEL,
    demo: false,
    help: false,
    version: false,
    memoryDir: process.env.FORGEAX_MEMORY_DIR ?? `${process.cwd()}/.forgeax/memory`,
    sessionsDir: process.env.FORGEAX_SESSIONS_DIR ?? `${process.cwd()}/.forgeax/sessions`,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-p' || t === '--print') a.prompt = argv[++i];
    else if (t === '--model') a.model = argv[++i];
    else if (t === '--demo') a.demo = true;
    else if (t === '--memory') a.memoryDir = argv[++i];
    else if (t === '--no-memory') a.memoryDir = undefined;
    else if (t === '--skills') a.skillDirs = appendList(a.skillDirs, argv[++i]);
    else if (t === '--commands') a.commandDirs = appendList(a.commandDirs, argv[++i]);
    else if (t === '--mcp') a.mcpConfigPath = argv[++i];
    else if (t === '--mcp-token') {
      // `<server=ENVVAR>` → 把该 server 的 token env 名记进 map;裸 `<ENVVAR>` →
      // 设为 `*` 通配(provider 对未显式映射的 server 兜底用它,优先于约定名)。
      const raw = argv[++i] ?? '';
      const eq = raw.indexOf('=');
      if (eq >= 0) {
        const server = raw.slice(0, eq).trim();
        const envName = raw.slice(eq + 1).trim();
        if (server && envName) (a.mcpTokenMap ??= {})[server] = envName;
      } else if (raw.trim()) {
        (a.mcpTokenMap ??= {})['*'] = raw.trim();
      }
    }
    else if (t === '--plugins') a.pluginDirs = appendList(a.pluginDirs, argv[++i]);
    else if (t === '--hooks') a.hooksConfigPath = argv[++i];
    else if (t === '--search-url') a.searchUrl = argv[++i];
    else if (t === '--serve') a.serve = true;
    else if (t === '--sock') a.sock = argv[++i];
    // --session-id:外部指定会话 id(新会话亦可,供外部系统事后 --resume 同一 id;对齐 cc --session-id)。
    //   --resume/--session 语义相同(已存在则续接,不存在则以此 id 新建);三者都把 id 用作 WAL 目录名。
    else if (t === '--resume' || t === '--session' || t === '--session-id') a.sessionId = argv[++i];
    else if (t === '-c' || t === '--continue') a.continueSession = true;
    else if (t === '--sessions-dir') a.sessionsDir = argv[++i];
    else if (t === '--yes') a.yes = true;
    else if (t === '--no-tui') a.noTui = true;
    else if (t === '--thinking') {
      // 可选紧跟一个数字预算;否则布尔开。
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) { a.thinking = Number(next); i++; } else a.thinking = true;
    }
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t === '-v' || t === '--version') a.version = true;
    else if (!t.startsWith('-') && a.prompt == null) a.prompt = t;
  }
  return a;
}

export function buildContext(args: CliArgs, providerOverride?: LLMProvider): AgentContext {
  const provider = resolveHostProvider(args, providerOverride);
  const sandboxFs = new NodeSandboxFs();
  // 007:后台 bash 三件套共享注册表(经 toolContext 开放字段挂给三工具)。
  const shellRegistry = new BackgroundShellRegistry(makeNodeBackgroundSpawn());
  const toolContext = { sandboxFs, terminal: new NodeTerminal(), cwd: process.cwd(), shellRegistry };
  const searchBackend = args.searchUrl ? makeHttpSearchBackend(args.searchUrl) : undefined;

  // 同步可构造的能力包(builtin + web/todo/notebook + memory + skill)。mcp/plugin/hooks
  // 这类异步/绑定 bus 的能力由 runCli 经 assembleCapabilities 接;buildContext 服务
  // 测试 + 简单嵌入(无 bus 副作用)。
  const memPack = args.memoryDir ? memoryPack({ memoryDir: args.memoryDir, sandboxFs }) : null;
  // skill/commands 自动发现(与 host-context 同源):给了 flag 只用 flag,否则发现项目级+用户级。
  const skillDirs = args.skillDirs?.length ? args.skillDirs : discoverSkillDirs();
  const commandDirs = args.commandDirs?.length ? args.commandDirs : discoverCommandDirs();
  const base = [
    ...(builtinToolsPack().tools ?? []),
    ...(webToolsPack({ searchBackend }).tools ?? []),
    ...(todoToolsPack().tools ?? []),
    ...(notebookToolsPack().tools ?? []),
    ...(memPack?.tools ?? []),
    ...(skillPack(skillDirs, undefined, { commandDirs }).tools ?? []),
  ];
  // subagent 类型注册表:内置(Explore / general-purpose)+ 磁盘 agents(项目级 + 用户级;
  // 磁盘同名覆盖内置)。无磁盘 agent 目录时 disk=[],registry 只含内置 —— 未指定
  // subagent_type 的 Task 解析为 undefined → 全量工具(剥 Task)+ 兜底 system,与从前一致。
  const registry = buildSubagentRegistry(
    builtinSubagents,
    loadAgentDefs(discoverAgentDirs()),
  );
  // Task 工具:父可派 subagent;子工具按 type 从 registry 解析(allTools=base,**不含 Task**,
  // 防无限递归)。子继承同一 IO。registry 的 per-type systemPrompt 优先,未命中退回兜底。
  const taskTool = makeTaskTool({
    provider,
    model: args.model,
    registry,
    allTools: base,
    resolveSystem: (t) =>
      resolveSubagentSystem(registry, t, `You are a ${t ?? 'general'} subagent of forgeax-core. Do the task and report the result concisely.`)!,
    toolContext,
    compactionV2: { summarize: makeProviderCompactSummarize(provider, args.model) }, // subagent 自压缩(V2)
    contextWindow: contextWindowForModel(args.model),
    // 子 agent 兜底上限;某 agent 的 frontmatter `max-turns` 仍可逐类收紧(对齐 cc)。
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
  });
  return {
    agentId: 'cli',
    provider,
    config: {
      // env slot 排静态段首:给模型 cwd 锚点(防瞎拼绝对路径)。
      systemPromptSlots: [makeEnvSlot(), ...(memPack?.slots ?? [])],
      leadingSystemText: DEFAULT_LEADING,
      model: args.model,
      tools: [...base, taskTool],
      maxTurns: DEFAULT_MAIN_MAX_TURNS,
    },
    toolContext,
  };
}

/** --thinking 标志 → ProviderRequest.thinking。 */
function thinkingFromArg(t: boolean | number | undefined): ProviderRequest['thinking'] | undefined {
  if (t == null || t === false) return undefined;
  if (t === true) return { type: 'enabled', budgetTokens: 8192 };
  return { type: 'enabled', budgetTokens: t };
}

export interface RunTurnOpts {
  autoMemory?: AutoMemoryHook;
  /** plugins/hooks 订阅的同一 bus(runCli 传;不传则 agent 自建,无订阅者)。 */
  bus?: EventBus;
  /** 交互式权限回路。 */
  askUser?: AskUserFn;
  /** 扩展思考配置。 */
  thinking?: ProviderRequest['thinking'];
  /** 回合中插话源。 */
  steeringSource?: () => ProviderMessage[];
  /** per-session 磁盘 WAL。设了即:每轮从它 fold 出历史喂进 agent.run(跨进程 resume)。
   *  事件的持久化由 runCli 在同一 bus 上 connectStore 完成,本字段只负责「读回历史」。 */
  store?: EventStore;
  /** team(FORGEAX_TEAM):coordinator inbox 闭包,挂 CoreAgent.inbox 收 peer 回报。 */
  inbox?: () => ProviderMessage[];
}

/** 跑一轮,把渲染结果写到 out(默认 stdout)。返回终态 reason。 */
export async function runTurn(
  context: AgentContext,
  prompt: string,
  out: (s: string) => void,
  opts: RunTurnOpts = {},
): Promise<string> {
  const agent = new CoreAgent({
    context,
    bus: opts.bus,
    globalCacheEnabled: true,
    // CLI 独立形态自管权限:开 core 内置受保护路径检查,保护本机 .git/.forgeax/shell-rc。
    enableSafetyCheck: true,
    autoMemory: opts.autoMemory,
    askUser: opts.askUser,
    thinking: opts.thinking,
    steeringSource: opts.steeringSource,
    ...(opts.inbox ? { inbox: opts.inbox } : {}), // team:coordinator 收 peer 回报(既有 inbox 接缝)
    compactionV2: { summarize: makeProviderCompactSummarize(context.provider, context.config.model) }, // 主 loop 到水位自压缩(V2)
    microCompact: (msgs: ProviderMessage[]) => microCompact(msgs, { now: Date.now() }), // 每轮 time-based micro
    contextWindow: contextWindowForModel(context.config.model),
  });
  // resume:从 per-session WAL fold 出历史(本轮之前的全部事件)→ seed 进 agent.run。
  //   store 的写入由 runCli 的 connectStore(同一 bus)负责;这里只读回(抽成
  //   resume-fold.ts 的纯函数,与未来 TUI /resume、serve RPC 复用同一条 fold 路径)。
  //   空/无 store → undefined → 单轮。
  const history = await foldSessionHistory(opts.store);
  let reason = 'completed';
  for await (const ev of agent.run({
    input: { type: 'user', payload: prompt, ts: 0 },
    ...(history ? { history } : {}),
  })) {
    const s = renderEvent(ev);
    if (s) out(s);
    if (ev.type === 'done') reason = ev.terminal.reason;
  }
  await agent.drainAutoMemory(); // 等 auto-memory 后台抽取落盘
  return reason;
}

const HELP = `forgeax-core — self-contained coding agent CLI

usage:
  forgeax-core -p "<prompt>"     one-shot print mode
  forgeax-core                   REPL
  forgeax-core --demo -p "hi"    demo (no API key)

flags:
  -p, --print <prompt>   run once and exit
  --model <id>           model (default ${DEFAULT_MODEL})
  --demo                 built-in echo provider (no network)
  --memory <dir>         auto-memory dir (default ./.forgeax/memory)
  --no-memory            disable auto-memory
  --skills <dir,...>     skill root dir(s) (else auto: .forgeax/skills + ~/.forgeax/skills)
  --commands <dir,...>   markdown command dir(s) (else auto: .forgeax/commands + ~/.forgeax/commands)
  --mcp <config.json>    MCP servers config ({mcpServers:{...}}; else auto: .forgeax/mcp.json + ~/.forgeax/mcp.json)
  --mcp-token <s=ENV|ENV>  MCP bearer token env name (per server or wildcard)
  --plugins <dir,...>    plugin source dir(s)
  --hooks <config.json>  settings hooks ({PreToolUse:[{matcher,command}],...})
  --search-url <url>     web_search backend (POST {query})
  --thinking [budget]    enable extended thinking (optional token budget)
  --resume <id>          persist + resume a session (multi-turn across processes)
  --session-id <id>      use a specific session id (new or existing; alias of --resume)
  -c, --continue         resume the "default" session (shortcut for --resume default)
  --sessions-dir <dir>   session WAL root (default ./.forgeax/sessions)
  --yes                  auto-approve tools that require permission (ask)
  --no-tui               force readline REPL (disable Ink TUI)
  -h, --help             this help
  -v, --version          version
env: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, FORGEAX_MODEL, FORGEAX_MEMORY_DIR`;

/** 读 hooks 配置文件:支持顶层即 settings,或 `{hooks:{...}}` 包裹。 */
function readHooksSettings(path: string): Record<string, Array<{ matcher?: string; command: string }>> {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown> } & Record<string, unknown>;
  return (j.hooks ?? j) as Record<string, Array<{ matcher?: string; command: string }>>;
}

/** 读 stdin 全部内容作一次性 prompt(stdin 非 TTY = 管道/重定向时用)。timeoutMs 内无任何
 *  数据则放弃返回已得内容(继承的空管道「不写不关」会永久挂起,用超时兜底)。 */
function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      resolve(data);
    };
    const onData = (chunk: Buffer | string): void => {
      data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

export async function runCli(argv: string[], providerOverride?: LLMProvider): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (args.version) {
    process.stdout.write('forgeax-core 0.1.0\n');
    return 0;
  }

  // serve 模式:起 RPC server 托管本内核,常驻直到 sidecar SIGTERM(不返回)。
  if (args.serve) {
    const sock = args.sock ?? process.env.FORGEAX_CORE_SOCK;
    if (!sock) {
      process.stderr.write('forgeax-core --serve 需要 --sock <path>(或 FORGEAX_CORE_SOCK)。\n');
      return 1;
    }
    const { startServe } = await import('./serve');
    await startServe(sock);
    // 常驻:net.Server 持有事件循环;靠 SIGTERM/SIGINT 退出(startServe 已挂)。
    await new Promise<never>(() => {});
    return 0; // unreachable
  }

  const write = (s: string): void => void process.stdout.write(s);

  // ── TUI 分支(PRD §0-C / R9):裸跑 + TTY + 无 -p/--serve + 非 FORGEAX_NO_TUI/--no-tui
  //    → 起 Ink TUI(进程内 embed CoreAgent,原生 askUser 弹卡)。否则维持原 headless /
  //    --serve / readline REPL。ink 加载失败也回落 readline。判定靠运行态(TTY+flags)。
  //   判定轴(`isNonInteractive = … || !process.stdout.isTTY`):
  //   能否进 TUI 取决于**渲染目标 stdout** 是不是终端,而非 stdin。再加 raw-mode 判定——
  //   Ink useInput 收键盘需要 stdin 支持 setRawMode。于是:
  //     · stdout 被重定向(`forgeax > out.txt`)→ stdoutTTY=false → 不进 TUI(不再把界面画进文件);
  //     · stdin 是管道(`echo x | forgeax`)→ stdinRawOk=false → 不进 TUI,落到下方 headless 吸 stdin 作 prompt。
  const stdoutTTY = process.stdout.isTTY === true;
  const stdinRawOk = process.stdin.isTTY === true && typeof process.stdin.setRawMode === 'function';
  const wantTui =
    args.prompt == null &&
    !args.serve &&
    !args.noTui &&
    !process.env.FORGEAX_NO_TUI &&
    stdoutTTY &&
    stdinRawOk;
  if (wantTui) {
    try {
      const { runTui } = await import('../tui/app');
      return await runTui(args, providerOverride);
    } catch (e) {
      // ink 不可用 / TUI 起不来 → 回落 readline REPL(不阻断交互)。
      process.stderr.write(`[forgeax-core] TUI 不可用,回落 readline REPL: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // 全量装配(builtin + web/todo/notebook + memory + skill + mcp + plugin + hooks + Task),
  // plugins/hooks 订阅同一 bus(loop 用之),disposers 退出时清理。统一走 buildHostContext
  // (与 TUI driver 同源,§0-A)。
  const sessionId = args.sessionId ?? (args.continueSession ? 'default' : undefined);
  let host;
  try {
    host = await buildHostContext(
      {
        model: args.model,
        demo: args.demo,
        memoryDir: args.memoryDir,
        skillDirs: args.skillDirs,
        commandDirs: args.commandDirs,
        mcpConfigPath: args.mcpConfigPath,
        mcpTokenMap: args.mcpTokenMap,
        pluginDirs: args.pluginDirs,
        hooksConfigPath: args.hooksConfigPath,
        searchUrl: args.searchUrl,
        sessionId,
        sessionsDir: args.sessionsDir,
      },
      providerOverride,
    );
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const { context, bus, provider, store, disposers } = host;
  if (sessionId) {
    const file = resolvePath(args.sessionsDir ?? `${process.cwd()}/.forgeax/sessions`, sessionId, 'events.jsonl');
    write(`[forgeax-core] session "${sessionId}" → ${file}\n`);
  }

  // auto-memory:一个 session 一个实例,跨 REPL 轮保留 surfaced/预算。
  const autoMemory: AutoMemoryHook | undefined = args.memoryDir
    ? new AutoMemory({ memoryDir: args.memoryDir, sandboxFs: context.toolContext.sandboxFs as NodeSandboxFs, provider, model: args.model })
    : undefined;

  const runOpts: RunTurnOpts = {
    autoMemory,
    bus,
    askUser: makeAskUser(!!args.yes),
    thinking: thinkingFromArg(args.thinking),
    store,
    ...(host.coordinatorInbox ? { inbox: host.coordinatorInbox } : {}),
  };

  const cleanup = async (): Promise<void> => {
    for (const d of disposers) {
      try {
        await d();
      } catch {
        /* ignore */
      }
    }
  };

  try {
    // 一次性 prompt:显式 -p,或 stdin 是管道/重定向(非 TTY)→ 读其全部内容作单次 prompt
    //   (非 TTY stdin 吸成 prompt)。只有 stdin 是
    //   真 TTY 时才落 readline REPL —— 避免「echo x | forgeax」掉进 readline 读管道的怪行为。
    let oneShot = args.prompt;
    if (oneShot == null && process.stdin.isTTY !== true) {
      const piped = (await readStdin()).trim();
      if (piped) oneShot = piped;
    }
    if (oneShot != null) {
      await runTurn(context, oneShot, write, runOpts);
      write('\n');
      return 0;
    }
    // REPL(--no-tui + TTY / TUI 回落 → 原 readline)
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\nforgeax> ' });
    rl.prompt();
    for await (const line of rl) {
      const p = line.trim();
      if (p === '/exit' || p === '/quit') break;
      if (p) {
        await runTurn(context, p, write, runOpts);
        write('\n');
      }
      rl.prompt();
    }
    return 0;
  } finally {
    await cleanup();
  }
}

// 直接运行时执行(bun src/cli/main.ts ...)。import.meta.main 是 bun 的入口判定。
if (import.meta.main) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
