/**
 * PERM — permission 把闸测试。验证固定决策顺序、fail-closed、bypass 免疫、
 * checkRuleBasedPermissions 子集语义。
 */
import { test, expect, describe } from 'bun:test';
import { buildTool, type ToolContext, type PermissionResult } from '../src/capability/types';
import {
  hasPermissionsToUseTool,
  checkRuleBasedPermissions,
  isProtectedPath,
} from '../src/permission/engine';
import { matchRule, parseRuleString, type PermissionRuleSet } from '../src/permission/rules';

function ctx(): ToolContext {
  return { signal: new AbortController().signal } as ToolContext;
}

/** 造一个假工具:checkPermissions 行为可注入。 */
function fakeTool(
  name: string,
  check?: (input: unknown, c: ToolContext) => Promise<PermissionResult>,
) {
  return buildTool({
    name,
    ...(check ? { checkPermissions: check } : {}),
    call: async (input: unknown) => ({ data: input }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

const NO_RULES: PermissionRuleSet = { deny: [], ask: [], allow: [] };

describe('rules — parsing + matching', () => {
  test('parseRuleString: tool only / tool(content) / invalid', () => {
    expect(parseRuleString('Bash', 'deny')).toEqual({ toolName: 'Bash', behavior: 'deny', source: undefined });
    expect(parseRuleString('Bash(git *)', 'allow')).toEqual({
      toolName: 'Bash',
      content: 'git *',
      behavior: 'allow',
      source: undefined,
    });
    expect(parseRuleString('   ', 'deny')).toBeNull();
    expect(parseRuleString('Bash(unclosed', 'deny')).toBeNull();
  });

  test('matchRule: whole-tool rule matches any input', () => {
    const r = matchRule([{ toolName: 'Write', behavior: 'deny' }], 'Write', { file_path: '/x' });
    expect(r).toBeDefined();
  });

  test('matchRule: content glob on Bash command', () => {
    const rules = [{ toolName: 'Bash', content: 'git *', behavior: 'allow' as const }];
    expect(matchRule(rules, 'Bash', { command: 'git status' })).toBeDefined();
    expect(matchRule(rules, 'Bash', { command: 'rm -rf /' })).toBeUndefined();
  });

  test('matchRule: MCP server-level rule matches server tool', () => {
    expect(matchRule([{ toolName: 'mcp__srv', behavior: 'deny' }], 'mcp__srv__doit', {})).toBeDefined();
    expect(matchRule([{ toolName: 'mcp__srv__*', behavior: 'deny' }], 'mcp__srv__doit', {})).toBeDefined();
    expect(matchRule([{ toolName: 'mcp__other', behavior: 'deny' }], 'mcp__srv__doit', {})).toBeUndefined();
  });
});

describe('decision order — deny precedes ask precedes allow', () => {
  test('① deny rule wins over ⑦ allow rule for same tool', async () => {
    const tool = fakeTool('Bash');
    const rules: PermissionRuleSet = {
      deny: [{ toolName: 'Bash', behavior: 'deny' }],
      ask: [],
      allow: [{ toolName: 'Bash', behavior: 'allow' }],
    };
    const r = await hasPermissionsToUseTool(tool, { command: 'ls' }, ctx(), rules);
    expect(r.behavior).toBe('deny');
  });

  test('② ask rule wins over ⑦ allow rule', async () => {
    const tool = fakeTool('Bash');
    const rules: PermissionRuleSet = {
      deny: [],
      ask: [{ toolName: 'Bash', behavior: 'ask' }],
      allow: [{ toolName: 'Bash', behavior: 'allow' }],
    };
    const r = await hasPermissionsToUseTool(tool, { command: 'ls' }, ctx(), rules);
    expect(r.behavior).toBe('ask');
  });

  test('⑦ always-allow rule allows when no deny/ask', async () => {
    const tool = fakeTool('Bash');
    const rules: PermissionRuleSet = {
      deny: [],
      ask: [],
      allow: [{ toolName: 'Bash', content: 'git *', behavior: 'allow' }],
    };
    const r = await hasPermissionsToUseTool(tool, { command: 'git status' }, ctx(), rules);
    expect(r.behavior).toBe('allow');
    expect(r.decisionReason?.type).toBe('rule');
  });

  test('③ tool.checkPermissions deny is honored', async () => {
    const tool = fakeTool('Bash', async () => ({ behavior: 'deny', message: 'no' }));
    const r = await hasPermissionsToUseTool(tool, { command: 'x' }, ctx(), NO_RULES);
    expect(r.behavior).toBe('deny');
  });

  test('default tool (passthrough) → ⑧ ask when no allow rule', async () => {
    // buildTool default checkPermissions returns allow; use explicit passthrough tool.
    const tool = fakeTool('Custom', async () => ({ behavior: 'passthrough' }));
    const r = await hasPermissionsToUseTool(tool, {}, ctx(), NO_RULES);
    expect(r.behavior).toBe('ask');
    expect(r.decisionReason?.type).toBe('passthrough');
  });

  test('tool checkPermissions allow → allow (no rule needed)', async () => {
    const tool = fakeTool('Read', async (input) => ({ behavior: 'allow', updatedInput: input }));
    const r = await hasPermissionsToUseTool(tool, { file_path: '/tmp/a' }, ctx(), NO_RULES);
    expect(r.behavior).toBe('allow');
  });
});

describe('safetyCheck — bypass immune', () => {
  test('isProtectedPath: .git / .forgeax / shell config', () => {
    expect(isProtectedPath('/repo/.git/config')).toBe(true);
    expect(isProtectedPath('/repo/.forgeax/settings.json')).toBe(true);
    expect(isProtectedPath('/home/you/.zshrc')).toBe(true);
    expect(isProtectedPath('/home/you/.config/fish/config.fish')).toBe(true);
    expect(isProtectedPath('/repo/src/index.ts')).toBe(false);
  });

  test('enableSafetyCheck 开:protected path → ask even in bypassPermissions mode', async () => {
    const tool = fakeTool('Write', async (input) => ({ behavior: 'allow', updatedInput: input }));
    const r = await hasPermissionsToUseTool(
      tool,
      { file_path: '/repo/.git/config' },
      ctx(),
      NO_RULES,
      { mode: 'bypassPermissions', enableSafetyCheck: true },
    );
    expect(r.behavior).toBe('ask');
    expect(r.decisionReason?.type).toBe('safetyCheck');
  });

  test('默认关(不传 enableSafetyCheck):protected path 在 bypass 下放行(core 不默认限路径)', async () => {
    const tool = fakeTool('Write', async (input) => ({ behavior: 'allow', updatedInput: input }));
    const r = await hasPermissionsToUseTool(
      tool,
      { file_path: '/repo/.git/config' },
      ctx(),
      NO_RULES,
      { mode: 'bypassPermissions' },
    );
    expect(r.behavior).toBe('allow');
    expect(r.decisionReason?.type).toBe('mode');
  });

  test('non-protected path → bypass allows', async () => {
    const tool = fakeTool('Write', async (input) => ({ behavior: 'allow', updatedInput: input }));
    const r = await hasPermissionsToUseTool(
      tool,
      { file_path: '/repo/src/x.ts' },
      ctx(),
      NO_RULES,
      { mode: 'bypassPermissions' },
    );
    expect(r.behavior).toBe('allow');
    expect(r.decisionReason?.type).toBe('mode');
  });

  test('deny rule still wins even in bypass (deny is step ①, before bypass ⑥)', async () => {
    const tool = fakeTool('Bash');
    const rules: PermissionRuleSet = { deny: [{ toolName: 'Bash', behavior: 'deny' }], ask: [], allow: [] };
    const r = await hasPermissionsToUseTool(tool, { command: 'ls' }, ctx(), rules, {
      mode: 'bypassPermissions',
    });
    expect(r.behavior).toBe('deny');
  });
});

describe('fail-closed', () => {
  test('checkPermissions throws → not allowed (downgraded to ask)', async () => {
    const tool = fakeTool('Bash', async () => {
      throw new Error('boom');
    });
    const r = await hasPermissionsToUseTool(tool, { command: 'x' }, ctx(), NO_RULES);
    expect(r.behavior).toBe('ask');
    expect(r.behavior).not.toBe('allow');
  });

  test('checkPermissions throws → not allowed even in bypass mode', async () => {
    const tool = fakeTool('Bash', async () => {
      throw new Error('boom');
    });
    const r = await hasPermissionsToUseTool(tool, { command: 'x' }, ctx(), NO_RULES, {
      mode: 'bypassPermissions',
    });
    expect(r.behavior).toBe('ask');
  });

  test('malformed checkPermissions result → ask (passthrough)', async () => {
    const tool = fakeTool('Bash', async () => ({}) as PermissionResult);
    const r = await hasPermissionsToUseTool(tool, { command: 'x' }, ctx(), NO_RULES);
    expect(r.behavior).toBe('ask');
  });
});

/** edit/write 系工具:声明 isDestructive=true(对齐 builtin write_file/edit_file)。 */
function editTool(name: string) {
  return buildTool({
    name,
    isDestructive: () => true,
    checkPermissions: async (input: unknown) => ({ behavior: 'allow' as const, updatedInput: input }),
    call: async (input: unknown) => ({ data: input }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

/** 只读工具:声明 isReadOnly=true。 */
function readOnlyTool(name: string) {
  return buildTool({
    name,
    isReadOnly: () => true,
    checkPermissions: async (input: unknown) => ({ behavior: 'allow' as const, updatedInput: input }),
    call: async (input: unknown) => ({ data: input }),
    mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
    maxResultSizeChars: 1000,
  });
}

describe('acceptEdits', () => {
  test('edit/write tool → allow without any rule (by isDestructive)', async () => {
    const tool = editTool('write_file');
    const r = await hasPermissionsToUseTool(tool, { file_path: '/repo/src/x.ts' }, ctx(), NO_RULES, {
      mode: 'acceptEdits',
    });
    expect(r.behavior).toBe('allow');
    expect(r.decisionReason?.type).toBe('mode');
    expect((r.decisionReason as { mode?: string }).mode).toBe('acceptEdits');
  });

  test('edit tool by canonical name (Write alias) → allow', async () => {
    // tool whose name is not in EDIT set but alias is.
    const tool = buildTool({
      name: 'my_writer',
      aliases: ['Write'],
      checkPermissions: async (i: unknown) => ({ behavior: 'allow' as const, updatedInput: i }),
      call: async (i: unknown) => ({ data: i }),
      mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const r = await hasPermissionsToUseTool(tool, { file_path: '/repo/a.ts' }, ctx(), NO_RULES, {
      mode: 'acceptEdits',
    });
    expect(r.behavior).toBe('allow');
    expect((r.decisionReason as { mode?: string }).mode).toBe('acceptEdits');
  });

  test('non-edit tool (bash) → still ask (default gate, no auto-allow)', async () => {
    const tool = fakeTool('Bash', async () => ({ behavior: 'passthrough' }));
    const r = await hasPermissionsToUseTool(tool, { command: 'ls' }, ctx(), NO_RULES, {
      mode: 'acceptEdits',
    });
    expect(r.behavior).toBe('ask');
  });

  test('protected path write → still ask (safetyCheck precedes acceptEdits)', async () => {
    const tool = editTool('write_file');
    const r = await hasPermissionsToUseTool(tool, { file_path: '/repo/.git/config' }, ctx(), NO_RULES, {
      mode: 'acceptEdits',
      enableSafetyCheck: true,
    });
    expect(r.behavior).toBe('ask');
    expect(r.decisionReason?.type).toBe('safetyCheck');
  });
});

describe('plan mode', () => {
  test('read-only tool → allow (normal gate)', async () => {
    const tool = readOnlyTool('read_file');
    const r = await hasPermissionsToUseTool(tool, { file_path: '/repo/a.ts' }, ctx(), NO_RULES, { mode: 'plan' });
    expect(r.behavior).toBe('allow');
  });

  test('non-read-only tool → deny with decisionReason.mode==="plan"', async () => {
    const tool = editTool('write_file');
    const r = await hasPermissionsToUseTool(tool, { file_path: '/repo/a.ts' }, ctx(), NO_RULES, { mode: 'plan' });
    expect(r.behavior).toBe('deny');
    expect(r.decisionReason?.type).toBe('mode');
    expect((r.decisionReason as { mode?: string }).mode).toBe('plan');
  });

  test('ExitPlanMode tool → allow even though plan mode (exempt)', async () => {
    // even if it were declared non-read-only, name exemption allows it.
    const tool = fakeTool('ExitPlanMode', async (i) => ({ behavior: 'allow', updatedInput: i }));
    const r = await hasPermissionsToUseTool(tool, { plan: 'do x' }, ctx(), NO_RULES, { mode: 'plan' });
    expect(r.behavior).toBe('allow');
  });
});

describe('plan fail-closed', () => {
  test('tool whose isReadOnly throws → deny (fail-closed)', async () => {
    const tool = buildTool({
      name: 'flaky',
      isReadOnly: () => {
        throw new Error('boom');
      },
      checkPermissions: async (i: unknown) => ({ behavior: 'allow' as const, updatedInput: i }),
      call: async (i: unknown) => ({ data: i }),
      mapResult: (_o, id) => ({ type: 'tool.result', payload: { id }, ts: 0 }),
      maxResultSizeChars: 1000,
    });
    const r = await hasPermissionsToUseTool(tool, {}, ctx(), NO_RULES, { mode: 'plan' });
    expect(r.behavior).toBe('deny');
    expect((r.decisionReason as { mode?: string }).mode).toBe('plan');
  });
});

describe('plan precedence', () => {
  test('explicit deny rule still wins under plan (deny step ① precedes plan ②.5)', async () => {
    const tool = readOnlyTool('read_file');
    const rules: PermissionRuleSet = { deny: [{ toolName: 'read_file', behavior: 'deny' }], ask: [], allow: [] };
    const r = await hasPermissionsToUseTool(tool, { file_path: '/x' }, ctx(), rules, { mode: 'plan' });
    expect(r.behavior).toBe('deny');
    expect(r.decisionReason?.type).toBe('rule');
  });
});

describe('bypass safety', () => {
  test('.git write under bypass still ask', async () => {
    const tool = editTool('write_file');
    const r = await hasPermissionsToUseTool(tool, { file_path: '/repo/.git/config' }, ctx(), NO_RULES, {
      mode: 'bypassPermissions',
      enableSafetyCheck: true,
    });
    expect(r.behavior).toBe('ask');
    expect(r.decisionReason?.type).toBe('safetyCheck');
  });
});

describe('checkRuleBasedPermissions — subset ①②⑤ + ③deny, no allow/bypass', () => {
  test('deny rule → deny', async () => {
    const tool = fakeTool('Bash');
    const rules: PermissionRuleSet = { deny: [{ toolName: 'Bash', behavior: 'deny' }], ask: [], allow: [] };
    const r = await checkRuleBasedPermissions(tool, { command: 'ls' }, ctx(), rules);
    expect(r?.behavior).toBe('deny');
  });

  test('ask rule → ask', async () => {
    const tool = fakeTool('Bash');
    const rules: PermissionRuleSet = { deny: [], ask: [{ toolName: 'Bash', behavior: 'ask' }], allow: [] };
    const r = await checkRuleBasedPermissions(tool, { command: 'ls' }, ctx(), rules);
    expect(r?.behavior).toBe('ask');
  });

  test('safetyCheck path → ask', async () => {
    const tool = fakeTool('Write', async (input) => ({ behavior: 'allow', updatedInput: input }));
    const r = await checkRuleBasedPermissions(tool, { file_path: '/repo/.git/HEAD' }, ctx(), NO_RULES, true);
    expect(r?.behavior).toBe('ask');
    expect(r?.decisionReason?.type).toBe('safetyCheck');
  });

  test('always-allow rule does NOT short-circuit here (returns null, not allow)', async () => {
    // A tool with allow checkPermissions + an allow rule: rule subset must NOT
    // produce an allow — it only objects (deny/ask) or returns null.
    const tool = fakeTool('Bash', async (input) => ({ behavior: 'allow', updatedInput: input }));
    const rules: PermissionRuleSet = { deny: [], ask: [], allow: [{ toolName: 'Bash', behavior: 'allow' }] };
    const r = await checkRuleBasedPermissions(tool, { command: 'ls' }, ctx(), rules);
    expect(r).toBeNull();
  });

  test('bypass mode is NOT considered (no allow even if would-bypass)', async () => {
    const tool = fakeTool('Bash', async (input) => ({ behavior: 'allow', updatedInput: input }));
    // checkRuleBasedPermissions takes no mode param — only objects or null.
    const r = await checkRuleBasedPermissions(tool, { command: 'ls' }, ctx(), NO_RULES);
    expect(r).toBeNull();
  });

  test('tool checkPermissions deny is surfaced', async () => {
    const tool = fakeTool('Bash', async () => ({ behavior: 'deny', message: 'nope' }));
    const r = await checkRuleBasedPermissions(tool, { command: 'x' }, ctx(), NO_RULES);
    expect(r?.behavior).toBe('deny');
  });

  test('checkPermissions throws → swallowed (returns null, full gate fail-closes)', async () => {
    const tool = fakeTool('Bash', async () => {
      throw new Error('boom');
    });
    const r = await checkRuleBasedPermissions(tool, { command: 'x' }, ctx(), NO_RULES);
    expect(r).toBeNull();
  });
});
