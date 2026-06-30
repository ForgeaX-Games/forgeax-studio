/**
 * Agent driver —— 进程内 embed CoreAgent(直构,不走 runTurn;PRD §0-A)。
 *
 * 数据层:复用 cli/host-context 的全量装配(buildHostContext = assembleCapabilities
 * 路径,含 mcp/plugin/hooks/disposers),**不复用 runTurn**(它把事件 renderEvent
 * 成字符串写 stdout,正是 TUI 要替换的那层)。driver 直接 `new CoreAgent({...})`,
 * 迭代 agent.run,把 AgentEvent 流逐个回调给 React。
 *
 * 关键不变量:
 *   - rules 是 driver 持有的**同一可变对象**({deny,ask,allow}),按引用传给 CoreAgent;
 *     allowAlways 就地 push(绝不重新赋值,§0-B)→ 下一轮派发引擎 ⑦ 即命中。
 *   - setModel 整 context 重建(provider+Task+compaction+window,§0-D),dispose 旧装配。
 *   - dispose await 装配的 disposers(R4)。
 *
 * T0 交付最小可用实现;T2 在本文件硬化(取消收尾 / resume fold / 错误事件)。
 * Boundary(HOST 层):react + 相对 import(含 ../cli/host-context)。
 */
import React, { createContext, useContext } from 'react';
import { CoreAgent } from '../../agent/agent';
import type { AgentContext, AgentEvent } from '../../agent/types';
import type { AskUserFn } from '../../agent/dispatch';
import { findTool } from '../../agent/dispatch';
import type { PermissionRuleSet } from '../../permission/rules';
import type { PermissionMode } from '../../permission/engine';
import type { LLMProvider, ProviderMessage } from '../../provider/types';
import { makeProviderCompactSummarize } from '../../context/compaction-llm';
import { microCompact } from '../../context/micro-compaction';
import { contextWindowForModel } from '../../context/model-window';
import { buildHostContext, type HostContext, type HostContextArgs } from '../../cli/host-context';
import { effectiveSkillDirs } from '../../cli/locations';
import { updateUserSettings } from '../../cli/settings';
import type { AgentDriver, UiMessage, PendingRewindView, RewindOutcome, DiffStats } from '../contracts';
import { CheckpointManager } from '../../cli/checkpoint-manager';
import { defaultSessionsDir } from '../../cli/resume-fold';
// ── 命令补齐批次(025)A 层能力 + 装配接缝 ──
import { type Usage, EMPTY_USAGE } from '../../provider/types';
import { summarizeUsage, contextStats } from '../../context/usage-stats';
import { inspectMcpServers, type InspectMcpOptions } from '../../capability/mcp/inspect';
import { getPermissionRules } from '../../permission/inspect';
import { listSessions, foldSessionById, readSessionEvents } from '../../cli/resume-fold';
import { foldFromStore } from '../../history/llm-fold-adapter';
import { walEventsToUiMessages } from '../transcript/rehydrate';
import { inspectAgents } from '../../capability/agent/inspect';
import { listMemory } from '../../capability/memory/inspect';
import { listSkills, listPlugins, listHooks } from '../../capability/extensions-inspect';
import { getStatus } from '../../cli/status-aggregate';
import { runDoctor } from '../../cli/doctor';
import { triggerCompact as runManualCompact } from '../../context/manual-compact';
import { runInitProject } from '../../cli/init-project';
import { computeWatermarksFromModel } from '../../context/watermarks';
import { lookupModelContext } from '../../context/model-context-table';
import { makeStdioMcpFactory } from '../../cli/mcp-stdio';
import { makeEnvTokenProvider } from '../../cli/mcp-token';
import { builtinSubagents } from '../../capability/agent/builtin/index';
import { loadAgentDefs } from '../../capability/agent/index';
import type { SandboxFs, AskQuestionFn } from '../../inject/types';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 上下文窗口占用口径(对齐 cc calculateContextPercentages):input + cacheCreation + cacheRead,
 *  不含 output(output 不在当前 prompt 里,要到下一轮作历史进 input 时才计)。 */
function ctxTokensOf(u: Partial<Usage>): number {
  return (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
}

/** driver 构造选项(来自 CLI args / TUI 入口)。 */
export interface DriverOptions extends HostContextArgs {
  /** 测试 / --demo 的 provider override。 */
  providerOverride?: LLMProvider;
}

/**
 * 创建一个 AgentDriver(命令式,非 React;App 在 useMemo 里持有一个实例)。
 * 先 buildHostContext 出初始 context,再按需重建。
 */
export function createAgentDriver(opts: DriverOptions, initial: HostContext): AgentDriver {
  // 进程级可变 rules(§0-B):同一引用传给每一个 CoreAgent,allowAlways 就地 push。
  const rules: PermissionRuleSet = { deny: [], ask: [], allow: [] };
  let mode: PermissionMode = 'default';
  let askUser: AskUserFn | undefined;
  // 008 结构化提问:host 注入的回调。区别于 askUser(布尔闸),AskUserQuestion 工具经
  //   toolContext.askQuestion 取用(agent dispatch 读 this.o.context.toolContext)。
  let askQuestion: AskQuestionFn | undefined;

  // 把「稳定委托」挂到 toolContext.askQuestion:始终读 driver 持有的可变 askQuestion 变量,
  //   故 setAskQuestion 在 render 时晚到也无碍;setModel 重建 toolContext 后须重挂(见下)。
  //   未注入(变量为空)时 resolve([]) —— 工具据空 answers 视作未取到选择,不断流。
  const installAskQuestion = (h: HostContext): void => {
    (h.context.toolContext as { askQuestion?: AskQuestionFn }).askQuestion = (questions, signal) =>
      askQuestion ? askQuestion(questions, signal) : Promise.resolve([]);
  };

  let host = initial;
  installAskQuestion(host);
  let model = opts.model;
  let agent: CoreAgent | null = null;
  /** 回退点 reseed:下一轮 driveTurn 用这份历史播种一次,然后清空。 */
  let pendingHistory: ProviderMessage[] | null = null;

  // ── 回退点状态机:文件侧 manager(落 <cwd>/.forgeax/checkpoints + 会话 checkpoints.jsonl)──
  const checkpoints = new CheckpointManager({
    cwd: process.cwd(),
    sessionId: opts.sessionId ?? 'default',
    sessionsDir: opts.sessionsDir ?? defaultSessionsDir(),
  });
  /** 当前挂起态的「对话侧」快照(messages 由 Repl 持有传入,convo 由 driver 持有)。
   *  boundaryId 串联文件侧 manager.pending();null = 无挂起。 */
  let activeBoundary: { boundaryId: string; preMessages: UiMessage[]; preConvo: ProviderMessage[]; hasCode: boolean } | null = null;
  // ── 会话续接(025):driver 维护对话历史并每轮 thread 给 CoreAgent(它本身不跨 run 持有)。
  //    文本级重建(user 文本 + assistant 文本轮;工具轮从略,与 Repl.toHistory / rewind 同口径)。
  let convo: ProviderMessage[] = [];
  // ── 累计 usage(025 /cost):从 stream assistant 事件逐项累加,跨 setModel 不清零。供 getUsage。
  let usageAcc: Usage = EMPTY_USAGE;
  // ── 当前上下文窗口占用(状态栏 + /context):最近一次请求的 input+cacheCreation+cacheRead
  //   (ctxTokensOf),**非累计**——每次 message_start 刷新成新请求的 prompt 大小(它本身已含全部
  //   历史,跨轮累加会把同段历史数 N 遍)。assistant 收尾按 final usage 校准。这是「窗口满了多少」,
  //   不是计费里程表(后者归 /cost / usageAcc)。
  let ctxPromptTokens = 0;
  // Anthropic 流不发增量 output usage。为让状态栏数字在 output 生成期间也平滑涨,按已流出的
  //   文本/思考/工具入参字符数 ~/4 估算在飞 output,叠加到 ctxPromptTokens 上;message_start 与
  //   assistant 收尾各重置一次,故静默时只剩纯 input+cache(对齐 cc 状态栏的「上下文占用」)。
  let liveOutChars = 0;

  function makeAgent(context: AgentContext, bus: HostContext['bus']): CoreAgent {
    return new CoreAgent({
      context,
      bus,
      globalCacheEnabled: true,
      // CLI/TUI 独立形态自管权限:开 core 内置受保护路径检查,保护本机 .git/.forgeax/shell-rc。
      enableSafetyCheck: true,
      // rules / mode / askUser 经 CoreAgentOptions 喂(派发时实时读,§0-A)。
      rules,
      mode,
      askUser: (perm, use) => (askUser ? askUser(perm, use) : Promise.resolve(false)),
      // team(FORGEAX_TEAM):挂 coordinator inbox 收 peer 的 SendMessage(经既有 inbox 接缝;
      //   非 team → undefined,零变化)。每轮顶部 drain（agent.ts:758），peer 回报作合成 user 轮入上下文。
      ...(host.coordinatorInbox ? { inbox: host.coordinatorInbox } : {}),
      // ★ ISSUE-1:统一走 Compaction V2(替换 legacy makeProviderCompaction)。
      compactionV2: { summarize: makeProviderCompactSummarize(context.provider, context.config.model) },
      microCompact: (msgs: ProviderMessage[]) => microCompact(msgs, { now: Date.now() }),
      contextWindow: contextWindowForModel(context.config.model),
    });
  }

  /** 构造 MCP 巡检入参(无配置 → undefined,命令据此给「未配置」反馈)。与 host-context 同源。 */
  function mcpOpts(): InspectMcpOptions | undefined {
    if (!opts.mcpConfigPath) return undefined;
    return {
      config: JSON.parse(readFileSync(opts.mcpConfigPath, 'utf8')),
      env: process.env,
      deps: { stdioFactory: makeStdioMcpFactory(), tokenProvider: makeEnvTokenProvider(opts.mcpTokenMap) },
    };
  }

  /** 读 hooks 配置(顶层即 settings 或 `{hooks:{...}}` 包裹;与 host-context.readHooksSettings 同口径)。 */
  function readHooksSettings(): Record<string, unknown> | undefined {
    if (!opts.hooksConfigPath) return undefined;
    const j = JSON.parse(readFileSync(opts.hooksConfigPath, 'utf8')) as { hooks?: Record<string, unknown> } & Record<string, unknown>;
    return (j.hooks ?? j) as Record<string, unknown>;
  }

  const driver: AgentDriver = {
    get model() {
      return model;
    },

    get sessionId() {
      return opts.sessionId;
    },

    async driveTurn(prompt: string, onEvent: (e: AgentEvent) => void): Promise<void> {
      // 长活复用:同一进程内复用一个 agent。CoreAgent **不跨 run 持有历史**(每次 run 从
      //   input.history 重建),故续接由 driver 维护的 convo 每轮 thread 进去(§T2 硬化)。
      //   rules 引用不变是前提(§0-B),故复用安全。
      if (!agent) agent = makeAgent(host.context, host.bus);
      // 回退点 reseed 优先于常规 convo:rewind/resume 选中后用重建历史替换本轮历史并对齐 convo。
      // ⚠️ seed = **本轮之前**的历史快照(slice,不能引用 convo 本体——下面要往 convo 追加本轮)。
      //   CoreAgent.run 把 messages 拼成 [..seed(=input.history), {user: 本轮 prompt}],故 seed 不含本轮。
      if (pendingHistory) convo = pendingHistory.slice();
      pendingHistory = null;
      const seed = convo.slice();
      let assistantText = '';
      for await (const ev of agent.run({
        input: { type: 'user', payload: prompt, ts: 0 },
        ...(seed.length ? { history: seed } : {}),
      })) {
        // 累计 usage:stream 透传的 provider assistant 事件带真 usage(types.ts:115)。
        //   ⚠️ 用「逐项相加」而非 mergeUsage——后者语义是同一消息内 input/cache **覆盖**取最新
        //   (防 message_delta 的 0 冲掉真值),用于轮内合并;跨轮/跨请求的计费总额须累加,
        //   每个 provider 请求(每轮、每个工具循环迭代)的 input 都各自计费。
        if (ev.type === 'stream') {
          const sev = ev.event as {
            type?: string;
            usage?: Partial<Usage>;
            delta?: { text?: string; thinking?: string; partial_json?: string };
          };
          // 上下文占用随请求刷新(对齐 cc),计费累计随 assistant 收尾累加(/cost):
          //   - message_start:本请求的 prompt 大小已知(usage 带 input/cache),刷新 ctxPromptTokens
          //     (非累计,取代上一请求值);重置在飞 output 估算。
          //   - content_block_delta:累计已流出字符,供 getContextTokens 的 chars/4 估算平滑涨。
          //   - assistant:本消息收尾——usageAcc 逐项累加(计费);ctxPromptTokens 按 final usage 校准;
          //     重置 output 估算,故静默时状态栏 == 纯 input+cache(cc 的上下文占用口径)。
          if (sev?.type === 'message_start') {
            if (sev.usage) ctxPromptTokens = ctxTokensOf(sev.usage);
            liveOutChars = 0;
          } else if (sev?.type === 'content_block_delta') {
            const d = sev.delta;
            if (d) liveOutChars += (d.text ?? d.thinking ?? d.partial_json ?? '').length;
          } else if (sev?.type === 'assistant' && sev.usage) {
            const u = sev.usage;
            usageAcc = {
              inputTokens: usageAcc.inputTokens + (u.inputTokens ?? 0),
              outputTokens: usageAcc.outputTokens + (u.outputTokens ?? 0),
              cacheCreationInputTokens: usageAcc.cacheCreationInputTokens + (u.cacheCreationInputTokens ?? 0),
              cacheReadInputTokens: usageAcc.cacheReadInputTokens + (u.cacheReadInputTokens ?? 0),
            };
            ctxPromptTokens = ctxTokensOf(u);
            liveOutChars = 0;
          }
        } else if (ev.type === 'assistant') {
          // 收集 assistant 文本轮,turn 结束后并入 convo(供下一轮续接)。
          const content = (ev.message?.payload as { content?: Array<{ type: string; text?: string }> })?.content;
          if (Array.isArray(content)) {
            assistantText += content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('');
          }
        }
        onEvent(ev);
      }
      // turn 收尾:把本轮 user + assistant 文本并入 convo,供下一轮续接(本轮 user 此刻才入,
      //   避免与上面 input.payload 重复)。
      convo.push({ role: 'user', content: prompt });
      if (assistantText) convo.push({ role: 'assistant', content: assistantText });
      // ⚠️ 不在此 await drainAutoMemory:答案流式结束 = turn 在用户眼里就完成了,driveTurn
      //   立即 resolve → 上层 busy 立刻翻 false,不让后台记忆抽取(真模型下又一次数秒 LLM
      //   调用)把 UI 锁在 busy、再延迟触发一次重绘(矮终端/CJK 下易残影)。抽取已由
      //   agent.run 内 fire-and-forget 启动并在跑;落盘由 dispose() 退出前统一 await。
    },

    abort(reason?: string): void {
      agent?.abort(reason);
    },

    toolMeta(name: string): { canonical: string; displayName: string; isReadOnly: boolean; isMcp: boolean } {
      // 在 driver 持有的已装配 tools 上用别名感知匹配解析(host 在 setModel 后重建,
      //   故每次惰性读 host.context.config.tools,不快照)。命中 → canonical=tool.name;
      //   未命中(MCP/plugin/未知)→ 原名回 + isMcp 据 `mcp__` 前缀启发(地基方案 §3梁① / R2)。
      const tool = findTool(host.context.config.tools, name);
      if (!tool) {
        return { canonical: name, displayName: name, isReadOnly: false, isMcp: name.startsWith('mcp__') };
      }
      // displayName:renderToolUseMessage 需 input(toolMeta 仅有名)→ 退而用真名;
      //   isReadOnly 是 (input)=>bool 谓词,无 input 时以空对象探测(fail→false,纯展示元信息)。
      let isReadOnly = false;
      try {
        isReadOnly = tool.isReadOnly({} as never);
      } catch {
        isReadOnly = false;
      }
      return {
        canonical: tool.name,
        displayName: tool.name,
        isReadOnly,
        isMcp: tool.isMcp ?? tool.name.startsWith('mcp__'),
      };
    },

    setModel(id: string): void {
      // 整 context 重建(§0-D):新 provider/Task/compaction/window。旧装配 dispose。
      //   注:同步签名,实际重建异步发生;下一轮 driveTurn 用新 agent。
      const prev = host;
      model = id;
      // 落盘持久化:写 .forgeax/settings.json 的 model 键,下次启动读回。
      //   best-effort、绝不抛——失败也不影响本次切换。
      updateUserSettings({ model: id });
      void buildHostContext({ ...toHostArgs(opts, id) }, opts.providerOverride).then(async (next) => {
        host = next;
        installAskQuestion(host); // 新 toolContext 须重挂提问接缝(否则切模型后 AskUserQuestion 失联)
        agent = null; // 下一轮 driveTurn 用新 context 重建
        // dispose 旧装配的子进程(mcp/plugin/hooks)。
        for (const d of prev.disposers) {
          try {
            await d();
          } catch {
            /* ignore */
          }
        }
      });
    },

    setAskUser(fn: AskUserFn): void {
      askUser = fn;
    },

    setAskQuestion(fn: AskQuestionFn): void {
      askQuestion = fn;
    },

    allowAlways(toolName: string): void {
      // 就地 push(§0-B):同一 rules 引用,下一次派发引擎 ⑦ 判 allow。整工具规则
      //   (content===undefined)匹配该工具全部输入。
      rules.allow.push({ toolName, behavior: 'allow', source: 'tui-allow-always' });
    },

    setMode(m: PermissionMode): void {
      mode = m;
      // 已在飞的 agent 也即时切(下一轮 dispatch 读 currentMode);新 agent 经 makeAgent 喂初值。
      agent?.setMode(m);
    },

    // ── 命令补齐批次(025)能力实现 ──────────────────────────────────────────────
    getUsage() {
      // 会话累计计费(/cost):纯 usageAcc(逐 assistant 收尾累加,各 token 类型分项,各按单价计)。
      return summarizeUsage(usageAcc, model);
    },

    getContextStats() {
      // 当前上下文占用(/context):最近一次请求的 input+cacheCreation+cacheRead;无则 convo 估算兜底。
      return contextStats(ctxPromptTokens > 0 ? ctxPromptTokens : convo, model);
    },

    getContextTokens() {
      // 状态栏数字:当前上下文窗口占用 + 在飞 output 估算(chars/4)。静默时估算为 0 → 纯 input+cache,
      //   与 getContextStats / cc 状态栏同口径;生成期间叠加估算让数字平滑涨(随流实时)。
      return ctxPromptTokens + Math.ceil(liveOutChars / 4);
    },

    async listMcp() {
      const o = mcpOpts();
      if (!o) return { servers: [], configErrors: [] };
      return inspectMcpServers(o);
    },

    getPermissionRules() {
      return getPermissionRules(rules, mode);
    },

    listSessions() {
      return listSessions(opts.sessionsDir);
    },

    async resume(id: string): Promise<boolean> {
      const hist = await foldSessionById(id, opts.sessionsDir);
      if (!hist || !hist.length) return false;
      convo = hist.slice();
      agent = null;
      pendingHistory = hist.slice();
      return true;
    },

    async resumeSession(id: string): Promise<UiMessage[] | null> {
      // 单次读全量 WAL → 双投影:① foldFromStore 重建 LLM 历史(reseed 下一轮,与 resume 同口径);
      //   ② walEventsToUiMessages 重建可渲染 transcript(供 Repl 回灌、替换当前会话)。
      const events = await readSessionEvents(id, opts.sessionsDir);
      if (!events.length) return null; // 无此会话 / 空 WAL
      const hist = foldFromStore(events);
      if (hist.length) {
        convo = hist.slice();
        pendingHistory = hist.slice();
        agent = null; // 下一轮 driveTurn 用恢复历史 reseed
      }
      return walEventsToUiMessages(events);
    },

    listAgents() {
      const disk = loadAgentDefs([resolvePath(process.cwd(), '.forgeax/agents')]);
      return inspectAgents({ builtins: builtinSubagents, disk, allTools: host.context.config.tools });
    },

    listMemory() {
      const fs = host.context.toolContext.sandboxFs as SandboxFs;
      const dir = opts.memoryDir ?? resolvePath(process.cwd(), '.forgeax/memory');
      return listMemory(fs, dir);
    },

    listSkills() {
      // 用生效目录(给了 --skills 只用 flag,否则自动发现项目级+用户级),与装配口径一致。
      return listSkills(effectiveSkillDirs(opts.skillDirs));
    },

    listPlugins() {
      return listPlugins((opts.pluginDirs ?? []).map((d) => ({ source: 'session' as const, dir: d })));
    },

    listHooks() {
      return listHooks({ settings: readHooksSettings() as never });
    },

    getStatus() {
      return getStatus({
        model,
        cwd: String(host.context.toolContext.cwd ?? process.cwd()),
        sessionId: opts.sessionId,
        permissionMode: mode,
        usage: usageAcc,
      });
    },

    async runDoctor() {
      return runDoctor({ provider: { provider: host.provider, model }, mcp: mcpOpts() });
    },

    async triggerCompact(instructions?: string): Promise<{ compacted: boolean; usedLLM: boolean }> {
      // 自定义指令透传待 makeProviderCompactSummarize 支持(014 A 层 note);本期先做基础压缩。
      void instructions;
      const history = convo;
      if (!history.length) return { compacted: false, usedLLM: false };
      try {
        const marks = computeWatermarksFromModel(lookupModelContext(model));
        const summarize = makeProviderCompactSummarize(host.provider, model);
        const res = await runManualCompact({ history, marks, summarize, now: Date.now() });
        const count = res.coveredTo - res.coveredFrom + 1;
        if (count > 0) {
          convo = [...history.slice(0, res.coveredFrom), res.replacement, ...history.slice(res.coveredTo + 1)];
          agent = null; // 下一轮用压缩后历史 reseed
          pendingHistory = convo.slice();
        }
        return { compacted: count > 0, usedLLM: res.usedLLM };
      } catch {
        // 历史不足以压缩(管线 throw "Not enough messages")→ 视作未压缩。
        return { compacted: false, usedLLM: false };
      }
    },

    async runInit(force?: boolean) {
      return runInitProject({
        provider: host.provider,
        model,
        tools: host.context.config.tools,
        toolContext: host.context.toolContext,
        force,
      });
    },

    rewindHistory(history: ProviderMessage[]): void {
      // 重置 agent(清掉 stateful 内部历史)+ 暂存重建历史;下一轮 driveTurn 播种一次。
      agent = null;
      pendingHistory = history.length ? history : null;
    },

    clearHistory(): void {
      // /clear:把 driver 持有的 LLM 历史真正清空——convo 是下一轮 driveTurn 的 seed 源,
      //   不清它则 session.clear() 只抹了显示、provider 仍收到全部旧历史(bug 根因)。
      //   对齐 resume/rewind 的 reseed 套路:清 convo + 撤挂起 + 重置 agent。
      convo = [];
      pendingHistory = null;
      agent = null;
      // 上下文占用归零(/context + 状态栏据此显示空窗口);usageAcc 是会话累计计费,跨 /clear 保留。
      ctxPromptTokens = 0;
      liveOutChars = 0;
    },

    // ── 回退点 · 文件 + 对话双回退状态机 ──
    checkpointTurn(): string | null {
      const msgId = randomUUID();
      try {
        checkpoints.snapshotForMessage(msgId); // 内部 fail-soft,不抛
      } catch {
        return null;
      }
      return msgId;
    },

    listCheckpoints() {
      return checkpoints.list();
    },

    pendingRewind(): PendingRewindView | null {
      if (!activeBoundary) return null;
      const fp = checkpoints.pending();
      return {
        boundaryId: activeBoundary.boundaryId,
        keptDirty: fp?.keptDirty ?? [],
        hasOverwrite: !!fp?.overwrite,
        hasCode: activeBoundary.hasCode,
      };
    },

    previewRewind(msgId: string): DiffStats | null {
      const r = checkpoints.preview(msgId);
      return 'error' in r ? null : r;
    },

    async rewind(input): Promise<RewindOutcome> {
      // 回退前先打断在飞轮(对齐 cc),给事件一拍 flush。
      try {
        agent?.abort('rewind');
      } catch {
        /* ignore */
      }
      let filesChanged: string[] = [];
      let keptDirty: string[] = [];
      let boundaryId: string = randomUUID();
      // 文件侧:仅当该锚点有快照。
      if (input.hasCode) {
        const r = await checkpoints.rewind(input.msgId);
        if ('error' in r) return { error: r.error };
        filesChanged = r.filesChanged;
        keptDirty = r.keptDirty;
        boundaryId = r.boundaryId;
      }
      // 对话侧:存 pre 快照(messages 由 Repl 传入,convo driver 持有)→ reseed 到目标。
      activeBoundary = {
        boundaryId,
        preMessages: input.currentMessages.slice(),
        preConvo: convo.slice(),
        hasCode: input.hasCode,
      };
      agent = null;
      pendingHistory = input.targetHistory.length ? input.targetHistory.slice() : null;
      return { boundaryId, filesChanged, keptDirty };
    },

    async cancelRewind() {
      if (!activeBoundary) return { error: 'no pending rewind' };
      const b = activeBoundary;
      let keptDirty: string[] = [];
      if (b.hasCode) {
        const r = await checkpoints.cancel(b.boundaryId);
        if ('error' in r) return { error: r.error };
        keptDirty = r.keptDirty;
      }
      // 还原对话:convo 复位 + 下一轮重播种。
      agent = null;
      convo = b.preConvo.slice();
      pendingHistory = b.preConvo.length ? b.preConvo.slice() : null;
      const messages = b.preMessages.slice();
      activeBoundary = null;
      return { messages, keptDirty };
    },

    async overwriteDirty() {
      if (!activeBoundary?.hasCode) return { error: 'no file rewind in effect' };
      return checkpoints.overwriteDirty(activeBoundary.boundaryId);
    },

    async undoOverwrite() {
      if (!activeBoundary?.hasCode) return { error: 'no overwrite to undo' };
      return checkpoints.undoOverwrite(activeBoundary.boundaryId);
    },

    finalizeRewind(): void {
      if (!activeBoundary) return;
      if (activeBoundary.hasCode) checkpoints.finalizePending();
      activeBoundary = null;
    },

    async dispose(): Promise<void> {
      // 退出前等最近一轮的 auto-memory 抽取落盘(driveTurn 已不再行内 await,见上)。
      try {
        await agent?.drainAutoMemory();
      } catch {
        /* ignore */
      }
      for (const d of host.disposers) {
        try {
          await d();
        } catch {
          /* ignore */
        }
      }
    },
  };
  return driver;
}

/** DriverOptions(+ 覆盖 model)→ HostContextArgs。 */
function toHostArgs(opts: DriverOptions, model: string): HostContextArgs {
  return {
    model,
    demo: opts.demo,
    memoryDir: opts.memoryDir,
    skillDirs: opts.skillDirs,
    commandDirs: opts.commandDirs,
    mcpConfigPath: opts.mcpConfigPath,
    pluginDirs: opts.pluginDirs,
    hooksConfigPath: opts.hooksConfigPath,
    searchUrl: opts.searchUrl,
    sessionId: opts.sessionId,
    sessionsDir: opts.sessionsDir,
  };
}

/** driver 经 Context 暴露给屏幕(useAgent)。App 在树顶注入唯一实例。 */
const AgentContext = createContext<AgentDriver | null>(null);

export function AgentProvider(props: { driver: AgentDriver; children: React.ReactNode }): React.ReactElement {
  return <AgentContext.Provider value={props.driver}>{props.children}</AgentContext.Provider>;
}

export function useAgent(): AgentDriver {
  const v = useContext(AgentContext);
  if (!v) throw new Error('useAgent must be used within <AgentProvider>');
  return v;
}
