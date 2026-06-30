/**
 * InProcessTeammateExecutor —— `TeammateExecutor` 契约的进程内(in-process)兑现后端。
 *
 * 它是 host 把一个 spawn intent 真正兑现成「常驻 teammate」的接缝实现(对照 cc
 * `backends/types.ts` 五法:spawn / sendMessage / terminate / kill / isActive),配
 * `InProcessScheduler`(HandoffSink)用——scheduler 决定「何时跑」,executor 负责
 * 「带外操控 + 投递」。两者是正交的两条接缝,不互相替代(详见 inject/types.ts §4.2bis)。
 *
 * ★ mailbox「一信道两平面」(设计 §13.1#3):一块 per-agent 队列同时承载两个平面,
 *   靠 `TeamMessage.kind` 判别——数据面 `text` / 控制面其余 7 种。executor 只管**投递**;
 *   **分流**由消费侧(`agent/team/inbox-router.ts` 的 inbox 闭包)按 kind 做,executor 不分。
 *
 * ★ 纯度(设计 §架构级 C「时间/ID」):进程内 mailbox 保持纯 —— 单调 id(对照
 *   `agent/background.ts:72` 的 `++counter`),**不调 `Date.now()`**。文件锁 / 时间戳只在
 *   host 后端(server-WS,二期 P6),不在本进程内 MVP。
 *
 * ★ 本轮范围(plan-strategy D-6 / 任务 m2-t3):只交付 in-process 后端;server-WS 仅预留
 *   接缝不实现。成员级 abort 终止逻辑归 P3(OOS-1):terminate/kill 在本 MVP 下只把成员
 *   从在册表摘除(停止其后续可寻址 / 投递),不实现「打断正在跑的回合」——那需 scheduler
 *   侧 controller.abort,归 P3。
 *
 * Boundary: 仅 core 相对 type-only import(inject 类型);无 zod、无 host 包。
 */
import type { AgentSpec, TeammateExecutor, TeammateHandle } from './types';
import type { TeamMessage } from '../agent/team/team-message';

/**
 * 进程内 per-agent mailbox —— 一块按 agentId 分桶的队列。两平面共用一桶,
 * 消费侧按 `kind` 分流(数据面进 LLM / 控制面进 handler)。
 *
 * deliver/drain/pending 三法即全部语义:
 *   - `deliver(to, msg)`:把一条 TeamMessage 入 `to` 的队列(投递)。
 *   - `drain(to)`:取出并清空 `to` 的全部待收消息(消费即清,幂等——再 drain 为空)。
 *   - `pending(to)`:peek `to` 队列长度(状态面 / 测试内省,不消费)。
 */
export class Mailbox {
  /** agentId → 待收 TeamMessage 队列(FIFO)。 */
  private readonly queues = new Map<string, TeamMessage[]>();

  /** 投递一条消息到 `to` 的队列尾(两平面同桶)。 */
  deliver(to: string, msg: TeamMessage): void {
    const q = this.queues.get(to);
    if (q) q.push(msg);
    else this.queues.set(to, [msg]);
  }

  /** 取出并清空 `to` 的全部待收消息;无则空数组(幂等:再 drain 为空)。 */
  drain(to: string): TeamMessage[] {
    const q = this.queues.get(to);
    if (!q || q.length === 0) return [];
    this.queues.set(to, []);
    return q;
  }

  /** peek `to` 队列长度(不消费)。 */
  pending(to: string): number {
    return this.queues.get(to)?.length ?? 0;
  }

  /** 摘除一个成员的整条队列(terminate/kill 时清其残留待收)。 */
  forget(agentId: string): void {
    this.queues.delete(agentId);
  }
}

/**
 * 进程内 `TeammateExecutor`。一个实例服务一个 team:持一块共享 `Mailbox` + 在册成员表。
 * host 经 `CoreInjection.teammateExecutor` 注入它;router 的真投递口落到 `sendMessage`。
 */
export class InProcessTeammateExecutor implements TeammateExecutor {
  /** 共享 mailbox(两平面同桶;host 据此为每个成员构造 inbox 闭包)。 */
  readonly mailbox = new Mailbox();

  /** 在册成员表(agentId → handle);isActive / 投递前判定据此。 */
  private readonly roster = new Map<string, TeammateHandle>();

  /** 单调 id 计数器(对照 background.ts:72,纯——不依赖 Date.now)。 */
  private counter = 0;

  /**
   * 把一个 AgentSpec 兑现成常驻 teammate,登记进 roster,返回带外寻址句柄。
   * agentId 由 `spec.type` + 单调序号派生(纯;同 spec 多次 spawn 得不同 id)。
   */
  async spawn(spec: AgentSpec): Promise<TeammateHandle> {
    const agentId = `${spec.type}#${++this.counter}`;
    const handle: TeammateHandle = { agentId, backend: 'in-process' };
    this.roster.set(agentId, handle);
    return handle;
  }

  /**
   * 显式按名登记一个可寻址成员(host 在用稳定成员名而非 spawn 派生 id 时用,
   * 对照 §13.1#7 `to=name`)。幂等:重复登记同名不报错。
   */
  register(agentId: string, backend = 'in-process'): TeammateHandle {
    const existing = this.roster.get(agentId);
    if (existing) return existing;
    const handle: TeammateHandle = { agentId, backend };
    this.roster.set(agentId, handle);
    return handle;
  }

  /**
   * 带外投递一条 TeamMessage 到 `to` 的 mailbox(不经模型 loop;router 真投递的兑现口)。
   * `to` 不在册 → 不抛(graceful);消息仍入桶但无人会 drain(SendMessage 工具层据
   * `isActive` 先判,返回 delivered:false)。
   */
  async sendMessage(to: string, msg: TeamMessage): Promise<void> {
    this.mailbox.deliver(to, msg);
  }

  /** 优雅终止:从 roster 摘除 + 清其 mailbox 残留(本 MVP 不打断在跑回合,归 P3)。 */
  async terminate(agentId: string): Promise<void> {
    this.roster.delete(agentId);
    this.mailbox.forget(agentId);
  }

  /** 强制杀死:进程内 MVP 下与 terminate 同形(不等收尾的差异在 scheduler 侧,归 P3)。 */
  async kill(agentId: string): Promise<void> {
    this.roster.delete(agentId);
    this.mailbox.forget(agentId);
  }

  /** 该成员当前是否在册(投递前判定 / 状态面)。 */
  isActive(agentId: string): boolean {
    return this.roster.has(agentId);
  }

  /** 当前在册成员 id 列表(测试 / 内省 / 后续 ListPeers 用)。 */
  listMembers(): string[] {
    return [...this.roster.keys()];
  }
}
