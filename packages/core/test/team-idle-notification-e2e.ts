/**
 * M2 · AC-07 控制面分流 e2e —— idle_notification 回 leader,进 handler 不进 LLM 数据面。
 *
 * 不是 .test.ts(M2 CI sweep 列出的真集成 e2e,退出码=失败数)。
 * 手动跑:`cd packages/core && bun test/team-idle-notification-e2e.ts`。
 *
 * 验收(对应 acceptance T2 / AC-07):teammate 发 idle_notification 给 leader,leader 的
 * inbox 闭包(= 注入 agent.ts:758 的那个)在 drain 时把它路由进控制面 handler(捕获),
 * 且该控制面消息**不出现**在闭包返回的 ProviderMessage[](LLM 数据面)里。两条断言:
 * 控制面到达 handler;数据面未被污染。
 *
 * Boundary:test/ 下,只 import core-local。
 */
import { InProcessTeammateExecutor } from '../src/inject/in-process-teammate-executor';
import { buildInboxClosure } from '../src/agent/team/inbox-router';
import type { TeamMessage } from '../src/agent/team/team-message';
import type { ProviderMessage } from '../src/provider/types';

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

function bodyText(m: ProviderMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

async function main(): Promise<void> {
  console.log('[team-idle-notification-e2e] 控制面 idle_notification 回 leader,不进 LLM 数据面\n');

  const exec = new InProcessTeammateExecutor();
  exec.register('leader');
  exec.register('worker');

  // 控制面 handler 捕获:onControl 收集所有路由进控制面的消息(按 kind)。
  const routed: TeamMessage[] = [];
  const leaderInbox = buildInboxClosure({
    self: 'leader',
    mailbox: exec.mailbox,
    onControl: (m) => routed.push(m),
  });

  // worker 回合后发 idle_notification(控制面)给 leader。
  const idle: TeamMessage = {
    kind: 'idle_notification',
    from: 'worker',
    to: 'leader',
    state: 'available',
    completedTaskId: 'task-001',
    completedStatus: 'done',
  };
  await exec.sendMessage('leader', idle);

  // 同时再发一条数据面 text,验证两平面在同一 mailbox 里被正确分流。
  const TEXT = 'data-plane-only-text';
  const text: TeamMessage = { kind: 'text', from: 'worker', to: 'leader', text: TEXT };
  await exec.sendMessage('leader', text);

  // leader drain:控制面进 handler,数据面进返回值。
  const inbound = leaderInbox();

  // 断言 1:控制面到达 handler。
  check('idle_notification 路由进控制面 handler', routed.some((m) => m.kind === 'idle_notification'), routed.map((m) => m.kind));
  const got = routed.find((m) => m.kind === 'idle_notification') as
    | (TeamMessage & { kind: 'idle_notification' })
    | undefined;
  check('handler 收到的 idle_notification 携 state=available', got?.state === 'available', got);

  // 断言 2:数据面未被污染——控制面 idle_notification 不出现在返回的 ProviderMessage[]。
  const joined = inbound.map(bodyText).join('\n');
  check('控制面消息不进 LLM 数据面(返回值不含 idle_notification)', !joined.includes('idle_notification'), joined);
  check('控制面消息不进 LLM 数据面(返回值不含 completedTaskId)', !joined.includes('task-001'), joined);

  // 数据面 text 仍正常到达(证明分流不是「全丢」)。
  check('同 mailbox 的数据面 text 仍到达返回值', joined.includes(TEXT), joined);

  console.log(`\n[team-idle-notification-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[team-idle-notification-e2e] fatal:', e);
  process.exit(1);
});
