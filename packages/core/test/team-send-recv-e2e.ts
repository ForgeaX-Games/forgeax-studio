/**
 * M2 · AC-06 数据面真投递 e2e —— InProcessTeammateExecutor + mailbox + inbox 闭包。
 *
 * 不是 .test.ts(bun test 不自动收;它是 M2 CI sweep 列出的真集成 e2e,退出码=失败数)。
 * 手动跑:`cd packages/core && bun test/team-send-recv-e2e.ts`。
 *
 * 验收(对应 acceptance T2 / AC-06):agent A 经 SendMessage(to=B,{kind:'text'}) 真投递,
 * B 的 inbox 闭包(= host 注入进 agent.ts:758 `this.o.inbox` 接缝的那个闭包)返回的
 * ProviderMessage[] 中出现 A 投来的 text。这证明数据面到达 B 下一回合输入装配——
 * LLM-append 那一步是 agent.ts:758 既有机制(已测),本 e2e 不再走真 API。
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
  console.log('[team-send-recv-e2e] InProcessTeammateExecutor 数据面 A→B 真投递\n');

  // 一个 team:executor 持进程内 mailbox。A、B 两成员都在册(spawn 兑现)。
  const exec = new InProcessTeammateExecutor();
  await exec.spawn({ type: 'worker', requirement: 'A' });
  await exec.spawn({ type: 'worker', requirement: 'B' });
  // spawn 用 spec.type 派生 agentId,本测试显式按名注册可寻址成员(对照 §13.1#7 to=name)。
  exec.register('A');
  exec.register('B');

  // B 的 inbox 闭包:host 在派 B 时会把这个闭包挂到 B 的 CoreAgentOptions.inbox。
  const bInbox = buildInboxClosure({ self: 'B', mailbox: exec.mailbox });

  // 数据面消息:A 发给 B 一段文本。
  const SENT = 'hello-from-A please pick up task #7';
  const msg: TeamMessage = { kind: 'text', from: 'A', to: 'B', text: SENT };
  await exec.sendMessage('B', msg);

  // 投不达分支:isActive(B) 应为 true(已注册)。
  check('isActive(B) 为 true(B 在册)', exec.isActive('B'), exec.isActive('B'));

  // B 下一回合 drain:inbox 闭包应返回含 A 文本的 ProviderMessage[]。
  const inbound = bInbox();
  check('B 的 inbox 闭包返回 ≥1 条 ProviderMessage', inbound.length >= 1, inbound.length);
  const joined = inbound.map(bodyText).join('\n');
  check('B 下一回合输入装配含 A 投来的 text', joined.includes(SENT), joined);
  check('返回的是 user 轮(role=user)', inbound.every((m) => m.role === 'user'), inbound.map((m) => m.role));

  // 幂等:再次 drain 应为空(已被消费,不重复注入)。
  const again = bInbox();
  check('drain 后再 drain 为空(消费即清,不重复)', again.length === 0, again.length);

  // 投给不存在成员:delivered:false 路径由 SendMessage 工具层兜(见 message-tools 单测);
  //   executor.sendMessage 本身对未注册 to 应不抛(graceful),isActive 为 false。
  check('isActive(未知成员) 为 false', !exec.isActive('ghost'), exec.isActive('ghost'));

  console.log(`\n[team-send-recv-e2e] ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[team-send-recv-e2e] fatal:', e);
  process.exit(1);
});
