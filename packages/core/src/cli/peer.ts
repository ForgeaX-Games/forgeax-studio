/**
 * peer —— forgeax-core `--serve` 进程内 peer 多 agent 的子 agent spawn 工厂。
 *
 * 归属(R3 内核归一):从 agent-host/agent-assembly 搬进 core。子 agent 在 **serve 子进程内**
 * spawn(同一 runtime),其工具集 = 父的 host 工具(经同一 executeTool 反向桥回宿主,信任闸
 * 在宿主复跑),**不含 Task/Handoff**(防递归)。配 `InProcessScheduler` 用。
 *
 * ★ M2 team 接线(plan-strategy D-2 / 任务 m2-t6):注入 `InProcessTeammateExecutor` 后,
 *   子 agent 不再各持隔离 `new EventBus()` —— 改用 **team 共享 bus**(SendMessage 旁路
 *   observability publish 经它,team 成员同信道),且每个子 agent 拿到一个 **inbox 闭包**
 *   (`buildInboxClosure`,从 executor.mailbox drain 投给自己的消息)。
 *
 *   ★★ AC-08 关键证据:inbox 注入闭包**在本 host 文件构造并挂到 `CoreAgentOptions.inbox`**
 *      (agent.ts:170 既有接缝),**不改 agent.ts 的 queryLoop**——数据面复用 agent.ts:758
 *      既有 drain,控制面在闭包内分流(经 inbox-router),两者都不碰 loop。
 *
 * Boundary: 仅 core 相对 import(CoreAgent/EventBus/types + inject executor + team router)。
 */
import { CoreAgent } from '../agent/agent';
import { EventBus } from '../events/event-bus';
import type { AgentContext } from '../agent/types';
import type { AgentTool } from '../capability/types';
import type { LLMProvider } from '../provider/types';
import type { CoreEvent, EventBusAPI } from '../events/types';
import type { AgentSpec } from '../inject/types';
import type { SpawnFn, SpawnedAgent, SpawnContext } from '../inject/in-process-scheduler';
import type { InProcessTeammateExecutor } from '../inject/in-process-teammate-executor';
import { buildInboxClosure, type ControlPlaneHandlers } from '../agent/team/inbox-router';
import { taskBoardToolsPack, type TeamBoardStore } from '../agent/team/task-board-tools';
import { sendMessageTool } from '../capability/builtin-tools/message-tools';
import type { PeerSpawnResult } from '../capability/builtin-tools/team-spawn-tool';

/** team 接线束(可选):注入则子 agent 走共享 bus + executor mailbox inbox 闭包。 */
export interface TeamWiring {
  /** team 共享投递后端(per-team 一个;每个子 agent 经它 register + 收 mailbox)。 */
  executor: InProcessTeammateExecutor;
  /** team 共享 EventBus(替代每子隔离 bus;SendMessage observability publish 同信道)。 */
  bus: EventBusAPI;
  /** 控制面 handler(idle_notification 等回 leader);缺省 → 控制面 best-effort 丢弃。 */
  controlHandlers?: ControlPlaneHandlers;
}

/**
 * 构造子 agent spawn 工厂:用给定 provider + 工具起一个子 `CoreAgent`,产出其 bus
 * `CoreEvent` 流(供 `InProcessScheduler` 收集成 `child_result`)。
 *
 * 无 `team` 注入(退化形态):子用**隔离 EventBus**(上下文 / transcript 不进父),
 * 行为与 team 前一致(§9 Graceful Degradation)。
 *
 * 有 `team` 注入(M2 team 形态):子在 executor.roster 登记可寻址、拿 inbox 闭包
 * (从 executor.mailbox drain 投给自己的 TeamMessage,数据面进 LLM / 控制面进 handler),
 * **inbox 闭包在此构造并挂到 CoreAgentOptions.inbox(不改 agent.ts)**。
 */
export function buildChildSpawnFn(
  provider: LLMProvider,
  tools: AgentTool[],
  model: string,
  maxTurns = 20,
  team?: TeamWiring,
): SpawnFn {
  return (spec: AgentSpec, ctx: SpawnContext): SpawnedAgent => {
    const agentId = `${spec.type}:${ctx.parentId ?? 'root'}`;
    // team 形态:共享 bus + 登记可寻址成员;退化形态:隔离 bus。
    const bus = team ? (team.bus as EventBus) : new EventBus();
    if (team) team.executor.register(agentId);
    const requirement = spec.requirement ?? '';
    const context: AgentContext = {
      agentId,
      provider,
      config: {
        systemPromptSlots: [],
        leadingSystemText: requirement
          ? `You are a ${spec.type} subagent. ${requirement}`
          : `You are a ${spec.type} subagent. Do the task and report concisely.`,
        model,
        tools,
        maxTurns,
      },
      toolContext: {},
    };
    // ★ AC-08:inbox 注入闭包**在 host 侧(本文件)**构造,挂到 CoreAgentOptions.inbox
    //   (agent.ts:170 既有接缝,agent.ts:758 既有 drain)。**不改 agent.ts queryLoop**。
    const inbox = team
      ? buildInboxClosure({ self: agentId, mailbox: team.executor.mailbox, ...team.controlHandlers })
      : undefined;
    const child = new CoreAgent({ context, bus, ...(inbox ? { inbox } : {}) });
    return {
      agentId,
      async *run(signal: AbortSignal): AsyncIterable<CoreEvent> {
        const collected: CoreEvent[] = [];
        // 只收本子 agent 自己 publish 的事件(共享 bus 下按 source 过滤,避免串台)。
        const unsub = bus.subscribe('*', (e) => {
          if (!team || e.source === agentId) collected.push(e);
        });
        try {
          // 驱动子 loop 跑到 done;bus 同步 publish 的 CoreEvent 在此期间被收集。
          for await (const _ev of child.run({
            input: { type: 'user', payload: requirement, ts: 0 },
            signal,
          })) {
            void _ev;
          }
        } finally {
          unsub();
        }
        for (const e of collected) yield e;
      },
    };
  };
}

// ─── team_spawn 的 peer 兑现器(HOST 层;capability 的 team-spawn-tool 经注入调用)───
//
// 设计 §13:coordinator 经 `team_spawn` 工具显式组队。把「真起一个 peer CoreAgent」放在
// HOST 层(本文件已 import CoreAgent),capability/team-spawn-tool.ts 只持 `spawnPeer` 注入
// 函数(不 import CoreAgent,守 capability→agent 边界)。
//
// peer 形态(coordinator-view,无 OOS-3):
//   - 工具集 = team 任务表工具(task_create/list/get/update + claim)+ SendMessage(parentId=coordinator,
//     缺省 to 路由回 coordinator),**剥 Task / team_spawn**(防递归 + 只 coordinator 组队,§13.1#8);
//   - toolContext.teamBoard = 共享 board(task 工具据此原子 claim);ctx.agentId = peer 名(claim by);
//   - inbox 闭包从 executor.mailbox drain 投给自己的消息(数据面进 LLM / 控制面进 handler),挂
//     CoreAgentOptions.inbox(agent.ts:170 既有接缝,**不改 agent.ts**);
//   - 共享 team bus(SendMessage observability publish 同信道);
//   - 自驱「认领-循环」:brief 指示其 task_list→claim→做→标 done→SendMessage coordinator→重复至板空。
// 跑到 done 即返回终态(coordinator 经 team_spawn 结果 + 其 inbox 收到的 SendMessage 双路看结果)。

export interface TeamPeerSpawnerDeps {
  provider: LLMProvider;
  model: string;
  executor: InProcessTeammateExecutor;
  /** team 共享 bus(peer 间同信道)。 */
  bus: EventBusAPI;
  board: TeamBoardStore;
  /** coordinator 成员名(peer 的 SendMessage 默认回投目标 + 在册 coordinator)。 */
  coordinatorId: string;
  /** peer 兜底回合上限(自驱认领-循环;默认 30)。 */
  maxTurns?: number;
}

/**
 * 造一个 `spawnPeer(name, brief, signal)` 闭包,注入给 capability 的 `teamSpawnTool`。
 * 每次调用真起一个 peer CoreAgent、登记 roster、跑其 brief 到 done,产出终态。
 */
export function makeTeamPeerSpawner(
  deps: TeamPeerSpawnerDeps,
): (name: string, brief: string, signal?: AbortSignal) => Promise<PeerSpawnResult> {
  return async (name, brief, signal) => {
    deps.executor.register(name);
    const peerTools: AgentTool[] = [
      ...(taskBoardToolsPack().tools ?? []),
      // peer 缺省 to → 回 coordinator(parentId);'coordinator' 也解析到它。绝不默认广播。
      sendMessageTool({ executor: deps.executor, coordinatorId: deps.coordinatorId, parentId: deps.coordinatorId }),
    ];
    const leading =
      `You are team member "${name}". ${brief}\n` +
      `Workflow: call task_list to see the shared board (each task has a description of what to do); ` +
      `task_update {id, action:"claim"} to atomically take an open task ` +
      `(if it returns claim_conflict/agent_busy/blocked, pick another or wait); do the task per its description; ` +
      `task_update {id, status:"done"} to finish; then SendMessage {to:"coordinator", text:"<short report>"}. ` +
      `Repeat until no open tasks remain, then stop.`;
    const context: AgentContext = {
      agentId: name,
      provider: deps.provider,
      config: {
        systemPromptSlots: [],
        leadingSystemText: leading,
        model: deps.model,
        tools: peerTools,
        maxTurns: deps.maxTurns ?? 30,
      },
      // ctx.agentId 是 claim 的 owner 主键(task_update action:'claim' 据此判 owner/busy)。
      //   loop 不把 context.agentId 注进 tool ctx(dispatch 只 spread toolContext),故显式放这里。
      toolContext: { teamBoard: deps.board, agentId: name },
    };
    const inbox = buildInboxClosure({ self: name, mailbox: deps.executor.mailbox });
    const child = new CoreAgent({ context, bus: deps.bus as EventBus, inbox });
    let reason = 'completed';
    try {
      for await (const ev of child.run({ input: { type: 'user', payload: brief, ts: 0 }, ...(signal ? { signal } : {}) })) {
        if ((ev as { type?: string }).type === 'done') {
          reason = (ev as { terminal?: { reason?: string } }).terminal?.reason ?? reason;
        }
      }
    } catch (e) {
      return { name, ok: false, reason: e instanceof Error ? e.message : String(e) };
    } finally {
      deps.executor.terminate(name);
    }
    return { name, ok: true, reason };
  };
}
