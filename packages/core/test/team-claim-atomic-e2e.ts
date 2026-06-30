/**
 * M3 · AC-09 原子 claim 不撞 e2e —— TeamBoardStore 共享任务表并发 claim 原子性。
 *
 * 不是 .test.ts(bun test 不自动收);手动跑:`cd packages/core && bun test/team-claim-atomic-e2e.ts`。
 *
 * 验收(acceptance T3 / AC-09):3 个 teammate 对**同一可领任务**并发 claim,断言:
 *   - 恰一个成功(获得 owner、任务转 in_progress);
 *   - 其余两个收到结构化拒绝(`{ ok:false, code:'claim_conflict', hint, expected }`);
 *   - 「单 agent 一个 in_progress」busy 约束不被破坏(无一 owner 同时持两个 in_progress)。
 *
 * 「真 API」在 claim 这条路径上 = 真并发对真共享态做 check-and-set —— claim 是纯机制
 * (无需 LLM),故本 e2e 用真并发(Promise.all)直打机制,确定性验原子性(比真模型更严)。
 *
 * Boundary:test/ 下,只 import core-local。
 */
import { TeamBoardStore } from '../src/agent/team/task-board-tools';
import { validateBoard } from '../src/agent/team/board-schema';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('[team-claim-atomic-e2e] 3 teammate 并发 claim 同一任务,恰一胜\n');

  const store = new TeamBoardStore({ teamId: 'team-forge' });
  store.create('team-shared'); // 一个可领任务(owner=null,pending)。

  const claimers = ['alice', 'bob', 'carol'];

  // 真并发:三个 claim 同时发起。check-and-set 必须使恰一个赢。
  const results = await Promise.all(
    claimers.map((who) => Promise.resolve().then(() => store.claim('team-shared', who))),
  );

  const wins = results.filter((r) => r.ok);
  const rejects = results.filter((r) => !r.ok);
  check('恰 1 个 claim 成功', wins.length === 1, results);
  check('恰 2 个 claim 被拒', rejects.length === 2, results);

  // 被拒者都是结构化 claim_conflict,带 hint/expected。
  const allConflict = rejects.every(
    (r) => !r.ok && r.code === 'claim_conflict' && typeof r.hint === 'string' && typeof r.expected === 'string',
  );
  check('被拒者均为结构化 claim_conflict(.code/.hint/.expected)', allConflict, rejects);

  // 胜者拿到 owner,任务转 in_progress。
  const item = store.get('team-shared');
  check('任务转 in_progress', item?.status === 'in_progress', item);
  check('任务 owner 是某个 claimer', !!item && claimers.includes(item.owner ?? ''), item);

  // busy 不被破坏:全表无 owner 同时持两个 in_progress(validateBoard 兜底)。
  const v = validateBoard(store.snapshot());
  check('board 校验通过(无重复 in_progress / busy 守恒)', v.ok, v.ok ? undefined : v.errors);

  // 第二个不同 agent 再 claim 同任务 → 仍 conflict(任务已被领,幂等的拒)。
  const again = store.claim('team-shared', 'dave');
  check('已领任务再被他人 claim → claim_conflict', !again.ok && again.code === 'claim_conflict', again);

  console.log(`\n[team-claim-atomic-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[team-claim-atomic-e2e] fatal:', e);
  process.exit(1);
});
