/**
 * Hook 严格测试(本批新增补全)。覆盖三层:
 *   (A) makeSpawnSyncHookRunner —— live 外部命令 hook 的**全量** stdout 解析
 *       (block/continue/additionalContext/systemMessage/permissionDecision/modify)
 *       + exit-2 block + **超时 fail-open** + 空/非 JSON fail-open。
 *   (B) dispatch preToolPermission —— PreToolUse 权限三态 allow/ask/deny 在把闸处生效。
 *   (C) CoreAgent e2e —— PreToolUse hook 经 EventBus 设 permissionDecision,
 *       真实驱动 loop 的工具放行/拒绝。
 */
import { test, expect, describe } from 'bun:test';
import { makeSpawnSyncHookRunner } from '../src/cli/host-bits';
import { dispatchTools } from '../src/agent/dispatch';
import { loadHooksFromSettings } from '../src/capability/hooks/from-settings';
import { buildTool, type AgentTool } from '../src/capability/types';
import { CoreAgent } from '../src/agent/agent';
import { EventBus } from '../src/events/event-bus';
import { CoreEventType } from '../src/events/events';
import type { CoreEvent } from '../src/events/types';
import type { AgentContext, AgentEvent } from '../src/agent/types';
import type { LLMProvider, ProviderStreamEvent, StopReason, Usage } from '../src/provider/types';
import { EMPTY_USAGE } from '../src/provider/types';

// ════════════════════════════════ (A) live spawn runner ════════════════════════════════

const preToolEvent = (cmd = 'ls'): CoreEvent => ({
  type: CoreEventType.ToolCallRequested,
  payload: { toolName: 'Bash', toolUseId: 't1', input: { command: cmd } },
  ts: 0,
});

describe('makeSpawnSyncHookRunner — 全量 stdout 解析', () => {
  const run = makeSpawnSyncHookRunner();

  test('decision=block(stdout JSON)→ block + reason', () => {
    const d = run(`echo '{"decision":"block","reason":"nope"}'`, preToolEvent());
    expect(d && d.block).toBe(true);
    expect(d && d.reason).toBe('nope');
  });

  test('exit code 2 → block,reason 取 stderr', () => {
    const d = run(`echo "danger" 1>&2; exit 2`, preToolEvent());
    expect(d && d.block).toBe(true);
    expect(d && d.reason).toBe('danger');
  });

  test('continue:false → continue:false(此前 live runner 丢失,本批补)', () => {
    const d = run(`echo '{"continue":false}'`, preToolEvent()) as { continue?: boolean } | void;
    expect(d && d.continue).toBe(false);
  });

  test('hookSpecificOutput.additionalContext → additionalContext(此前丢失,本批补)', () => {
    const d = run(
      `echo '{"hookSpecificOutput":{"additionalContext":"REMEMBER"}}'`,
      preToolEvent(),
    ) as { additionalContext?: string } | void;
    expect(d && d.additionalContext).toBe('REMEMBER');
  });

  test('systemMessage → systemMessage(此前丢失,本批补)', () => {
    const d = run(`echo '{"systemMessage":"SM"}'`, preToolEvent()) as { systemMessage?: string } | void;
    expect(d && d.systemMessage).toBe('SM');
  });

  test('permissionDecision=allow → permissionDecision:allow,不 block', () => {
    const d = run(
      `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`,
      preToolEvent(),
    ) as { permissionDecision?: string; block?: boolean } | void;
    expect(d && d.permissionDecision).toBe('allow');
    expect(d && d.block).toBeUndefined();
  });

  test('permissionDecision=deny → permissionDecision:deny + block', () => {
    const d = run(
      `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"X"}}'`,
      preToolEvent(),
    ) as { permissionDecision?: string; block?: boolean; reason?: string } | void;
    expect(d && d.permissionDecision).toBe('deny');
    expect(d && d.block).toBe(true);
    expect(d && d.reason).toBe('X');
  });

  test('modify(forgeax 扩展键)→ modify 透传', () => {
    const d = run(`echo '{"modify":{"source":"hooked"}}'`, preToolEvent()) as { modify?: unknown } | void;
    expect(d && d.modify).toEqual({ source: 'hooked' });
  });

  test('stdin 为 wire JSON(eventToHookInput),hook 能读 hook_event_name/tool_name', () => {
    // hook 把 stdin 的 .hook_event_name + .tool_name 回吐进 additionalContext 验证 wire 形状。
    const d = run(
      `python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps({'hookSpecificOutput':{'additionalContext':d['hook_event_name']+':'+d['tool_name']}}))"`,
      preToolEvent(),
    ) as { additionalContext?: string } | void;
    expect(d && d.additionalContext).toBe('PreToolUse:Bash');
  });

  test('超时 → fail-open(返回放行,不阻塞总线)', () => {
    const prev = process.env.FORGEAX_HOOK_TIMEOUT_MS;
    process.env.FORGEAX_HOOK_TIMEOUT_MS = '200';
    try {
      const d = run(`sleep 3; echo '{"decision":"block"}'`, preToolEvent());
      expect(d).toBeUndefined(); // 超时被杀 → 放行(不得 block)
    } finally {
      if (prev == null) delete process.env.FORGEAX_HOOK_TIMEOUT_MS;
      else process.env.FORGEAX_HOOK_TIMEOUT_MS = prev;
    }
  });

  test('空 stdout / 非 JSON → fail-open(undefined 放行)', () => {
    expect(run(`true`, preToolEvent())).toBeUndefined();
    expect(run(`echo "hello not json"`, preToolEvent())).toBeUndefined();
  });
});

// ════════════════════════════════ (B) dispatch preToolPermission ════════════════════════════════

const okResult = (o: unknown, id: string): CoreEvent => ({ type: 'tool.result', payload: { id, o }, ts: 0 });

function mkTool(name: string, opts: { readOnly?: boolean; deny?: boolean; onRun?: () => void } = {}): AgentTool {
  return buildTool({
    name,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    // deny:true → 引擎显式拒绝(模拟敏感工具),用于证明 hook 'allow' 旁路 / undefined 不变。
    ...(opts.deny ? { checkPermissions: async () => ({ behavior: 'deny' as const, message: 'engine deny' }) } : {}),
    call: async (i: unknown) => {
      opts.onRun?.();
      return { data: i };
    },
    mapResult: okResult,
    maxResultSizeChars: 1000,
  });
}
const baseDeps = (tools: AgentTool[], over: Partial<Parameters<typeof dispatchTools>[1]> = {}) => ({
  tools,
  toolContext: {},
  signal: new AbortController().signal,
  trusted: false,
  ...over,
});

describe('dispatch — preToolPermission 三态', () => {
  test("hook 'allow' 旁路引擎拒绝 → 工具仍运行(免审批卡)", async () => {
    let ran = false;
    const tool = mkTool('writer', { deny: true, onRun: () => (ran = true) }); // 引擎显式 deny
    const r = await dispatchTools([{ id: 'a', name: 'writer', input: {} }], baseDeps([tool], {
      preToolPermission: () => 'allow',
    }));
    expect(r[0].isError).toBe(false); // hook allow 旁路了引擎 deny
    expect(ran).toBe(true);
  });

  test("hook 'deny' → permission_denied,工具不运行", async () => {
    let ran = false;
    const tool = mkTool('reader', { readOnly: true, onRun: () => (ran = true) }); // 引擎本会 allow
    const r = await dispatchTools([{ id: 'd', name: 'reader', input: {} }], baseDeps([tool], {
      preToolPermission: () => 'deny',
    }));
    expect(r[0].isError).toBe(true);
    expect(r[0].errorCategory).toBe('permission_denied');
    expect(ran).toBe(false);
  });

  test("hook 'ask' 在引擎判 allow 时强制 askUser:拒 → 不运行", async () => {
    let ran = false;
    let asked = false;
    const tool = mkTool('reader2', { readOnly: true, onRun: () => (ran = true) });
    const r = await dispatchTools([{ id: 'k', name: 'reader2', input: {} }], baseDeps([tool], {
      preToolPermission: () => 'ask',
      askUser: async () => {
        asked = true;
        return false; // 用户拒
      },
    }));
    expect(asked).toBe(true);
    expect(r[0].isError).toBe(true);
    expect(ran).toBe(false);
  });

  test("hook 'ask' askUser 准 → 运行", async () => {
    let ran = false;
    const tool = mkTool('reader3', { readOnly: true, onRun: () => (ran = true) });
    const r = await dispatchTools([{ id: 'y', name: 'reader3', input: {} }], baseDeps([tool], {
      preToolPermission: () => 'ask',
      askUser: async () => true,
    }));
    expect(r[0].isError).toBe(false);
    expect(ran).toBe(true);
  });

  test('无 preToolPermission(undefined)→ 走常规引擎(引擎 deny 仍 deny,零行为变化)', async () => {
    let ran = false;
    const tool = mkTool('writer2', { deny: true, onRun: () => (ran = true) });
    const r = await dispatchTools([{ id: 'n', name: 'writer2', input: {} }], baseDeps([tool]));
    expect(r[0].isError).toBe(true); // 引擎 deny 被尊重(无 hook 旁路)
    expect(ran).toBe(false);
  });
});

// ════════════════════════════════ (C) CoreAgent e2e ════════════════════════════════

const asst = (content: Array<{ type: string; [k: string]: unknown }>, stopReason: StopReason): ProviderStreamEvent => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  usage: { ...EMPTY_USAGE } as Usage,
  stopReason,
});
const tu = (id: string, name: string, input: unknown) => [{ type: 'tool_use', id, name, input }];
const txt = (t: string) => [{ type: 'text', text: t }];

function mkProvider(handlers: Array<() => ProviderStreamEvent[]>): LLMProvider {
  let call = 0;
  return {
    api: 'stub',
    async *stream() {
      const h = handlers[Math.min(call, handlers.length - 1)];
      call++;
      for (const ev of h()) yield ev;
    },
  };
}
function ctx(tools: AgentTool[], prov: LLMProvider): AgentContext {
  return {
    agentId: 'a',
    provider: prov,
    config: { systemPromptSlots: [], model: 'm', tools: tools as never, maxTurns: 8 },
    toolContext: {},
  };
}
async function runAgent(agent: CoreAgent): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of agent.run({ input: { type: 'user', payload: 'go', ts: 0 } })) out.push(e);
  return out;
}

describe('CoreAgent e2e — PreToolUse permissionDecision 驱动 loop', () => {
  test("PreToolUse hook permissionDecision='deny' → 工具被拒,不运行", async () => {
    let ran = false;
    const bus = new EventBus();
    bus.subscribe(CoreEventType.ToolCallRequested, (_e, ctl) =>
      ctl.modify({ permissionDecision: 'deny' } as never),
    );
    const tool = mkTool('act', { onRun: () => (ran = true) });
    const provider = mkProvider([
      () => [asst(tu('t1', 'act', { x: 1 }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const agent = new CoreAgent({ context: ctx([tool], provider), bus });
    const evs = await runAgent(agent);
    const tr = evs.find((e) => e.type === 'tool_result');
    expect(JSON.stringify(tr)).toContain('denied');
    expect(ran).toBe(false);
  });

  test("PreToolUse hook permissionDecision='allow' → 旁路引擎拒绝,工具运行", async () => {
    let ran = false;
    const bus = new EventBus();
    // act2 引擎显式 deny;hook allow 应旁路放行。
    bus.subscribe(CoreEventType.ToolCallRequested, (_e, ctl) =>
      ctl.modify({ permissionDecision: 'allow' } as never),
    );
    const tool = mkTool('act2', { deny: true, onRun: () => (ran = true) });
    const provider = mkProvider([
      () => [asst(tu('t1', 'act2', { x: 1 }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const agent = new CoreAgent({ context: ctx([tool], provider), bus });
    const evs = await runAgent(agent);
    expect(ran).toBe(true);
    const tr = evs.find((e) => e.type === 'tool_result');
    expect(JSON.stringify(tr)).not.toContain('permission');
  });

  test('PreCompact matcher 区分 manual/auto', () => {
    const bus = new EventBus();
    const fired: string[] = [];
    // 仅匹配 auto 的 PreCompact hook。
    loadHooksFromSettings(bus, { PreCompact: [{ matcher: 'auto', command: 'x' }] }, () => {
      fired.push('auto-hook');
      return;
    });
    bus.publish({ type: CoreEventType.PreCompact, payload: { trigger: 'auto', tokenCount: 1 }, ts: 0 });
    bus.publish({ type: CoreEventType.PreCompact, payload: { trigger: 'manual', tokenCount: 1 }, ts: 1 });
    // 只在 auto 触发一次,manual 被 matcher 过滤掉。
    expect(fired).toEqual(['auto-hook']);
  });

  test('PreToolUse 每工具只发布一次(isBlocked 与 preToolPermission 共用回执)', async () => {
    let publishes = 0;
    const bus = new EventBus();
    bus.subscribe(CoreEventType.ToolCallRequested, () => {
      publishes++;
    });
    const tool = mkTool('act3', { readOnly: true });
    const provider = mkProvider([
      () => [asst(tu('t1', 'act3', { x: 1 }), 'tool_use')],
      () => [asst(txt('done'), 'end_turn')],
    ]);
    const agent = new CoreAgent({ context: ctx([tool], provider), bus });
    await runAgent(agent);
    expect(publishes).toBe(1); // 单工具单轮:恰一次 PreToolUse(不重复触发 hook)
  });
});
