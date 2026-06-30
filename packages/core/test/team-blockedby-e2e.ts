/**
 * M3 · AC-10 blockedBy 阻塞闸 e2e —— TeamBoardStore claim 受依赖完成度把闸。
 *
 * 不是 .test.ts;手动跑:`cd packages/core && bun test/team-blockedby-e2e.ts`。
 *
 * 验收(acceptance / AC-10):任务 X blockedBy:[Y],
 *   - Y 未完成时 claim X → 被结构化拒绝(code:'blocked'),拒绝里**含阻塞源任务 id Y**;
 *   - Y 完成(done)后 claim X → 成功(X 转 in_progress、得 owner)。
 *
 * blockedBy 闸是纯机制(无需 LLM),本 e2e 直打机制确定性验依赖闸。
 *
 * Boundary:test/ 下,只 import core-local。
 */
import { TeamBoardStore } from '../src/agent/team/task-board-tools';

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
  console.log('[team-blockedby-e2e] X blockedBy [Y]:Y 未完阻塞、Y 完成放行\n');

  const store = new TeamBoardStore({ teamId: 'team-forge' });
  store.create('team-y');
  store.create('team-x', { blockedBy: ['team-y'] });

  // ── Y 未完成 → claim X 被拒,拒绝含 Y 的 id ──────────────────────────────────
  const blocked = store.claim('team-x', 'alice');
  check('Y 未完成时 claim X 被拒', !blocked.ok, blocked);
  check('拒绝 code=blocked', !blocked.ok && blocked.code === 'blocked', blocked);
  check(
    '拒绝含阻塞源任务 id team-y',
    !blocked.ok && `${blocked.hint} ${blocked.expected}`.includes('team-y'),
    blocked,
  );
  check('X 仍未被领(owner=null / 未 in_progress)', store.get('team-x')?.owner == null, store.get('team-x'));

  // ── Y 完成(claim → done)后 claim X 放行 ─────────────────────────────────────
  check('claim Y 成功', store.claim('team-y', 'bob').ok, store.get('team-y'));
  const yDone = store.update('team-y', { status: 'done' });
  check('Y 置 done 成功', yDone.ok, yDone);

  const nowOk = store.claim('team-x', 'alice');
  check('Y done 后 claim X 成功', nowOk.ok, nowOk);
  check('X 转 in_progress 且 owner=alice', store.get('team-x')?.status === 'in_progress' && store.get('team-x')?.owner === 'alice', store.get('team-x'));

  console.log(`\n[team-blockedby-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[team-blockedby-e2e] fatal:', e);
  process.exit(1);
});
