/**
 * T10 — 权限审批桥接(askUser ↔ UI 队列)+ allow-always 规则机制。
 *
 * 两层:
 *   1) PermissionProvider 桥:engine 'ask' → ask(perm,use) enqueue 一条 pending,
 *      返回 Promise;UI decide(id, true/false) → resolve(boolean)。验 true/false 双路。
 *   2) allow-always(§0-B):driver 就地 push 一条整工具 allow 规则进**同一可变
 *      rules 对象**;之后引擎 ⑦ 的 matchRule(rules.allow, tool, input) 即命中 →
 *      下次不再弹卡。这里直接复刻 driver.allowAlways 的 push + 用真 matchRule 断言。
 */
import { test, expect, describe } from 'bun:test';
import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import {
  PermissionProvider,
  usePermissionQueue,
} from '../../src/tui/providers/permission';
import { matchRule, type PermissionRuleSet } from '../../src/permission/rules';
import type {
  PermissionResult,
  ToolUse,
  PermissionQueue,
} from '../../src/tui/contracts';

const PERM: PermissionResult = { behavior: 'ask', message: 'allow Bash?' } as PermissionResult;
const USE: ToolUse = { name: 'Bash', input: { command: 'echo hi' } } as ToolUse;

/** 把队列暴露给测试驱动:每次 render 都更新最新 queue(避免 stale ref),
 *  挂载后触发一次 ask。 */
function Harness(props: {
  onReady: (q: PermissionQueue) => void;
  onResolved: (allow: boolean) => void;
}): React.ReactElement {
  const queue = usePermissionQueue();
  // 每次渲染都把最新 queue 交回测试(state 更新会重渲染 → pending 是最新的)。
  props.onReady(queue);
  useEffect(() => {
    void queue.ask(PERM, USE).then(props.onResolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Text>pending={queue.pending.length}</Text>;
}

describe('permission queue bridge', () => {
  test('ask enqueues a pending; decide(true) resolves the askUser promise true', async () => {
    let queue: PermissionQueue | null = null;
    let resolved: boolean | undefined;
    render(
      <PermissionProvider>
        <Harness onReady={(q) => (queue = q)} onResolved={(a) => (resolved = a)} />
      </PermissionProvider>,
    );
    // 等 effect 跑 + state 更新。
    await new Promise((r) => setTimeout(r, 30));
    expect(queue).toBeTruthy();
    expect(queue!.pending.length).toBe(1);
    const id = queue!.pending[0]!.id;
    expect(queue!.pending[0]!.use.name).toBe('Bash');

    queue!.decide(id, true);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(true);
  });

  test('decide(false) resolves the askUser promise false (denied → tool not executed)', async () => {
    let queue: PermissionQueue | null = null;
    let resolved: boolean | undefined;
    render(
      <PermissionProvider>
        <Harness onReady={(q) => (queue = q)} onResolved={(a) => (resolved = a)} />
      </PermissionProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    const id = queue!.pending[0]!.id;
    queue!.decide(id, false);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
  });
});

describe('allow-always rule mechanism (§0-B)', () => {
  test('pushing an allow rule into the same mutable rules grows allow and a later matchRule allows', () => {
    // 复刻 driver.allowAlways 的就地 push(同一可变引用)。
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [] };
    const before = rules.allow.length;

    // 第一次:无 allow 规则 → matchRule 不命中(会走 ask → 弹卡)。
    expect(matchRule(rules.allow, 'Bash', { command: 'echo hi' })).toBeUndefined();

    // allow-always:就地 push 整工具规则。
    rules.allow.push({ toolName: 'Bash', behavior: 'allow', source: 'tui-allow-always' });

    expect(rules.allow.length).toBe(before + 1);
    // 第二次:同工具任意输入 → matchRule 命中 allow → 引擎 ⑦ 放行,不再弹卡。
    const hit = matchRule(rules.allow, 'Bash', { command: 'rm -rf /tmp/whatever' });
    expect(hit).toBeTruthy();
    expect(hit!.behavior).toBe('allow');
    expect(hit!.toolName).toBe('Bash');
  });

  test('allow rule for one tool does not leak to a different tool', () => {
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [] };
    rules.allow.push({ toolName: 'Bash', behavior: 'allow', source: 'tui-allow-always' });
    expect(matchRule(rules.allow, 'Write', { file_path: '/tmp/x' })).toBeUndefined();
  });
});
