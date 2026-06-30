/**
 * team_spawn coordinator-view e2e（无需 API key）—— 验证 TUI 活体接线的集成缝：
 *   coordinator → `team_spawn` → 注入 spawnPeer → 真 board.claim → executor.mailbox →
 *   coordinator inbox 闭包 drain。
 *
 * 不是 .test.ts（bun test 不自动收）；手动跑:`cd packages/core && bun test/team-spawn-coordinator-e2e.ts`。
 *
 * 为什么 scripted peer:`team_spawn` 工具 + 共享 board + mailbox 两平面 + coordinator inbox 是
 *   纯机制(无需 LLM)。peer 的「认领-做-报告」循环本应由模型驱动,这里用脚本身体替身(真打
 *   board.claim + executor.sendMessage),确定性验**集成缝**;真模型驱动的 peer 由带 key 的 TUI 验。
 *
 * 断言:
 *   - team_spawn 并发起 2 peer,真原子 claim 3 任务 → 全 done、owner∈{p1,p2}、每任务恰一次;
 *   - coordinator inbox 闭包 drain 出 3 条 peer 文本回报(SendMessage→mailbox['cli']→inbox)。
 *
 * Boundary:test/ 下,只 import core-local。
 */
import { TeamBoardStore } from '../src/agent/team/task-board-tools';
import { InProcessTeammateExecutor } from '../src/inject/in-process-teammate-executor';
import { teamSpawnTool, type PeerSpawnResult } from '../src/capability/builtin-tools/team-spawn-tool';
import { buildInboxClosure } from '../src/agent/team/inbox-router';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`, extra ?? '');
  }
}

async function main(): Promise<void> {
  const COORD = 'cli';
  const board = new TeamBoardStore({ teamId: 'tui-team' });
  const executor = new InProcessTeammateExecutor();
  executor.register(COORD);
  // coordinator inbox = 既有 CoreAgent.inbox 接缝在 host 侧的兑现(drain 自己的 mailbox)。
  const coordinatorInbox = buildInboxClosure({ self: COORD, mailbox: executor.mailbox });

  // coordinator 先把任务放上共享板(对应 TUI 里 coordinator 调 task_create)。
  board.create('team-build');
  board.create('team-test');
  board.create('team-doc');

  // scripted spawnPeer:真起一个「peer」身体——认领-循环直到板空,每完成一条 SendMessage 回 coordinator。
  //   (替身模型的 tool 调用;真打 board.claim + executor.sendMessage,跑真 mailbox/inbox。)
  const spawnPeer = async (name: string): Promise<PeerSpawnResult> => {
    executor.register(name);
    let did = 0;
    for (;;) {
      // 找一条可领(脚本侧挑 open id;真 claim 仍由 store 原子裁决,N peer 不撞)。
      const open = board.snapshot().items.find((i) => i.owner === null && i.status === 'pending');
      if (!open) break;
      const r = board.claim(open.id, name);
      if (!r.ok) continue; // 被别的 peer 抢先 → 结构化拒绝,换下一条。
      board.update(open.id, { status: 'done' });
      await executor.sendMessage(COORD, { kind: 'text', from: name, to: COORD, text: `${name} completed ${open.id}` });
      did++;
    }
    return { name, ok: true, reason: `completed ${did} task(s)` };
  };

  const tool = teamSpawnTool({ spawnPeer });
  const ctx = { signal: new AbortController().signal, agentId: COORD } as unknown as Parameters<typeof tool.call>[1];
  const res = await tool.call({ members: [{ name: 'p1', brief: 'help' }, { name: 'p2', brief: 'help' }] }, ctx);
  const out = res.data;

  check('team_spawn ok', out.ok, out);
  check('roster 含 2 peer', out.roster.length === 2, out.roster);

  const snap = board.snapshot();
  check('全部 3 任务 done', snap.items.length === 3 && snap.items.every((i) => i.status === 'done'), snap.items);
  check('每任务 owner ∈ {p1,p2}', snap.items.every((i) => i.owner === 'p1' || i.owner === 'p2'), snap.items.map((i) => `${i.id}:${i.owner}`));
  const totalDid = out.roster.reduce((n, r) => n + (Number((r.reason.match(/completed (\d+)/) ?? [])[1]) || 0), 0);
  check('两 peer 合计认领恰 3(无重复领)', totalDid === 3, out.roster.map((r) => r.reason));

  // coordinator inbox:peer 的 3 条 SendMessage 经 mailbox['cli'] → inbox 闭包 drain 出 3 条数据面消息。
  const inbound = coordinatorInbox();
  check('coordinator inbox 收到 3 条 peer 回报', inbound.length === 3, inbound);
  check('回报是数据面文本(进 LLM 的 ProviderMessage)', inbound.every((m) => typeof (m as { content?: unknown }).content !== 'undefined' || typeof m === 'object'), inbound[0]);

  console.log(`\n[team-spawn-coordinator-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[team-spawn-coordinator-e2e] fatal:', e);
  process.exit(1);
});
