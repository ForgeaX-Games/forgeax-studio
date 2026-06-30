/**
 * 命令补齐批次(025)B 层:16 个新命令的注册 + 行为证据。
 *
 * 每个命令对一个 stub CommandCtx 跑 run(),断言:
 *   - 走对了 ctx 能力方法(setPermissionMode / triggerCompact / resume…);
 *   - 经 ctx.print 渲染出预期文本。
 * 能力本体(A 层)各自单测已覆盖;这里只验「命令出口 → ctx 委派 + 渲染」这层接线。
 */
import { test, expect, describe } from 'bun:test';
import { resolveCommand, listCommands } from '../../src/tui/commands/registry';
import '../../src/tui/commands/index'; // barrel → 副作用注册
import type { CommandCtx } from '../../src/tui/contracts';
import { summarizeUsage, contextStats } from '../../src/context/usage-stats';
import { getPermissionRules } from '../../src/permission/inspect';
import { getStatus } from '../../src/cli/status-aggregate';
import { EMPTY_USAGE } from '../../src/provider/types';

const MODEL = 'claude-opus-4-8';

/** 造一个记录 print / setPermissionMode 调用的 stub ctx,能力方法回固定 fixture。 */
function makeCtx(over: Partial<CommandCtx> = {}): {
  ctx: CommandCtx;
  prints: string[];
  modes: string[];
  resumed: string[];
} {
  const prints: string[] = [];
  const modes: string[] = [];
  const resumed: string[] = [];
  const ctx: CommandCtx = {
    send: () => {},
    clear: () => {},
    exit: () => {},
    setModel: () => {},
    print: (t) => prints.push(t),
    getUsage: () => summarizeUsage(EMPTY_USAGE, MODEL),
    getContextStats: () => contextStats(1234, MODEL),
    listMcp: async () => ({
      servers: [
        { name: 'good', type: 'stdio', status: 'connected', toolCount: 3, deferred: false },
        { name: 'bad', type: 'http', status: 'failed', toolCount: 0, deferred: false, error: 'ECONNREFUSED' },
      ],
      configErrors: [],
    }),
    getPermissionRules: () => getPermissionRules({ allow: [{ toolName: 'read_file', behavior: 'allow' }] }, 'default'),
    setPermissionMode: (m) => modes.push(m),
    listSessions: () => [{ id: 'default', file: '/w/default/events.jsonl', sizeBytes: 2048, mtimeMs: 0 }],
    resume: async () => true,
    resumeInto: async (id) => {
      resumed.push(id);
      return true;
    },
    listAgents: () => [
      { name: 'Explore', role: 'scout', description: 'read-only search', tools: ['read_file', 'grep'], source: 'builtin' },
    ],
    listMemory: () => ({
      memoryDir: '/w/.forgeax/memory',
      entries: [{ filename: 'a.md', filePath: '/w/.forgeax/memory/a.md', name: 'fact-a', description: 'desc a', type: undefined, mtimeMs: 0 }],
      indexPath: '/w/.forgeax/memory/MEMORY.md',
      indexExists: true,
    }),
    listSkills: () => [{ name: 'sk', source: 'session', status: 'enabled', detail: 'a skill' }],
    listPlugins: () => [{ name: 'pl', source: 'session', status: 'enabled' }],
    listHooks: () => [{ name: 'PreToolUse', source: 'settings', status: 'active', detail: 'echo hi' }],
    getStatus: () => getStatus({ model: MODEL, cwd: '/w', permissionMode: 'default', usage: EMPTY_USAGE }),
    runDoctor: async () => ({ checks: [{ category: 'provider', id: 'provider', label: 'Provider 连通', status: 'ok' }], healthy: true }),
    triggerCompact: async () => ({ compacted: true, usedLLM: true }),
    runInit: async () => ({
      subagent: { text: '', terminalReason: 'completed', turns: 1, toolCalls: 0 } as never,
      targetPath: '/w/AGENTS.md',
      fileName: 'AGENTS.md',
      existing: { exists: false },
    }),
    ...over,
  };
  return { ctx, prints, modes, resumed };
}

const NEW_COMMANDS = [
  'compact', 'context', 'cost', 'mcp', 'permissions', 'plan',
  'resume', 'continue', 'init', 'agents', 'memory',
  'skills', 'plugin', 'hooks', 'status', 'doctor',
];

describe('025 命令补齐:注册', () => {
  test('16 个新命令全部注册', () => {
    const names = listCommands().map((c) => c.name);
    for (const n of NEW_COMMANDS) expect(names).toContain(n);
  });
});

describe('025 命令补齐:行为', () => {
  test('/compact → triggerCompact + 渲染', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('compact')!.run(ctx, '');
    expect(prints.join()).toContain('已压缩');
  });

  test('/compact 历史不足 → 跳过', async () => {
    const { ctx, prints } = makeCtx({ triggerCompact: async () => ({ compacted: false, usedLLM: false }) });
    await resolveCommand('compact')!.run(ctx, '');
    expect(prints.join()).toContain('跳过');
  });

  test('/context → token 占用', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('context')!.run(ctx, '');
    expect(prints.join()).toContain('上下文');
    expect(prints.join()).toContain('tokens');
  });

  test('/cost → 累计用量', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('cost')!.run(ctx, '');
    expect(prints.join()).toContain('合计');
  });

  test('/mcp → 区分连接态', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('mcp')!.run(ctx, '');
    const out = prints.join();
    expect(out).toContain('good');
    expect(out).toContain('bad');
    expect(out).toContain('ECONNREFUSED');
  });

  test('/mcp 未配置 → 提示', async () => {
    const { ctx, prints } = makeCtx({ listMcp: async () => ({ servers: [], configErrors: [] }) });
    await resolveCommand('mcp')!.run(ctx, '');
    expect(prints.join()).toContain('未配置');
  });

  test('/permissions 无参 → 列规则', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('permissions')!.run(ctx, '');
    expect(prints.join()).toContain('权限模式');
  });

  test('/permissions plan → 切模式', async () => {
    const { ctx, prints, modes } = makeCtx();
    await resolveCommand('permissions')!.run(ctx, 'plan');
    expect(modes).toContain('plan');
    expect(prints.join()).toContain('已切换');
  });

  test('/permissions 非法模式 → 拒绝', async () => {
    const { ctx, prints, modes } = makeCtx();
    await resolveCommand('permissions')!.run(ctx, 'nonsense');
    expect(modes).toHaveLength(0);
    expect(prints.join()).toContain('无效模式');
  });

  test('/plan → 切到 plan 模式', async () => {
    const { ctx, prints, modes } = makeCtx();
    await resolveCommand('plan')!.run(ctx, '');
    expect(modes).toContain('plan');
    expect(prints.join()).toContain('plan');
  });

  test('/resume 无参 → 列会话', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('resume')!.run(ctx, '');
    expect(prints.join()).toContain('default');
  });

  test('/resume id → 恢复(走 resumeInto;成功提示由 doResume 打印,命令不重复)', async () => {
    const { ctx, resumed, prints } = makeCtx();
    await resolveCommand('resume')!.run(ctx, 'default');
    expect(resumed).toContain('default'); // 命令调了 resumeInto(回灌 transcript + reseed)
    expect(prints.join()).not.toContain('未找到'); // 成功 → 无错误提示
  });

  test('/resume 未命中 → 报错', async () => {
    const { ctx, prints } = makeCtx({ resumeInto: async () => false });
    await resolveCommand('resume')!.run(ctx, 'ghost');
    expect(prints.join()).toContain('未找到');
  });

  test('/continue → 续接 default', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('continue')!.run(ctx, '');
    expect(prints.join()).toContain('已续接');
  });

  test('/init → 生成 AGENTS.md', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('init')!.run(ctx, '');
    expect(prints.join()).toContain('AGENTS.md');
  });

  test('/agents → 列子 agent', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('agents')!.run(ctx, '');
    expect(prints.join()).toContain('Explore');
  });

  test('/memory → 列条目', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('memory')!.run(ctx, '');
    expect(prints.join()).toContain('fact-a');
  });

  test('/skills /plugin /hooks → 列扩展', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('skills')!.run(ctx, '');
    await resolveCommand('plugin')!.run(ctx, '');
    await resolveCommand('hooks')!.run(ctx, '');
    const out = prints.join('\n');
    expect(out).toContain('sk');
    expect(out).toContain('pl');
    expect(out).toContain('PreToolUse');
  });

  test('/status → 概览', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('status')!.run(ctx, '');
    const out = prints.join();
    expect(out).toContain('模型');
    expect(out).toContain('1/2 已连'); // good connected, bad failed
  });

  test('/doctor → 健康报告', async () => {
    const { ctx, prints } = makeCtx();
    await resolveCommand('doctor')!.run(ctx, '');
    expect(prints.join()).toContain('全部健康');
  });
});
